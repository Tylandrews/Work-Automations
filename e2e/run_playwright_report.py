"""
Discover TC*.py Playwright tests, run them with the current Python interpreter, and write
playwright-e2e-report.html using the Call Log E2E report HTML template.

Usage (from repo root, with app served on 4173):
  py -3.10 e2e/run_playwright_report.py

Options:
  --output PATH     HTML output (default: e2e/playwright-e2e-report.html)
  --template PATH   Report HTML template (default: e2e/e2e-report-template.html)
  --skip-url-check  Do not probe CALLLOG_TEST_BASE_URL before running
  --timeout SEC     Per-test subprocess timeout (default: 420)
  --headed          Run Chromium with visible windows (ignored if --live-dashboard)
  --live-dashboard  Serve live-updating report page while tests run (headless Chromium)
  --live-port N     Dashboard bind port (default 9765)
  --no-open-live    Do not open browser for live dashboard
  --workers N       Run up to N tests in parallel (default 1). Use 0 for auto (cap 8, min 1).
  --json-summary P  Write Shields-compatible stats JSON (and meta for Pages) to PATH
"""
from __future__ import annotations

import argparse
import html
import json
import os
import re
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
import urllib.error
import urllib.request
import webbrowser
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from e2e_env_loader import load_e2e_dotenv
from e2e_live_server import try_start_live_dashboard


@dataclass
class TestResult:
    tc_id: str
    file_name: str
    title: str
    category: str
    passed: bool
    duration_sec: float
    exit_code: int
    stdout: str
    stderr: str


@dataclass
class LiveRow:
    tc_id: str
    file_name: str
    title: str
    category: str
    phase: str = "pending"
    passed: bool | None = None
    duration_sec: float = 0.0
    exit_code: int | None = None
    stdout: str = ""
    stderr: str = ""


@dataclass
class LiveRunState:
    rows: list[LiveRow] = field(default_factory=list)
    base_url: str = ""
    run_done: bool = False
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def mark_running(self, index: int) -> None:
        with self._lock:
            self.rows[index].phase = "running"

    def mark_done(
        self,
        index: int,
        passed: bool,
        duration_sec: float,
        exit_code: int,
        stdout: str,
        stderr: str,
    ) -> None:
        with self._lock:
            r = self.rows[index]
            r.phase = "done"
            r.passed = passed
            r.duration_sec = duration_sec
            r.exit_code = exit_code
            r.stdout = stdout
            r.stderr = stderr

    def finish(self) -> None:
        with self._lock:
            self.run_done = True

    def snapshot(self) -> dict:
        with self._lock:
            passed_n = sum(1 for r in self.rows if r.phase == "done" and r.passed is True)
            failed_n = sum(1 for r in self.rows if r.phase == "done" and r.passed is False)
            total = len(self.rows)
            failed_ids = [r.tc_id for r in self.rows if r.phase == "done" and r.passed is False]
            risks = (
                ", ".join(failed_ids)
                if failed_ids
                else ("None — all listed tests passed." if self.run_done else "…")
            )
            running_ids = [r.tc_id for r in self.rows if r.phase == "running"]
            current = running_ids[0] if running_ids else None
            tests_out = []
            for r in self.rows:
                tests_out.append(
                    {
                        "tc_id": r.tc_id,
                        "file_name": r.file_name,
                        "title": r.title,
                        "category": r.category,
                        "phase": r.phase,
                        "passed": r.passed,
                        "duration_sec": r.duration_sec,
                        "exit_code": r.exit_code,
                        "log": (r.stdout + "\n" + r.stderr).strip(),
                    }
                )
            return {
                "run_done": self.run_done,
                "base_url": self.base_url,
                "passed": passed_n,
                "failed": failed_n,
                "total": total,
                "risks": risks,
                "current_tc_id": current,
                "current_tc_ids": running_ids,
                "tests": tests_out,
            }


def github_actions_run_url() -> str | None:
    server = (os.environ.get("GITHUB_SERVER_URL") or "").strip().rstrip("/")
    repo = (os.environ.get("GITHUB_REPOSITORY") or "").strip()
    run_id = (os.environ.get("GITHUB_RUN_ID") or "").strip()
    if server and repo and run_id:
        return f"{server}/{repo}/actions/runs/{run_id}"
    return None


def write_e2e_stats_json(
    out_path: Path,
    results: list[TestResult],
    *,
    source: str = "ci",
) -> None:
    """Write JSON for Shields endpoint badge and Website/e2e-stats.json consumers."""
    total = len(results)
    passed_n = sum(1 for r in results if r.passed)
    failed_n = total - passed_n
    color = "brightgreen" if failed_n == 0 else "red"
    message = f"{passed_n}/{total} passing"
    sha = (os.environ.get("GITHUB_SHA") or "").strip()
    short_sha = sha[:7] if len(sha) >= 7 else (sha or None)
    payload: dict[str, Any] = {
        "schemaVersion": 1,
        "label": "E2E",
        "message": message,
        "color": color,
        "total": total,
        "passed": passed_n,
        "failed": failed_n,
        "lastRunAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "commitSha": short_sha,
        "commitShaFull": sha or None,
        "runUrl": github_actions_run_url(),
        "source": source,
    }
    out_path = out_path.expanduser()
    if not out_path.is_absolute():
        out_path = (repo_root() / out_path).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def tests_dir() -> Path:
    return Path(__file__).resolve().parent


def discover_tests() -> list[Path]:
    root = tests_dir()
    # Windows glob("TC*.py") can match tc_browser.py; only run TC###_*.py (strict prefix)
    files = [p for p in root.glob("*.py") if re.match(r"^TC\d+_", p.name)]
    files.sort(
        key=lambda p: (
            int(m.group(1)) if (m := re.match(r"^TC(\d+)_", p.name)) else 9999,
            p.name,
        )
    )
    return files


def load_plan_titles() -> dict[str, tuple[str, str]]:
    """Optional titles/categories from e2e_scenarios.json for report UI."""
    plan_path = tests_dir() / "e2e_scenarios.json"
    out: dict[str, tuple[str, str]] = {}
    if not plan_path.is_file():
        return out
    try:
        data = json.loads(plan_path.read_text(encoding="utf-8"))
        for item in data:
            tid = item.get("id", "")
            if tid:
                out[tid] = (item.get("title", tid), item.get("category", ""))
    except (json.JSONDecodeError, OSError):
        pass
    return out


def tc_id_from_name(name: str) -> str:
    m = re.match(r"(TC\d+)_", name)
    return m.group(1) if m else name


def check_base_url(url: str, timeout: float = 5.0) -> None:
    probe = url.rstrip("/") + "/"
    try:
        urllib.request.urlopen(probe, timeout=timeout)
    except urllib.error.URLError as e:
        print(
            f"WARNING: {url} is not reachable ({e}). "
            f"Start the app (e.g. npx serve . -p 4173) or set CALLLOG_TEST_BASE_URL.",
            file=sys.stderr,
        )


def run_one(
    py_exe: Path,
    script: Path,
    cwd: Path,
    timeout: int,
    child_env: dict[str, str] | None = None,
) -> tuple[int, str, str, float]:
    t0 = time.perf_counter()
    run_env = {**os.environ, **(child_env or {})}
    try:
        proc = subprocess.run(
            [str(py_exe), str(script)],
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=timeout,
            encoding="utf-8",
            errors="replace",
            env=run_env,
        )
        dt = time.perf_counter() - t0
        return proc.returncode, proc.stdout or "", proc.stderr or "", dt
    except subprocess.TimeoutExpired:
        dt = time.perf_counter() - t0
        return -1, "", f"Subprocess timeout after {timeout}s", dt


def compute_parallel_workers(requested: int, num_scripts: int) -> int:
    """Map CLI --workers to a safe pool size (1..num_scripts). requested==0 means auto."""
    if num_scripts <= 0:
        return 1
    if requested == 0:
        cpu_n = os.cpu_count() or 4
        auto_cap = max(1, min(8, cpu_n))
        return min(num_scripts, auto_cap)
    return min(max(1, requested), num_scripts)


def build_table_row(total: int, passed: int, failed: int) -> str:
    return f"""
            <div class="table-row">
              <div class="table-cell"><span class="text-body">Call Log E2E (Playwright)</span></div>
              <div class="table-cell"><span class="text-body">{total}</span></div>
              <div class="table-cell"><span class="text-body">{passed}</span></div>
              <div class="table-cell"><span class="text-body">{failed}</span></div>
            </div>"""


def build_accordion_item(r: TestResult) -> str:
    status_class = "status-success" if r.passed else "status-error"
    status_label = "Passed" if r.passed else "Failed"
    log = (r.stdout + "\n" + r.stderr).strip() or "(no output)"
    log_esc = html.escape(log)
    desc_esc = html.escape(r.category or r.file_name)
    title_esc = html.escape(f"{r.tc_id}: {r.title}")
    return f"""
          <div class="accordion-item">
            <div class="accordion-header" onclick="toggleAccordion(this)">
              <div class="requirement-content">
                <div class="requirement-title-row">
                  <span class="requirement-status-tag {status_class}">
                    <span class="text-body">{status_label}</span>
                  </span>
                  <h3 class="text-body" style="margin:0;font-size:16px;font-weight:600;">{title_esc}</h3>
                </div>
                <p class="requirement-description text-body">{desc_esc}</p>
              </div>
              <svg class="accordion-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
            </div>
            <div class="accordion-content">
              <div class="test-wrapper">
                <div class="test-card">
                  <div class="test-header"><span class="text-body-medium">{html.escape(r.file_name)}</span></div>
                  <div class="test-content">
                    <div class="test-field">
                      <div class="test-field-label text-body-medium">Duration</div>
                      <div class="test-field-value text-body">{r.duration_sec:.2f}s</div>
                    </div>
                    <div class="test-field">
                      <div class="test-field-label text-body-medium">Exit code</div>
                      <div class="test-field-value text-body">{r.exit_code}</div>
                    </div>
                    <div class="test-field">
                      <div class="test-field-label text-body-medium">Log</div>
                      <div class="test-field-value text-body"><pre style="white-space:pre-wrap;max-height:320px;overflow:auto;font-size:12px;margin:0;">{log_esc}</pre></div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>"""


def apply_template_branding(template: str, *, live_banner: bool = False) -> str:
    """Shared title/metadata/reference replacements (before coverage table or live widgets)."""
    html_out = template
    sub = (
        "<p class=\"title-subtitle\">Generated by <code>run_playwright_report.py</code> — Playwright (CALLLOG_TEST_BROWSER, default chromium) and Python async tests against the served app. <strong id=\"live-status-banner\"></strong></p>"
        if live_banner
        else "<p class=\"title-subtitle\">Generated by <code>run_playwright_report.py</code> — Playwright (CALLLOG_TEST_BROWSER, default chromium) and Python async tests against the served app.</p>"
    )
    html_out = html_out.replace("<p class=\"title-subtitle\">__E2E_SUBTITLE__</p>", sub)
    html_out = re.sub(
        r'(<div class="metadata-label text-body-medium">Project Name</div>\s*<div class="metadata-value text-body">)N/A(</div>)',
        r"\1Call Log (Work Automations)\2",
        html_out,
        count=1,
    )
    today = datetime.now().strftime("%d/%m/%Y")
    html_out = re.sub(
        r'(<div class="metadata-label text-body-medium">Date</div>\s*<div class="metadata-value text-body">)[^<]*(</div>)',
        rf"\g<1>{today}\g<2>",
        html_out,
        count=1,
    )
    html_out = re.sub(
        r'(<div class="metadata-label text-body-medium">Prepared by</div>\s*<div class="metadata-value text-body">)[^<]*(</div>)',
        r"\1Local Playwright runner\2",
        html_out,
        count=1,
    )
    return html_out


LIVE_CLIENT_SNIPPET = r"""
<style>
@keyframes liveDashPulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
.live-dash-running { animation: liveDashPulse 1.1s ease-in-out infinite; }
.live-status-pending .text-body { color: var(--fg-secondary); }
</style>
<script>
(function () {
  function esc(s) {
    if (s == null) return ''
    var d = document.createElement('div')
    d.textContent = String(s)
    return d.innerHTML
  }
  function tableRow(total, passed, failed) {
    return (
      '<div class="table-row">' +
      '<div class="table-cell"><span class="text-body">Call Log E2E (Playwright)</span></div>' +
      '<div class="table-cell"><span class="text-body">' + total + '</span></div>' +
      '<div class="table-cell"><span class="text-body">' + passed + '</span></div>' +
      '<div class="table-cell"><span class="text-body">' + failed + '</span></div>' +
      '</div>'
    )
  }
  function accordionItem(t) {
    var phase = t.phase || 'pending'
    var statusClass = 'live-status-pending'
    var statusLabel = 'Pending'
    if (phase === 'running') {
      statusClass = 'status-warning live-dash-running'
      statusLabel = 'Running'
    } else if (phase === 'done') {
      if (t.passed) {
        statusClass = 'status-success'
        statusLabel = 'Passed'
      } else {
        statusClass = 'status-error'
        statusLabel = 'Failed'
      }
    }
    var log = (t.log || '').trim() || '(no output yet)'
    var dur = typeof t.duration_sec === 'number' ? t.duration_sec.toFixed(2) : '—'
    var code = t.exit_code != null ? String(t.exit_code) : '—'
    return (
      '<div class="accordion-item">' +
      '<div class="accordion-header" onclick="toggleAccordion(this)" role="button" tabindex="0" ' +
      'onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();toggleAccordion(this);}">' +
      '<div class="requirement-content">' +
      '<div class="requirement-title-row">' +
      '<span class="requirement-status-tag ' + statusClass + '">' +
      '<span class="text-body">' + esc(statusLabel) + '</span></span>' +
      '<h3 class="text-body" style="margin:0;font-size:16px;font-weight:600;">' +
      esc(t.tc_id + ': ' + (t.title || '')) + '</h3></div>' +
      '<p class="requirement-description text-body">' + esc(t.category || t.file_name || '') + '</p>' +
      '</div>' +
      '<svg class="accordion-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>' +
      '</div>' +
      '<div class="accordion-content">' +
      '<div class="test-wrapper"><div class="test-card">' +
      '<div class="test-header"><span class="text-body-medium">' + esc(t.file_name || '') + '</span></div>' +
      '<div class="test-content">' +
      '<div class="test-field"><div class="test-field-label text-body-medium">Duration</div>' +
      '<div class="test-field-value text-body">' + esc(dur) + 's</div></div>' +
      '<div class="test-field"><div class="test-field-label text-body-medium">Exit code</div>' +
      '<div class="test-field-value text-body">' + esc(code) + '</div></div>' +
      '<div class="test-field"><div class="test-field-label text-body-medium">Log</div>' +
      '<div class="test-field-value text-body"><pre style="white-space:pre-wrap;max-height:320px;overflow:auto;font-size:12px;margin:0;">' +
      esc(log) + '</pre></div></div>' +
      '</div></div></div></div></div>'
    )
  }
  function paint(data) {
    var elP = document.getElementById('live-passed')
    var elT = document.getElementById('live-total')
    var elR = document.getElementById('live-risks')
    var elBanner = document.getElementById('live-status-banner')
    var elTable = document.getElementById('live-table-rows')
    var elAcc = document.getElementById('live-accordion')
    if (!elP || !elT || !elR || !elTable || !elAcc) return
    elP.textContent = String(data.passed)
    elT.textContent = String(data.total)
    elR.textContent = data.risks
    if (elBanner) {
      if (data.run_done) {
        elBanner.textContent = data.failed > 0 ? ' Run finished with failures.' : ' Run finished.'
      } else {
        var ids = data.current_tc_ids || []
        if (ids.length === 0 && data.current_tc_id) ids = [data.current_tc_id]
        if (ids.length === 1) {
          elBanner.textContent = ' Running ' + ids[0] + '…'
        } else if (ids.length > 1) {
          var head = ids.slice(0, 2).join(', ')
          var more = ids.length - 2
          elBanner.textContent =
            ' Running ' + head + (more > 0 ? ' (+' + more + ' more)…' : '…')
        } else {
          elBanner.textContent = ' Starting…'
        }
      }
    }
    elTable.innerHTML = tableRow(data.total, data.passed, data.failed)
    elAcc.innerHTML = (data.tests || []).map(accordionItem).join('')
    var first = elAcc.querySelector('.accordion-item')
    if (first && data.run_done) first.classList.add('active')
    else if (first && data.current_tc_id) {
      var items = elAcc.querySelectorAll('.accordion-item')
      for (var i = 0; i < items.length; i++) {
        if (data.tests[i] && data.tests[i].phase === 'running') {
          items[i].classList.add('active')
          break
        }
      }
    }
  }
  function tick() {
    fetch('/api/live-state', { cache: 'no-store' })
      .then(function (r) { return r.json() })
      .then(paint)
      .catch(function () {})
  }
  document.addEventListener('DOMContentLoaded', function () {
    tick()
    setInterval(tick, 450)
  })
})()
</script>
"""


def build_live_dashboard_page(template: str, base_url: str, planned_total: int) -> str:
    html_out = apply_template_branding(template, live_banner=True)
    html_out = re.sub(
        r'<li><span class="coverage-highlight">0/0</span> of tests passed</li>',
        f'<li><span class="coverage-highlight"><span id="live-passed">0</span>/<span id="live-total">{planned_total}</span></span> of tests passed</li>',
        html_out,
        count=1,
    )
    html_out = re.sub(
        r'(<li><span class="coverage-highlight">Key gaps / risks:</span>\s*)\s*N/A\s*(\s*</li>)',
        r'\1 <span id="live-risks" class="text-body">…</span>\2',
        html_out,
        count=1,
        flags=re.DOTALL,
    )
    html_out = re.sub(
        r'<div class="table-rows">\s*</div>',
        '<div class="table-rows" id="live-table-rows"></div>',
        html_out,
        count=1,
        flags=re.DOTALL,
    )
    html_out = re.sub(
        r'<div class="accordion-container">\s*</div>',
        '<div class="accordion-container" id="live-accordion"></div>',
        html_out,
        count=1,
        flags=re.DOTALL,
    )
    html_out = html_out.replace(
        "__CALL_LOG_REPORT_FOOTER__",
        f"Base URL: {html.escape(base_url)} · Live dashboard · Call Log",
    )
    html_out = html_out.replace("</body>", LIVE_CLIENT_SNIPPET + "\n  </body>")
    return html_out


def inject_report(
    template: str,
    results: list[TestResult],
    base_url: str,
) -> str:
    total = len(results)
    passed_n = sum(1 for r in results if r.passed)
    failed_n = total - passed_n
    failed_ids = [r.tc_id for r in results if not r.passed]
    risks = (
        ", ".join(failed_ids)
        if failed_ids
        else "None — all listed tests passed."
    )

    html_out = apply_template_branding(template, live_banner=False)
    html_out = re.sub(
        r'<li><span class="coverage-highlight">0/0</span> of tests passed</li>',
        f'<li><span class="coverage-highlight">{passed_n}/{total}</span> of tests passed</li>',
        html_out,
        count=1,
    )
    html_out = re.sub(
        r'(<li><span class="coverage-highlight">Key gaps / risks:</span>\s*)\s*N/A\s*(\s*</li>)',
        rf"\1\n              {html.escape(risks)}\2",
        html_out,
        count=1,
        flags=re.DOTALL,
    )

    table_inner = build_table_row(total, passed_n, failed_n)
    # Use a callable so backslashes in injected HTML (e.g. Windows paths in logs) are not parsed as re escapes
    html_out = re.sub(
        r'<div class="table-rows">\s*</div>',
        lambda _m: f"<div class=\"table-rows\">{table_inner}\n          </div>",
        html_out,
        count=1,
        flags=re.DOTALL,
    )

    accordion_inner = "\n".join(build_accordion_item(r) for r in results)
    html_out = re.sub(
        r'<div class="accordion-container">\s*</div>',
        lambda _m: f"<div class=\"accordion-container\">\n{accordion_inner}\n        </div>",
        html_out,
        count=1,
        flags=re.DOTALL,
    )

    html_out = html_out.replace(
        "__CALL_LOG_REPORT_FOOTER__",
        f"Base URL: {html.escape(base_url)} · Call Log · Playwright E2E report",
    )

    return html_out


def build_live_rows_from_scripts(
    scripts: list[Path],
    plan: dict[str, tuple[str, str]],
) -> list[LiveRow]:
    rows: list[LiveRow] = []
    for script in scripts:
        tid = tc_id_from_name(script.name)
        title, category = plan.get(tid, (script.stem.replace("_", " "), ""))
        rows.append(LiveRow(tc_id=tid, file_name=script.name, title=title, category=category))
    return rows


def main() -> int:
    parser = argparse.ArgumentParser(description="Run TC*.py tests and generate HTML report")
    parser.add_argument(
        "--output",
        type=Path,
        default=tests_dir() / "playwright-e2e-report.html",
        help="Output HTML path",
    )
    parser.add_argument(
        "--template",
        type=Path,
        default=tests_dir() / "e2e-report-template.html",
        help="Report HTML template path",
    )
    parser.add_argument("--skip-url-check", action="store_true")
    parser.add_argument("--timeout", type=int, default=420, help="Per-test timeout (seconds)")
    parser.add_argument(
        "--limit",
        type=int,
        default=0,
        help="Run only the first N tests (0 = all). Useful for smoke checks.",
    )
    parser.add_argument(
        "--headed",
        action="store_true",
        help="Run Chromium with visible windows (sets CALLLOG_TEST_HEADLESS=0 for each test). Ignored with --live-dashboard.",
    )
    parser.add_argument(
        "--live-dashboard",
        action="store_true",
        help="Serve the report at http://127.0.0.1:<port>/ and update it live while tests run (Playwright stays headless).",
    )
    parser.add_argument(
        "--live-port",
        type=int,
        default=9765,
        help="First port to try for the live dashboard (default 9765).",
    )
    parser.add_argument(
        "--live-host",
        type=str,
        default="127.0.0.1",
        help="Bind address for the live dashboard (default 127.0.0.1).",
    )
    parser.add_argument(
        "--no-open-live",
        action="store_true",
        help="With --live-dashboard, print the URL but do not open a browser tab.",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=1,
        help="Run up to N TC*.py subprocesses in parallel (default 1). "
        "Use 0 for auto: min(test count, max(1, min(8, CPU count))). "
        "Many workers against one Supabase user may cause flaky tests.",
    )
    parser.add_argument(
        "--json-summary",
        type=Path,
        default=None,
        metavar="PATH",
        help="Write Shields-compatible E2E summary JSON (plus total/passed/failed, run URL) for README/Pages.",
    )
    # Drop standalone `--` (shell/npm forwarding); argparse does not treat it as special here.
    argv_tail = [token for token in sys.argv[1:] if token != "--"]
    args = parser.parse_args(argv_tail)

    load_e2e_dotenv()

    base_url = os.environ.get("CALLLOG_TEST_BASE_URL", "http://localhost:4173")

    if not args.skip_url_check:
        check_base_url(base_url.rstrip("/") + "/" if not base_url.endswith("/") else base_url)

    template_path = args.template
    if not template_path.is_file():
        print(f"Template not found: {template_path}", file=sys.stderr)
        return 2

    template_text = template_path.read_text(encoding="utf-8")
    plan = load_plan_titles()
    py_exe = Path(sys.executable)
    cwd = repo_root()
    scripts = discover_tests()
    if not scripts:
        print("No TC*.py files found.", file=sys.stderr)
        return 2
    if args.limit and args.limit > 0:
        scripts = scripts[: args.limit]

    if args.workers < 0:
        print("--workers must be >= 0 (use 0 for auto)", file=sys.stderr)
        return 2

    n_workers = compute_parallel_workers(args.workers, len(scripts))

    if not (os.environ.get("CALLLOG_TEST_EMAIL") or "").strip() or not (
        os.environ.get("CALLLOG_TEST_PASSWORD") or ""
    ).strip():
        print(
            "WARNING: CALLLOG_TEST_EMAIL and/or CALLLOG_TEST_PASSWORD are unset. "
            "Most TCs sign in with a real Supabase user: copy e2e/.env.example to e2e/.env "
            "and set matching credentials. Without them you will see 'Invalid login credentials' "
            "or hidden #appShell in many tests.",
            file=sys.stderr,
        )

    if args.live_dashboard and args.headed:
        print(
            "Note: --live-dashboard keeps Playwright headless; ignoring --headed.",
            file=sys.stderr,
        )

    child_env: dict[str, str] = {}
    if args.headed and not args.live_dashboard:
        child_env["CALLLOG_TEST_HEADLESS"] = "0"
    mode = (
        "live dashboard (Playwright headless)"
        if args.live_dashboard
        else ("headed (visible browser)" if args.headed else "headless")
    )
    worker_note = f", workers={n_workers}" if n_workers > 1 else ""
    print(
        f"Running {len(scripts)} tests with {py_exe} (cwd={cwd}, {mode}{worker_note}) ...\n"
    )

    live_state: LiveRunState | None = None
    httpd: Any = None
    if args.live_dashboard:
        live_state = LiveRunState(
            rows=build_live_rows_from_scripts(scripts, plan),
            base_url=base_url,
        )
        page_html = build_live_dashboard_page(template_text, base_url, len(scripts))
        try:
            httpd, _live_thread, bound_port = try_start_live_dashboard(
                page_html,
                live_state.snapshot,
                args.live_host,
                args.live_port,
            )
        except RuntimeError as e:
            print(str(e), file=sys.stderr)
            return 2
        live_url = f"http://{args.live_host}:{bound_port}/"
        print(f"Live report UI: {live_url}", flush=True)
        if not args.no_open_live:
            webbrowser.open(live_url)
        time.sleep(0.45)

    print_lock = threading.Lock()

    def run_single_indexed(i: int, script: Path) -> tuple[int, TestResult]:
        tid = tc_id_from_name(script.name)
        title, category = plan.get(tid, (script.stem.replace("_", " "), ""))
        if live_state is not None:
            live_state.mark_running(i)
        code, out, err, dt = run_one(py_exe, script, cwd, args.timeout, child_env)
        ok = code == 0
        if live_state is not None:
            live_state.mark_done(i, ok, dt, code, out, err)
        result = TestResult(
            tc_id=tid,
            file_name=script.name,
            title=title,
            category=category,
            passed=ok,
            duration_sec=dt,
            exit_code=code,
            stdout=out,
            stderr=err,
        )
        with print_lock:
            suffix = "PASS" if ok else f"FAIL (exit {code})"
            print(f"  {tid} {script.name} ... {suffix}", flush=True)
        return i, result

    results_by_index: dict[int, TestResult] = {}
    if n_workers <= 1:
        for i, script in enumerate(scripts):
            idx, tr = run_single_indexed(i, script)
            results_by_index[idx] = tr
    else:
        with ThreadPoolExecutor(max_workers=n_workers) as executor:
            futures = [
                executor.submit(run_single_indexed, i, script)
                for i, script in enumerate(scripts)
            ]
            for fut in as_completed(futures):
                idx, tr = fut.result()
                results_by_index[idx] = tr
    results = [results_by_index[i] for i in range(len(scripts))]

    if live_state is not None:
        live_state.finish()
        time.sleep(0.55)

    if httpd is not None:
        try:
            httpd.shutdown()
        except OSError:
            pass

    html_body = inject_report(template_text, results, base_url)
    out_path = args.output
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(html_body, encoding="utf-8")
    print(f"\nWrote {out_path.resolve()}")

    if args.json_summary is not None:
        write_e2e_stats_json(args.json_summary, results, source="ci")
        js_path = args.json_summary.expanduser()
        if not js_path.is_absolute():
            js_path = (repo_root() / js_path).resolve()
        else:
            js_path = js_path.resolve()
        print(f"Wrote JSON summary: {js_path}")

    passed_n = sum(1 for r in results if r.passed)
    print(f"Summary: {passed_n}/{len(results)} passed")
    return 0 if passed_n == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
