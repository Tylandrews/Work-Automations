"""
Write Website/e2e-stats.json from TC*.py count only (no Playwright run).

Used in CI when E2E secrets are not configured. Output is Shields-compatible
plus the same extended fields as run_playwright_report.write_e2e_stats_json,
with source \"inventory\" and no pass/fail counts.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path


def repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def tests_dir() -> Path:
    return Path(__file__).resolve().parent


def discover_tc_count() -> int:
    n = 0
    for p in sorted(tests_dir().glob("*.py")):
        if p.is_file() and re.match(r"^TC\d+_", p.name):
            n += 1
    return n


def github_actions_run_url() -> str | None:
    server = (os.environ.get("GITHUB_SERVER_URL") or "").strip().rstrip("/")
    repo = (os.environ.get("GITHUB_REPOSITORY") or "").strip()
    run_id = (os.environ.get("GITHUB_RUN_ID") or "").strip()
    if server and repo and run_id:
        return f"{server}/{repo}/actions/runs/{run_id}"
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description="Write inventory-only e2e-stats.json")
    parser.add_argument(
        "--output",
        type=Path,
        default=repo_root() / "Website" / "e2e-stats.json",
        help="Output JSON path (default: Website/e2e-stats.json)",
    )
    args = parser.parse_args()

    total = discover_tc_count()
    if total == 0:
        print("No TC*.py tests found.", file=sys.stderr)
        return 2

    sha = (os.environ.get("GITHUB_SHA") or "").strip()
    short_sha = sha[:7] if len(sha) >= 7 else (sha or None)
    payload = {
        "schemaVersion": 1,
        "label": "E2E",
        "message": f"{total} scenarios",
        "color": "blue",
        "total": total,
        "passed": None,
        "failed": None,
        "lastRunAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "commitSha": short_sha,
        "commitShaFull": sha or None,
        "runUrl": github_actions_run_url(),
        "source": "inventory",
    }

    out_path = args.output.expanduser()
    if not out_path.is_absolute():
        out_path = (repo_root() / out_path).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {out_path} ({total} scenarios, inventory)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
