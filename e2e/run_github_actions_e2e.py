"""
GitHub Actions entry: trim E2E secrets, write supabaseConfig.js, run run_e2e_full.py.

Invoked from .github/workflows/e2e-playwright.yml only (cwd = repo root).
"""
from __future__ import annotations

import json
import os
import pathlib
import subprocess
import sys

_SECRET_KEYS = (
    "SUPABASE_URL",
    "SUPABASE_ANON_KEY",
    "CALLLOG_TEST_EMAIL",
    "CALLLOG_TEST_PASSWORD",
)


def main() -> int:
    for k in _SECRET_KEYS:
        raw = os.environ.get(k, "")
        os.environ[k] = raw.strip().replace("\r\n", "\n").strip()

    for k in _SECRET_KEYS:
        if not os.environ[k]:
            print(
                f"::error::Secret {k} is empty after trimming whitespace "
                "(check the value in Settings → Secrets and variables → Actions).",
                file=sys.stderr,
            )
            return 1

    root = pathlib.Path(os.environ.get("GITHUB_WORKSPACE", ".")).resolve()
    cfg = {
        "SUPABASE_URL": os.environ["SUPABASE_URL"],
        "SUPABASE_ANON_KEY": os.environ["SUPABASE_ANON_KEY"],
    }
    (root / "supabaseConfig.js").write_text(
        "window.supabaseConfig = " + json.dumps(cfg, indent=2) + ";\n",
        encoding="utf-8",
    )

    workers = (os.environ.get("E2E_PARALLEL_WORKERS") or "1").strip()
    json_summary = (os.environ.get("E2E_JSON_SUMMARY") or "Website/e2e-stats.json").strip()
    cmd = [
        sys.executable,
        str(root / "e2e" / "run_e2e_full.py"),
        "--no-open-report",
        "--static-report",
        "--headless",
        "--",
        "--json-summary",
        json_summary,
        "--workers",
        workers,
    ]
    return subprocess.run(cmd, cwd=root, env=os.environ).returncode


if __name__ == "__main__":
    raise SystemExit(main())
