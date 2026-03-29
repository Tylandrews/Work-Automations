"""
TC025: Open Reports — overlay visible with either report cards or an error line.
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
            args=["--window-size=1280,720", "--disable-dev-shm-usage"],
        )
        context = await browser.new_context()
        context.set_default_timeout(25000)
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

        reports_btn = page.locator("#reportsBtn")
        await expect(reports_btn).to_be_visible(timeout=10000)
        await reports_btn.click()

        modal = page.locator("#reportsModal")
        await expect(modal).to_be_visible(timeout=15000)
        await expect(page.locator("#reportsTitle")).to_have_text("Reports")

        # #reportsError stays in the layout while empty; wait for real content (message or cards).
        await page.wait_for_function(
            """() => {
                const err = (document.getElementById('reportsError')?.textContent || '').trim();
                const n = document.querySelectorAll('#reportsGrid .report-card').length;
                return err.length > 0 || n > 0;
            }""",
            timeout=30000,
        )

        err_text = (await page.locator("#reportsError").inner_text()).strip()
        n_cards = await page.locator("#reportsGrid .report-card").count()
        assert err_text or n_cards >= 1, "Expected reports error text or at least one report card"

    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()


if __name__ == "__main__":
    asyncio.run(run_test())
