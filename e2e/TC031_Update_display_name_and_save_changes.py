"""
TC031: Set display name to Test Display Name, save — field reflects value and Account updated toast appears.
"""
import asyncio
import os

from calllog_e2e_cleanup import run_supabase_e2e_cleanup
from tc_browser import launch_test_browser
from tc_selectors import APP_NOTIFICATION
from playwright.async_api import async_playwright, expect

BASE_URL = os.environ.get("CALLLOG_TEST_BASE_URL", "http://localhost:4173")
LOGIN_EMAIL = os.environ.get("CALLLOG_TEST_EMAIL", "")
LOGIN_PASSWORD = os.environ.get("CALLLOG_TEST_PASSWORD", "")

DISPLAY = "Test Display Name"


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

        await page.locator("#profileName").fill(DISPLAY)
        await page.locator("#profileSaveBtn").click()

        await expect(page.locator(APP_NOTIFICATION)).to_contain_text(
            "Account updated", timeout=20000
        )

        await page.locator("#accountBackInlineBtn").click()
        await expect(page.locator("#mainWorkspace")).to_be_visible()
        await page.locator("#profileBtn").click()
        await expect(page.locator("#accountWorkspace")).to_be_visible()
        await expect(page.locator("#profileName")).to_have_value(DISPLAY)
        await page.locator("#accountBackInlineBtn").click()

    finally:
        run_supabase_e2e_cleanup(reset_profile_full_name=True)
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()


if __name__ == "__main__":
    asyncio.run(run_test())
