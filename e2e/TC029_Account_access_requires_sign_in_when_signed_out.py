"""
TC029: Fresh session (no Supabase persistence) — auth gate shows Sign in; Account toolbar control stays hidden until logged in.
"""
import asyncio
import os

from tc_browser import is_headless_browser
from playwright.async_api import async_playwright, expect

BASE_URL = os.environ.get("CALLLOG_TEST_BASE_URL", "http://localhost:4173")


async def run_test() -> None:
    pw = None
    browser = None
    context = None

    try:
        pw = await async_playwright().start()
        browser = await pw.chromium.launch(
            headless=is_headless_browser(),
            args=["--window-size=1280,720", "--disable-dev-shm-usage"],
        )
        context = await browser.new_context()
        context.set_default_timeout(25000)
        page = await context.new_page()
        await page.goto(BASE_URL, wait_until="domcontentloaded", timeout=30000)

        await expect(page.locator("#authScreen")).to_be_visible()
        await expect(page.locator(".auth-title")).to_have_text("Sign in")
        await expect(page.locator("#profileBtn")).to_be_hidden()

    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()


if __name__ == "__main__":
    asyncio.run(run_test())
