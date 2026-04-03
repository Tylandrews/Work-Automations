"""
TC030: Sign in, open Account — tabbed layout with Profile panel, name/email, save control.

Account uses a tablist (Profile, Updates, Security; Administration if admin). Profile opens
by default; email is filled asynchronously from Supabase session — wait for value.
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

        await expect(page.locator("#profileBtn")).to_be_visible()
        await page.locator("#profileBtn").click()

        account_ws = page.locator("#accountWorkspace")
        await expect(account_ws).to_be_visible()
        await expect(account_ws).to_have_attribute("aria-hidden", "false")
        await expect(page.locator("#accountPageHeading")).to_have_text("Account")
        lead = page.locator("#accountWorkspace .account-page-lead")
        await expect(lead).to_be_visible()
        await expect(lead).to_contain_text("Profile, app updates, security")

        profile_tab = page.get_by_role("tab", name="Profile")
        await expect(profile_tab).to_be_visible()
        await expect(profile_tab).to_have_attribute("aria-selected", "true")
        await expect(page.get_by_role("tab", name="Updates")).to_be_visible()
        await expect(page.get_by_role("tab", name="Security")).to_be_visible()

        profile_panel = page.locator("#accountPanelProfile")
        await expect(profile_panel).to_be_visible()

        await expect(page.get_by_role("heading", name="Profile", level=3)).to_be_visible()
        await expect(page.locator("#profileForm")).to_be_visible()
        await expect(page.locator("#profileName")).to_be_visible()
        await expect(page.locator("#profileEmail")).to_be_visible()
        await expect(page.locator("#profileSaveBtn")).to_be_visible()
        await expect(page.locator("#profileSaveBtn")).to_have_text("Save profile")

        # hydrateAccountProfileForm sets email via getSession() — avoid racing the assertion
        if LOGIN_EMAIL:
            await expect(page.locator("#profileEmail")).to_have_value(
                LOGIN_EMAIL,
                timeout=15000,
            )

        await page.locator("#accountBackBtn").click()
        await expect(account_ws).to_be_hidden()

    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()


if __name__ == "__main__":
    asyncio.run(run_test())
