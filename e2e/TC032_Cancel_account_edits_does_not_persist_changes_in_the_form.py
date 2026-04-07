"""
TC032: Open Account, type Unsaved Name, leave without saving — reopen account; name is not the unsaved string.
"""
import asyncio
import os

from tc_browser import launch_test_browser
from playwright.async_api import async_playwright, expect

BASE_URL = os.environ.get("CALLLOG_TEST_BASE_URL", "http://localhost:4173")
LOGIN_EMAIL = os.environ.get("CALLLOG_TEST_EMAIL", "")
LOGIN_PASSWORD = os.environ.get("CALLLOG_TEST_PASSWORD", "")


async def run_test() -> None:
    pw = None
    browser = None
    context = None

    try:
        pw = await async_playwright().start()
        browser = await launch_test_browser(pw)
        context = await browser.new_context()
        context.set_default_timeout(25000)
        page = await context.new_page()
        await page.goto(BASE_URL, wait_until="domcontentloaded", timeout=30000)

        auth_screen = page.locator("#authScreen")
        app_shell = page.locator("#appShell")
        await expect(auth_screen).to_be_visible()
        await page.locator("#authBrandCard").click()
        await expect(page.locator("#authFormCard")).to_have_attribute("aria-hidden", "false")
        await page.locator("#authEmail").fill(LOGIN_EMAIL)
        await page.locator("#authPassword").fill(LOGIN_PASSWORD)
        await page.locator("#authSignInBtn").click()
        try:
            await expect(app_shell).to_be_visible(timeout=30000)
        except AssertionError as exc:
            err = (await page.locator("#authError").inner_text()).strip()
            raise AssertionError(f"Login failed: {err or '(no authError)'}") from exc
        await expect(auth_screen).to_be_hidden()

        await page.locator("#profileBtn").click()
        await expect(page.locator("#accountWorkspace")).to_be_visible()
        before = await page.locator("#profileName").input_value()
        await page.locator("#profileName").fill("Unsaved Name")
        await page.locator("#accountBackBtn").click()
        await expect(page.locator("#accountWorkspace")).to_be_hidden()

        await page.locator("#profileBtn").click()
        await expect(page.locator("#accountWorkspace")).to_be_visible()
        after = await page.locator("#profileName").input_value()
        assert after != "Unsaved Name"
        assert after == before
        await page.locator("#accountBackBtn").click()

    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()


if __name__ == "__main__":
    asyncio.run(run_test())
