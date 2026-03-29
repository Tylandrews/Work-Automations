"""
TC005: Sign-in cannot proceed without a password — HTML5 required on #authPassword
blocks submit, or doLogin shows an inline error.

Requires Supabase configured so the sign-in form is shown.
"""
import asyncio
import os

from tc_browser import is_headless_browser
from playwright.async_api import async_playwright, expect

BASE_URL = os.environ.get("CALLLOG_TEST_BASE_URL", "http://localhost:4173")
LOGIN_EMAIL = os.environ.get("CALLLOG_TEST_EMAIL", "andrews.s.tyler@gmail.com")


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

        await expect(page.locator("#authScreen")).to_be_visible(timeout=10000)
        await page.locator("#authBrandCard").click()
        await expect(page.locator("#authFormCard")).to_have_attribute("aria-hidden", "false")

        await page.locator("#authEmail").fill(LOGIN_EMAIL)
        await page.locator("#authPassword").fill("")
        await page.locator("#authSignInBtn").click()

        await expect(page.locator("#appShell")).to_be_hidden()

        password = page.locator("#authPassword")
        value_missing = await password.evaluate("el => el.validity.valueMissing")
        err_text = (await page.locator("#authError").inner_text()).strip()

        assert value_missing or "email" in err_text.lower() or "password" in err_text.lower(), (
            "Expected empty-password validation (valueMissing) or authError hint, "
            f"got valueMissing={value_missing!r}, authError={err_text!r}"
        )

    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()


if __name__ == "__main__":
    asyncio.run(run_test())
