"""
TC013: Save a call, then use day arrows so the history list matches the selected day.

Saves the call on yesterday’s local date so “next day” moves to today where this row
should not appear, then “previous day” returns to yesterday and the row is visible again.
"""
import asyncio
import os
from datetime import datetime, timedelta

from tc_browser import is_headless_browser
from playwright.async_api import async_playwright, expect

BASE_URL = os.environ.get("CALLLOG_TEST_BASE_URL", "http://localhost:4173")
LOGIN_EMAIL = os.environ.get("CALLLOG_TEST_EMAIL", "")
LOGIN_PASSWORD = os.environ.get("CALLLOG_TEST_PASSWORD", "")

CALLER = "Day A Caller"
ORG = "Day A Org"
PHONE = "555-0131"
SUPPORT = "VPN setup"


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

        yesterday = datetime.now() - timedelta(days=1)
        await page.locator("#callDate").fill(yesterday.strftime("%Y-%m-%dT10:30"))

        await page.locator("#name").fill(CALLER)
        await page.locator("#organization").fill(ORG)
        await page.locator("#mobile").fill(PHONE)
        await page.locator("#supportRequest").fill(SUPPORT)

        await page.get_by_role("button", name="Save Call").click()

        entries = page.locator("#entriesList")
        day_label = page.locator("#historyDayLabel")
        await expect(entries).to_contain_text(CALLER, timeout=30000)

        label_yesterday = await day_label.inner_text()
        await page.locator("#historyNextDayBtn").click()
        await expect(day_label).not_to_have_text(label_yesterday, timeout=15000)
        await expect(entries).not_to_contain_text(CALLER, timeout=30000)

        label_today = await day_label.inner_text()
        await page.locator("#historyPrevDayBtn").click()
        await expect(day_label).not_to_have_text(label_today, timeout=15000)
        await expect(entries).to_contain_text(CALLER, timeout=30000)

    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()


if __name__ == "__main__":
    asyncio.run(run_test())
