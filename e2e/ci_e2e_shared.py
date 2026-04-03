"""
Headless/static argv for `run_e2e_full.py` (used by `run_like_github_ci.py` / `npm run test:e2e:ci`).

Playwright E2E is not run in GitHub Actions; use this locally to match the old CI-style flags.
"""
from __future__ import annotations

import sys
from pathlib import Path


def argv_run_e2e_full_like_github(
    root: Path,
    *,
    json_summary: str,
    workers: str,
) -> list[str]:
    """Flags: static report, headless, json summary path, worker count (CI-style)."""
    return [
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
