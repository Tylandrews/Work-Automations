"""
TC001: After valid Supabase credentials, the authenticated main shell is shown.

Requires: static server on BASE_URL, valid Supabase in supabaseConfig.js, and test credentials.
Override defaults with env: CALLLOG_TEST_BASE_URL, CALLLOG_TEST_EMAIL, CALLLOG_TEST_PASSWORD.
"""
import asyncio
import os

from tc_browser import is_headless_browser
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

        browser = await pw.chromium.launch(
            headless=is_headless_browser(),
            args=[
                "--window-size=1280,720",
                "--disable-dev-shm-usage",
            ],
        )

        context = await browser.new_context()
        context.set_default_timeout(15000)

        page = await context.new_page()
        await page.goto(BASE_URL, wait_until="domcontentloaded", timeout=30000)

        auth_screen = page.locator("#authScreen")
        app_shell = page.locator("#appShell")

        if await auth_screen.is_visible():
            await page.locator("#authBrandCard").click()
            await expect(page.locator("#authFormCard")).to_have_attribute("aria-hidden", "false")
            await page.locator("#authEmail").fill(LOGIN_EMAIL)
            await page.locator("#authPassword").fill(LOGIN_PASSWORD)
            await page.locator("#authSignInBtn").click()

        try:
            await expect(app_shell).to_be_visible(timeout=25000)
        except AssertionError as exc:
            err_text = (await page.locator("#authError").inner_text()).strip()
            raise AssertionError(
                "Main shell did not appear after login. "
                f"authError: {err_text or '(empty)'}",
            ) from exc

        await expect(auth_screen).to_be_hidden()
        await expect(page.locator("#callForm")).to_be_visible(timeout=10000)
        await expect(page.get_by_role("heading", name="New Call")).to_be_visible()

    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()


if __name__ == "__main__":
    asyncio.run(run_test())
