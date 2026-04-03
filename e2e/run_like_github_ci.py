"""
Run E2E with CI-style flags (static HTML report, headless, default `--workers 1`).

Playwright is not executed in GitHub Actions anymore; use this locally for a reproducible,
headless run. Same test discovery as always: `run_playwright_report.py` and `e2e/TC###_*.py`.

Loads `e2e/.env`; does not overwrite `supabaseConfig.js`.

From repo root:
  py -3.10 e2e/run_like_github_ci.py
  npm run test:e2e:ci

Firefox (same as the old Validate matrix):
  npm run test:e2e:ci:firefox
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

from ci_e2e_shared import argv_run_e2e_full_like_github
from e2e_env_loader import load_e2e_dotenv


def main() -> int:
    load_e2e_dotenv()
    root = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(
        description="Run E2E with headless/static-report argv (former CI style).",
    )
    parser.add_argument(
        "--browser",
        default="chromium",
        help="CALLLOG_TEST_BROWSER (default chromium)",
    )
    parser.add_argument(
        "--workers",
        default=None,
        help="Forwarded as --workers to run_playwright_report (default 1, same as CI)",
    )
    parser.add_argument(
        "--json-summary",
        default="Website/e2e-stats.json",
        dest="json_summary",
        help="Same path CI uses by default",
    )
    args = parser.parse_args()
    os.environ["CALLLOG_TEST_BROWSER"] = (args.browser or "chromium").strip().lower()
    if args.workers is not None:
        workers = str(args.workers).strip()
    else:
        workers = (os.environ.get("E2E_PARALLEL_WORKERS") or "1").strip()
    cmd = argv_run_e2e_full_like_github(
        root,
        json_summary=args.json_summary.strip(),
        workers=workers,
    )
    return subprocess.run(cmd, cwd=root, env=os.environ).returncode


if __name__ == "__main__":
    raise SystemExit(main())
