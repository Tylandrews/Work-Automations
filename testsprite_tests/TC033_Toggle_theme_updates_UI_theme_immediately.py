"""
TC033: Toggle theme — documentElement data-theme switches between light and dark.
"""
import asyncio
import os

from tc_browser import is_headless_browser
from playwright.async_api import async_playwright, expect

BASE_URL = os.environ.get("CALLLOG_TEST_BASE_URL", "http://localhost:4173")
LOGIN_EMAIL = os.environ.get("CALLLOG_TEST_EMAIL", "andrews.s.tyler@gmail.com")
LOGIN_PASSWORD = os.environ.get("CALLLOG_TEST_PASSWORD", "123456")


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

        auth_screen = page.locator("#authScreen")
        if await auth_screen.is_visible():
            await page.locator("#authBrandCard").click()
            await expect(page.locator("#authFormCard")).to_have_attribute("aria-hidden", "false")
            await page.locator("#authEmail").fill(LOGIN_EMAIL)
            await page.locator("#authPassword").fill(LOGIN_PASSWORD)
            await page.locator("#authSignInBtn").click()
            await expect(page.locator("#appShell")).to_be_visible(timeout=30000)

        before = await page.evaluate("() => document.documentElement.getAttribute('data-theme')")
        await page.locator("#themeToggleBtn").click()
        after = await page.evaluate("() => document.documentElement.getAttribute('data-theme')")
        assert before != after
        assert after in ("light", "dark")

    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()


if __name__ == "__main__":
    asyncio.run(run_test())
