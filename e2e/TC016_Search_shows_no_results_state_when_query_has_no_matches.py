"""
TC016: With at least one call on the selected day, a search query that matches nothing shows the no-results copy.

Then closing search restores the normal list for that day.
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

# Fixed string; must not appear in the per-run caller name (substring search is case-insensitive)
NO_MATCH_QUERY = "zzzz_nomatch_94f2b1c8d7e6_qwerty"


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

        marker = f"TC016_{secrets.token_hex(6)}"

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

        await page.locator("#name").fill(marker)
        await page.locator("#organization").fill("TC016 Org")
        await page.locator("#mobile").fill("555-0160")
        await page.locator("#supportRequest").fill("TC016 support line")
        await page.locator("#notes").fill(e2e_notes_with_run_id(e2e_run_id, "TC016 no results"))
        await page.locator("#callDate").fill(datetime.now().strftime("%Y-%m-%dT%H:%M"))

        await page.get_by_role("button", name="Save Call").click()

        entries = page.locator("#entriesList")
        await expect(entries).to_contain_text(marker, timeout=30000)

        search_wrap = page.locator("#searchContainer")
        await page.locator("#searchBtn").click()
        await expect(search_wrap).to_be_visible()

        await page.locator("#searchInput").fill(NO_MATCH_QUERY)

        await expect(entries).to_contain_text("No matching calls found", timeout=30000)
        await expect(entries).to_contain_text("Try adjusting your search terms")
        await expect(entries.locator(ENTRY_CARD)).to_have_count(0)

        await page.locator("#closeSearch").click()
        await expect(search_wrap).to_be_hidden()

        await expect(entries).to_contain_text(marker, timeout=30000)
        await expect(entries.locator(ENTRY_CARD).filter(has_text=marker)).to_be_visible()

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
