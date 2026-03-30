"""
TC024: Select a day with no calls in the list, open Statistics.

The statistics page summarizes your calls for the selected date range (default last 30 days), not only
the selected calendar day. We assert the list shows an empty-day message, then the statistics page
shows either metrics or "No data available" when there are no rows in range.
"""
import asyncio
import os

from tc_browser import launch_test_browser
from tc_selectors import calendar_grid_any_day, calendar_grid_day
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

        # Match script.js toLocalDayKey (browser local), not Python datetime
        empty_day = await page.evaluate(
            """() => {
                const d = new Date();
                d.setDate(d.getDate() + 550);
                const y = d.getFullYear();
                const m = String(d.getMonth() + 1).padStart(2, '0');
                const day = String(d.getDate()).padStart(2, '0');
                return `${y}-${m}-${day}`;
            }"""
        )

        await page.locator("#historyCalendarBtn").click()
        await expect(page.locator("#calendarModal")).to_be_visible()
        day_btn = page.locator(calendar_grid_day(empty_day))
        for _ in range(48):
            if await day_btn.count() > 0:
                break
            await page.locator("#calNextMonth").click()
            await expect(page.locator(calendar_grid_any_day()).first).to_be_visible(
                timeout=15000
            )
        else:
            raise AssertionError(f"Could not reach calendar month for {empty_day}")

        await day_btn.first.evaluate("el => el.click()")
        await expect(page.locator("#calendarModal")).to_be_hidden(timeout=15000)

        entries = page.locator("#entriesList")
        await expect(entries).to_contain_text("No calls for this day", timeout=30000)

        await page.locator("#statsBtn").click()
        stats = page.locator("#statsWorkspace")
        await expect(stats).to_be_visible()
        await expect(page.locator("#statsLoading")).to_be_hidden(timeout=30000)
        body = await stats.inner_text()
        assert "No data available" in body or "Total Calls" in body

        await page.locator("#statsBackInlineBtn").click()
        await expect(stats).to_be_hidden()

    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()


if __name__ == "__main__":
    asyncio.run(run_test())
