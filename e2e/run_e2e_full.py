"""
One command: optional static server, Playwright E2E, live Call Log dashboard in the browser.

From repo root:
  py -3.10 e2e/run_e2e_full.py
  npm run test:e2e

The default UI is a local live dashboard (Call Log E2E report layout) that updates
as each test finishes. Playwright runs headless.

Static HTML + visible Chromium per test instead:
  py -3.10 e2e/run_e2e_full.py --static-report

CI (no browser tabs, headless, JSON for GitHub Pages):
  py -3.10 e2e/run_e2e_full.py --no-open-report --static-report --headless -- \\
    --json-summary Website/e2e-stats.json

CI (no browser tabs, default live dashboard):
  py -3.10 e2e/run_e2e_full.py --no-open-report

Extra args are forwarded to run_playwright_report.py (place after -- if using npm):
  npm run test:e2e -- --limit 3

Run several TC*.py subprocesses in parallel (faster wall time; same Supabase user may flake if N is high):
  py -3.10 e2e/run_e2e_full.py -- --workers 6
  npm run test:e2e -- --workers 0

--workers 0 picks an automatic cap (min 1, max 8, bounded by CPU and test count).

Sign-in tests need CALLLOG_TEST_EMAIL and CALLLOG_TEST_PASSWORD. Set them in the shell
or copy e2e/.env.example to e2e/.env (gitignored).
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path

from e2e_env_loader import load_e2e_dotenv


def repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def tests_dir() -> Path:
    return Path(__file__).resolve().parent


def probe_url_ok(url: str, timeout: float = 2.0) -> bool:
    probe = url if url.endswith("/") else url + "/"
    try:
        urllib.request.urlopen(probe, timeout=timeout)
        return True
    except (urllib.error.URLError, OSError):
        return False


def wait_for_http(url: str, total_timeout: float = 90.0) -> bool:
    deadline = time.monotonic() + total_timeout
    probe = url if url.endswith("/") else url + "/"
    while time.monotonic() < deadline:
        if probe_url_ok(probe, timeout=3.0):
            return True
        time.sleep(0.5)
    return False


def report_output_path(report_args: list[str], default: Path) -> Path:
    if "--output" not in report_args:
        return default
    i = report_args.index("--output")
    if i + 1 >= len(report_args):
        return default
    p = Path(report_args[i + 1])
    return p if p.is_absolute() else (repo_root() / p).resolve()


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Serve app if needed, run E2E tests, live dashboard (default) or static report."
    )
    parser.add_argument(
        "--port",
        type=int,
        default=4173,
        help="Port for npx serve when auto-serving (default 4173)",
    )
    parser.add_argument(
        "--no-serve",
        action="store_true",
        help="Do not start npx serve; you must already serve CALLLOG_TEST_BASE_URL",
    )
    parser.add_argument(
        "--headless",
        action="store_true",
        help="With --static-report only: run Chromium headless",
    )
    parser.add_argument(
        "--static-report",
        action="store_true",
        help="Skip live dashboard; use headed Playwright (unless --headless) and open static HTML when done",
    )
    parser.add_argument(
        "--live-port",
        type=int,
        default=9765,
        help="First port for the live dashboard server (default 9765)",
    )
    parser.add_argument(
        "--no-open-report",
        action="store_true",
        help="Do not open any browser tab (for live mode: pass --no-open-live to the runner)",
    )
    args, report_args = parser.parse_known_args()
    # Shell / npm use `--` before forwarded args; argparse keeps that token in report_args,
    # but run_playwright_report.py does not accept `--` as an argument.
    while report_args and report_args[0] == "--":
        report_args = report_args[1:]

    load_e2e_dotenv()

    root = repo_root()
    report_script = tests_dir() / "run_playwright_report.py"
    default_report_html = tests_dir() / "playwright-e2e-report.html"

    if not report_script.is_file():
        print(f"Missing {report_script}", file=sys.stderr)
        return 2

    base_url = os.environ.get("CALLLOG_TEST_BASE_URL", f"http://localhost:{args.port}")
    run_env = os.environ.copy()

    if not args.no_serve:
        if not shutil.which("npx"):
            print(
                "npx not found in PATH. Install Node.js or use --no-serve with your own server.",
                file=sys.stderr,
            )
            return 2
        run_env["CALLLOG_TEST_BASE_URL"] = f"http://localhost:{args.port}"
        base_url = run_env["CALLLOG_TEST_BASE_URL"]
        if probe_url_ok(base_url):
            print(f"Using existing server at {base_url}")
        else:
            print(f"Starting static server: npx serve . -p {args.port} (repo root) ...")
            subprocess.Popen(
                ["npx", "--yes", "serve", ".", "-p", str(args.port)],
                cwd=root,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            if not wait_for_http(base_url):
                print(f"Timed out waiting for {base_url}", file=sys.stderr)
                return 2
            print(f"Server ready at {base_url}")
    else:
        if not probe_url_ok(base_url):
            print(
                f"WARNING: {base_url} is not responding. Tests may fail. "
                "Start the app or unset --no-serve.",
                file=sys.stderr,
            )

    cmd: list[str] = [sys.executable, str(report_script), "--skip-url-check"]
    cmd.extend(report_args)
    if not args.static_report:
        cmd.append("--live-dashboard")
        cmd.extend(["--live-port", str(args.live_port)])
        if args.no_open_report:
            cmd.append("--no-open-live")
    else:
        if not args.headless and "--headed" not in report_args:
            cmd.append("--headed")

    print("Running report runner:", " ".join(cmd), "\n")
    rc = subprocess.call(cmd, cwd=root, env=run_env)

    open_report = not args.no_open_report and args.static_report
    if open_report:
        out_html = report_output_path(list(report_args), default_report_html)
        if out_html.is_file():
            uri = out_html.as_uri()
            print(f"\nOpening report: {uri}")
            webbrowser.open(uri)
        else:
            print(f"\nReport not found at {out_html}", file=sys.stderr)

    return rc


if __name__ == "__main__":
    sys.exit(main())
