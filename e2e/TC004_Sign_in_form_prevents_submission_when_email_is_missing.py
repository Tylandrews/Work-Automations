"""
TC004: Sign-in cannot proceed without an email — HTML5 required on #authEmail blocks submit,
or the handler shows an inline error.

Requires Supabase configured (real supabaseConfig.js) so the sign-in form is shown.
"""
import asyncio
import os

from tc_browser import is_headless_browser
from playwright.async_api import async_playwright, expect

BASE_URL = os.environ.get("CALLLOG_TEST_BASE_URL", "http://localhost:4173")
LOGIN_PASSWORD = os.environ.get("CALLLOG_TEST_PASSWORD", "")
# Non-secret placeholder so #authPassword is valid while we assert #authEmail is missing
_PLACEHOLDER_PASSWORD = "e2e-tc004-placeholder-not-a-real-password"


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

        await page.locator("#authEmail").fill("")
        await page.locator("#authPassword").fill(LOGIN_PASSWORD or _PLACEHOLDER_PASSWORD)
        await page.locator("#authSignInBtn").click()

        await expect(page.locator("#appShell")).to_be_hidden()

        email = page.locator("#authEmail")
        value_missing = await email.evaluate("el => el.validity.valueMissing")
        err_text = (await page.locator("#authError").inner_text()).strip()

        assert value_missing or "email" in err_text.lower() or "password" in err_text.lower(), (
            "Expected empty-email validation (valueMissing) or authError hint, "
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
