"""
TC012: Open the calendar modal, pick a day with no saved calls, entries list shows empty state.

Uses a day far in the future so it is very unlikely to have rows in Supabase.
EMPTY_DAY is computed in the browser so it matches the app's local calendar (toLocalDayKey).
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
        calendar_modal = page.locator("#calendarModal")
        await expect(calendar_modal).to_be_visible()

        day_btn = page.locator(f'#calendarGrid button.cal-day[data-day="{empty_day}"]')
        for _ in range(36):
            if await day_btn.count() > 0:
                break
            await page.locator("#calNextMonth").click()
            await expect(page.locator("#calendarGrid button.cal-day").first).to_be_visible(
                timeout=15000
            )
        else:
            raise AssertionError(
                f"Calendar did not reach a month containing {empty_day} within navigation limit"
            )

        await day_btn.first.click()
        await expect(calendar_modal).to_be_hidden(timeout=15000)

        entries = page.locator("#entriesList")
        await expect(entries.locator(".entry-card")).to_have_count(0, timeout=30000)
        await expect(entries).to_contain_text("No calls", timeout=10000)

    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()


if __name__ == "__main__":
    asyncio.run(run_test())
