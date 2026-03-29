"""
TC040: When CALLLOG_TEST_EXPECT_ADMIN=1, Administration tab is visible and opens invite + users UI.

Skip (exit 0) when the env flag is not set so default CI/non-admin accounts do not fail.
Set CALLLOG_TEST_EXPECT_ADMIN=1 only for runs where CALLLOG_TEST_EMAIL is an admin user and
the account-admin Edge Function is deployed.
"""
import asyncio
import os
import sys

from tc_browser import launch_test_browser
from playwright.async_api import async_playwright, expect

BASE_URL = os.environ.get("CALLLOG_TEST_BASE_URL", "http://localhost:4173")
LOGIN_EMAIL = os.environ.get("CALLLOG_TEST_EMAIL", "")
LOGIN_PASSWORD = os.environ.get("CALLLOG_TEST_PASSWORD", "")


def _expect_admin_enabled() -> bool:
    v = (os.environ.get("CALLLOG_TEST_EXPECT_ADMIN") or "").strip().lower()
    return v in ("1", "true", "yes", "on")


async def run_test() -> None:
    if not _expect_admin_enabled():
        print("TC040: SKIP — set CALLLOG_TEST_EXPECT_ADMIN=1 with an admin test user to run.", file=sys.stderr)
        return

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

        admin_tab = page.locator("#accountTabAdmin")
        await expect(admin_tab).to_be_visible()
        await admin_tab.click()

        await expect(page.locator("#adminInviteEmail")).to_be_visible()
        await expect(page.locator("#adminUsersTableBody")).to_be_visible()
        await expect(page.locator("#adminUsersRefreshBtn")).to_be_visible()

        await page.locator("#accountBackInlineBtn").click()

    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()


if __name__ == "__main__":
    asyncio.run(run_test())
