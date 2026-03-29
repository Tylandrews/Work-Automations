"""
Shared Chromium launch mode for TC*.py scripts.

- Default: headless (CI / batch).
- Visible browser: set CALLLOG_TEST_HEADLESS=0 (or false / no / off).

Loads e2e/.env into os.environ when present (see .env.example).
"""
from __future__ import annotations

import os

from e2e_env_loader import load_e2e_dotenv

load_e2e_dotenv()


def is_headless_browser() -> bool:
    v = os.environ.get("CALLLOG_TEST_HEADLESS", "1").strip().lower()
    return v not in ("0", "false", "no", "off")
