"""
TC010: Clear removes user-entered text from the call form.

callForm.reset() plus setCurrentDateTime() — date/time is set to "now", not left blank.
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
        context.set_default_timeout(20000)

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
                await expect(app_shell).to_be_visible(timeout=30000)
            except AssertionError as exc:
                err = (await page.locator("#authError").inner_text()).strip()
                raise AssertionError(f"Login failed: {err or '(no authError)'}") from exc
            await expect(auth_screen).to_be_hidden()

        await expect(page.locator("#callForm")).to_be_visible(timeout=10000)

        await page.locator("#name").fill("Test Caller")
        await page.locator("#organization").fill("Test Org")
        await page.locator("#mobile").fill("555-0177")
        await page.locator("#supportRequest").fill("Password reset request")
        await page.locator("#deviceName").fill("TC010 device")
        await page.locator("#ticketNumber").fill("should clear")

        await page.get_by_role("button", name="Clear").click()

        await expect(page.locator("#name")).to_have_value("")
        await expect(page.locator("#organization")).to_have_value("")
        await expect(page.locator("#mobile")).to_have_value("")
        await expect(page.locator("#supportRequest")).to_have_value("")
        await expect(page.locator("#deviceName")).to_have_value("")
        await expect(page.locator("#ticketNumber")).to_have_value("")

        call_date = page.locator("#callDate")
        await expect(call_date).not_to_have_value("")
        val = await call_date.input_value()
        assert "T" in val and len(val) >= 15, f"Expected datetime-local value after clear, got {val!r}"

    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()


if __name__ == "__main__":
    asyncio.run(run_test())
