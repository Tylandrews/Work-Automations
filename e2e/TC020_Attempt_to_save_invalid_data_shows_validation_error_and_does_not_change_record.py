"""
TC020: Clear a required field in the edit modal, try save — HTML5 blocks save; close modal; list unchanged.
"""
import asyncio
import os
from datetime import datetime

from calllog_e2e_cleanup import e2e_notes_with_run_id, new_e2e_run_id, run_supabase_e2e_cleanup
from tc_browser import launch_test_browser
from tc_selectors import EDIT_MODAL_SUBMIT, history_entry_card
from playwright.async_api import async_playwright, expect

BASE_URL = os.environ.get("CALLLOG_TEST_BASE_URL", "http://localhost:4173")
LOGIN_EMAIL = os.environ.get("CALLLOG_TEST_EMAIL", "")
LOGIN_PASSWORD = os.environ.get("CALLLOG_TEST_PASSWORD", "")

MARKER = "TC020_validation_hold_q9w4"


async def run_test() -> None:
    pw = None
    browser = None
    context = None
    e2e_run_id = new_e2e_run_id()

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
        await page.locator("#name").fill(MARKER)
        await page.locator("#organization").fill("TC020 Org")
        await page.locator("#mobile").fill("555-0200")
        await page.locator("#supportRequest").fill("Validation test")
        await page.locator("#ticketNumber").fill(e2e_notes_with_run_id(e2e_run_id, "TC020 validation"))
        await page.locator("#callDate").fill(datetime.now().strftime("%Y-%m-%dT%H:%M"))
        await page.get_by_role("button", name="Save Call").click()

        entries = page.locator("#entriesList")
        await expect(entries).to_contain_text(MARKER, timeout=30000)

        await history_entry_card(page, MARKER).locator(".entry-name").click()
        await expect(page.locator("#editModal")).to_be_visible(timeout=15000)

        await page.locator("#editName").fill("")
        await page.locator("#editModal").locator(EDIT_MODAL_SUBMIT).click()

        valid = await page.locator("#editName").evaluate("el => el.validity.valid")
        assert valid is False

        await page.locator("#closeModal").click()
        await expect(page.locator("#editModal")).to_be_hidden(timeout=10000)

        await expect(entries).to_contain_text(MARKER, timeout=15000)

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
