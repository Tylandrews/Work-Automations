"""
TC017: Search broad substring matches two rows on the selected day; appending chars narrows to one; then close search.

Uses two organizations that share a rare token so refining the query is deterministic.
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

_RUN = secrets.token_hex(5)
SHARED = f"qvw017_br_{_RUN}"
ORG_A = f"{SHARED}_portland"
ORG_B = f"{SHARED}_seattle"
NAME_A = "Caller 017 Alpha"
NAME_B = "Caller 017 Beta"


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

        async def save_row(name: str, org: str) -> None:
            await page.locator("#name").fill(name)
            await page.locator("#organization").fill(org)
            await page.locator("#mobile").fill("555-0170")
            await page.locator("#supportRequest").fill("TC017 search refine")
            await page.locator("#notes").fill(
                e2e_notes_with_run_id(e2e_run_id, "TC017 search refine")
            )
            await page.locator("#callDate").fill(today_dt)
            await page.get_by_role("button", name="Save Call").click()

        await save_row(NAME_A, ORG_A)
        await expect(page.locator("#entriesList")).to_contain_text(NAME_A, timeout=30000)
        await save_row(NAME_B, ORG_B)
        entries = page.locator("#entriesList")
        await expect(entries).to_contain_text(NAME_B, timeout=30000)

        search_wrap = page.locator("#searchContainer")
        inp = page.locator("#searchInput")
        await page.locator("#searchBtn").click()
        await expect(search_wrap).to_be_visible()

        await inp.fill(SHARED)
        await expect(entries.locator(ENTRY_CARD)).to_have_count(2, timeout=30000)
        await expect(entries).to_contain_text(NAME_A)
        await expect(entries).to_contain_text(NAME_B)

        # One atomic filter update: per-key input fires overlapping async loadEntries()
        # (no serialization); stale completions can leave 0 cards. TC018 uses the same pattern.
        narrow_query = f"{SHARED}_portland"
        await inp.fill(narrow_query)
        await inp.evaluate(
            """el => el.dispatchEvent(new Event('input', { bubbles: true }))"""
        )
        await expect(entries.locator(ENTRY_CARD)).to_have_count(1, timeout=30000)
        await expect(entries).to_contain_text(NAME_A)
        await expect(entries).not_to_contain_text(NAME_B)

        await page.locator("#closeSearch").click()
        await expect(search_wrap).to_be_hidden()

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
