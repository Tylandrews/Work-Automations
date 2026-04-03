"""
TC009: Type in Organization, pick an autocomplete suggestion, save the call, list shows that org.

Stubs Supabase REST (cached_autotask_companies + sync meta) and autotask-sync-all-companies
so org hydration is deterministic without real Autotask data.
Set CALLLOG_TEST_NO_AUTOTASK_MOCK=1 to use your real Supabase project (apply migrations;
CALLLOG_TEST_ORG_QUERY must match a company name substring in cached_autotask_companies).
"""
import asyncio
import os

from calllog_e2e_cleanup import e2e_notes_with_run_id, new_e2e_run_id, run_supabase_e2e_cleanup
from tc_browser import launch_test_browser
from tc_org_cache_supabase_stubs import register_org_cache_supabase_stubs
from tc_selectors import ORG_AUTOCOMPLETE_ITEM
from playwright.async_api import async_playwright, expect

BASE_URL = os.environ.get("CALLLOG_TEST_BASE_URL", "http://localhost:4173")
LOGIN_EMAIL = os.environ.get("CALLLOG_TEST_EMAIL", "")
LOGIN_PASSWORD = os.environ.get("CALLLOG_TEST_PASSWORD", "")
ORG_QUERY = os.environ.get("CALLLOG_TEST_ORG_QUERY", "AC")
MOCK_ORG_NAME = "ACME Org TC009"
NO_MOCK = os.environ.get("CALLLOG_TEST_NO_AUTOTASK_MOCK", "").strip().lower() in ("1", "true", "yes")


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

        if not NO_MOCK:
            await register_org_cache_supabase_stubs(
                page,
                [{"autotask_id": "e2e-tc009", "company_name": MOCK_ORG_NAME}],
            )

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

        org_input = page.locator("#organization")
        await org_input.fill("")
        await org_input.fill(ORG_QUERY)

        first_suggestion = page.locator(ORG_AUTOCOMPLETE_ITEM).first
        try:
            await expect(first_suggestion).to_be_visible(timeout=25000)
        except AssertionError as exc:
            raise AssertionError(
                "No autocomplete results. With mock: ensure routes match your Supabase functions URL. "
                "Without mock (CALLLOG_TEST_NO_AUTOTASK_MOCK=1): set CALLLOG_TEST_ORG_QUERY to a partial "
                f"that returns data (current: {ORG_QUERY!r}).",
            ) from exc

        selected_org = (await first_suggestion.inner_text()).strip()
        assert selected_org, "Autocomplete item had empty label"
        await first_suggestion.click()

        await expect(org_input).to_have_value(selected_org)

        await page.locator("#mobile").fill("555-0188")
        await page.locator("#supportRequest").fill("Network access request")
        await page.locator("#notes").fill(e2e_notes_with_run_id(e2e_run_id, "TC009 autocomplete"))

        await page.get_by_role("button", name="Save Call").click()

        entries = page.locator("#entriesList")
        await expect(entries).to_contain_text("Test Caller", timeout=30000)
        await expect(entries).to_contain_text(selected_org, timeout=10000)

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
