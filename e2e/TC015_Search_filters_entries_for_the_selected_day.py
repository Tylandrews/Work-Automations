"""
TC015: Open search, filter by a substring from one visible entry, then close search and see the full day list again.

Creates two calls on the current day with distinct tokens so the filter can isolate one row.
"""
import asyncio
import os
import secrets
from datetime import datetime

from calllog_e2e_cleanup import e2e_notes_with_run_id, new_e2e_run_id, run_supabase_e2e_cleanup
from tc_browser import launch_test_browser
from tc_selectors import ENTRY_CARD
from playwright.async_api import async_playwright, expect

BASE_URL = os.environ.get("CALLLOG_TEST_BASE_URL", "http://localhost:4173")
LOGIN_EMAIL = os.environ.get("CALLLOG_TEST_EMAIL", "")
LOGIN_PASSWORD = os.environ.get("CALLLOG_TEST_PASSWORD", "")

# Per-run unique core so older test data on the same day cannot match the filter
_CORE = secrets.token_hex(6)
TOKEN_MATCH = f"tc015match_{_CORE}"
TOKEN_OTHER = f"tc015other_{secrets.token_hex(6)}"
QUERY = _CORE


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

        today_dt = datetime.now().strftime("%Y-%m-%dT%H:%M")

        async def save_call(name: str, org_suffix: str) -> None:
            await page.locator("#name").fill(name)
            await page.locator("#organization").fill(f"Org {org_suffix}")
            await page.locator("#mobile").fill("555-0150")
            await page.locator("#supportRequest").fill("Search filter test")
            await page.locator("#notes").fill(
                e2e_notes_with_run_id(e2e_run_id, "TC015 search filter")
            )
            await page.locator("#callDate").fill(today_dt)
            await page.get_by_role("button", name="Save Call").click()

        await save_call(f"Caller {TOKEN_MATCH}", "A")
        await expect(page.locator("#entriesList")).to_contain_text(TOKEN_MATCH, timeout=30000)

        await save_call(f"Caller {TOKEN_OTHER}", "B")
        entries = page.locator("#entriesList")
        await expect(entries).to_contain_text(TOKEN_OTHER, timeout=30000)

        search_wrap = page.locator("#searchContainer")
        await page.locator("#searchBtn").click()
        await expect(search_wrap).to_be_visible()

        await page.locator("#searchInput").fill(QUERY)

        await expect(entries.locator(ENTRY_CARD)).to_have_count(1, timeout=30000)
        await expect(entries).to_contain_text(TOKEN_MATCH)
        await expect(entries).not_to_contain_text(TOKEN_OTHER)

        await page.locator("#closeSearch").click()
        await expect(search_wrap).to_be_hidden()

        await expect(entries).to_contain_text(TOKEN_MATCH, timeout=30000)
        await expect(entries).to_contain_text(TOKEN_OTHER, timeout=30000)

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
