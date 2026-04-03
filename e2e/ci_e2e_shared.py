"""
Single source of truth for the `run_e2e_full.py` argv used by GitHub Actions E2E.

Keeps `.github/workflows/e2e-playwright.yml` and local `run_like_github_ci.py` aligned.
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
    """Same flags as `python e2e/run_github_actions_e2e.py` after secrets + supabaseConfig."""
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
