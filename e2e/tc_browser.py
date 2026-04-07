"""
Shared browser launch for TC*.py scripts.

- Browser: CALLLOG_TEST_BROWSER = chromium (default), firefox, or webkit.
- Headless: default on; set CALLLOG_TEST_HEADLESS=0 (or false / no / off) for a visible window.

Loads e2e/.env into os.environ when present (see .env.example).
"""
from __future__ import annotations

import os

from e2e_env_loader import load_e2e_dotenv

load_e2e_dotenv()


def is_headless_browser() -> bool:
    v = os.environ.get("CALLLOG_TEST_HEADLESS", "1").strip().lower()
    return v not in ("0", "false", "no", "off")


def _browser_name() -> str:
    name = (os.environ.get("CALLLOG_TEST_BROWSER") or "chromium").strip().lower()
    if name not in ("chromium", "firefox", "webkit"):
        return "chromium"
    return name


async def launch_test_browser(playwright):
    """Launch Playwright browser from CALLLOG_TEST_BROWSER (default chromium)."""
    name = _browser_name()
    engine = getattr(playwright, name)
    args = ["--window-size=1280,720"]
    if name == "chromium":
        args.append("--disable-dev-shm-usage")
    return await engine.launch(headless=is_headless_browser(), args=args)
