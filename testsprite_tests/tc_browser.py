"""
Shared Chromium launch mode for TC*.py scripts.

- Default: headless (CI / batch).
- Visible browser: set CALLLOG_TEST_HEADLESS=0 (or false / no / off).
"""
from __future__ import annotations

import os


def is_headless_browser() -> bool:
    v = os.environ.get("CALLLOG_TEST_HEADLESS", "1").strip().lower()
    return v not in ("0", "false", "no", "off")
