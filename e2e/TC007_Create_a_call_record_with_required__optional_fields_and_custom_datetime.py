"""
TC007: Log a call with required + optional fields and a custom date/time; entry appears in history.

Requires Supabase, valid credentials, and encryption/PII rules that allow writes (same as normal app use).
"""
import asyncio
import os
from datetime import datetime

from calllog_e2e_cleanup import e2e_notes_with_run_id, new_e2e_run_id, run_supabase_e2e_cleanup
from tc_browser import launch_test_browser
from playwright.async_api import async_playwright, expect

BASE_URL = os.environ.get("CALLLOG_TEST_BASE_URL", "http://localhost:4173")
LOGIN_EMAIL = os.environ.get("CALLLOG_TEST_EMAIL", "")
LOGIN_PASSWORD = os.environ.get("CALLLOG_TEST_PASSWORD", "")


async def run_test() -> None:
    pw = None
    browser = None
    context = None
    e2e_run_id = new_e2e_run_id()

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
        await page.locator("#mobile").fill("555-0100")
        await page.locator("#deviceName").fill("Test Device")
        await page.locator("#supportRequest").fill("Printer not working")
        await page.locator("#ticketNumber").fill(
            e2e_notes_with_run_id(e2e_run_id, "Added via UI test")
        )

        custom_dt = datetime(2026, 3, 15, 14, 30)
        await page.locator("#callDate").fill(custom_dt.strftime("%Y-%m-%dT%H:%M"))

        await page.get_by_role("button", name="Save Call").click()

        entries = page.locator("#entriesList")
        await expect(entries).to_contain_text("Test Caller", timeout=30000)
        await expect(entries).to_contain_text("Test Org", timeout=5000)
        await expect(entries).to_contain_text("Printer not working", timeout=5000)

    finally:
        run_supabase_e2e_cleanup(e2e_run_id=e2e_run_id)
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()


if __name__ == "__main__":
    asyncio.run(run_test())
