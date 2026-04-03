"""
Run the same E2E suite the same way as GitHub Actions (Validate / Deploy Pages).

- Same `run_e2e_full.py` flags as `run_github_actions_e2e.py` (static report, headless, workers).
- Same test discovery: `run_playwright_report.py` and all `e2e/TC###_*.py` files.
- Does not trim secrets or overwrite `supabaseConfig.js` (use `e2e/.env` and your local config).

From repo root:
  py -3.10 e2e/run_like_github_ci.py
  npm run test:e2e:ci

Match Validate Firefox matrix:
  py -3.10 e2e/run_like_github_ci.py --browser firefox
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
        description="Run E2E with the same CLI as GitHub Actions (reusable e2e-playwright.yml).",
    )
    parser.add_argument(
        "--browser",
        default="chromium",
        help="CALLLOG_TEST_BROWSER (default chromium, same as Deploy GitHub Pages)",
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
