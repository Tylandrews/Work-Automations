"""
TC035: Organization autocomplete shows suggestions from cached_autotask_companies quickly.

Seeds localStorage via init script, stubs Supabase REST (org cache + sync meta) and the
weekly sync Edge URL so hydration is deterministic. Autocomplete is local-only with debounce.

Override strictness with CALLLOG_TEST_ORG_INSTANT_MAX_MS (default 900).
"""
import asyncio
import json
import os
import time

from tc_browser import launch_test_browser
from tc_org_cache_supabase_stubs import (
    register_org_cache_supabase_stubs,
    wait_for_local_autotask_org_cache,
)
from tc_selectors import ORG_AUTOCOMPLETE_ITEM
from playwright.async_api import async_playwright, expect

BASE_URL = os.environ.get("CALLLOG_TEST_BASE_URL", "http://localhost:4173")
LOGIN_EMAIL = os.environ.get("CALLLOG_TEST_EMAIL", "")
LOGIN_PASSWORD = os.environ.get("CALLLOG_TEST_PASSWORD", "")
MAX_MS = float(os.environ.get("CALLLOG_TEST_ORG_INSTANT_MAX_MS", "900"))

CACHED_ORG_NAME = "ZZTC035_Cached_Org_SpeedTest"
# Two-character query matching the cached name (autocomplete requires min 2 chars)
QUERY = "ZZ"


async def run_test() -> None:
    pw = None
    browser = None
    context = None

    try:
        pw = await async_playwright().start()

        browser = await launch_test_browser(pw)

        context = await browser.new_context()
        context.set_default_timeout(25000)

        await context.add_init_script(
            f"""
            try {{
                localStorage.setItem(
                    'cached_autotask_companies',
                    JSON.stringify([{{ "id": "e2e-tc035", "name": {json.dumps(CACHED_ORG_NAME)} }}])
                );
            }} catch (e) {{}}
            """
        )

        page = await context.new_page()
        await register_org_cache_supabase_stubs(
            page,
            [{"autotask_id": "e2e-tc035", "company_name": CACHED_ORG_NAME}],
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

        await wait_for_local_autotask_org_cache(page)

        org_input = page.locator("#organization")
        first_suggestion = page.locator(ORG_AUTOCOMPLETE_ITEM).first

        t0 = time.perf_counter()
        await org_input.fill("")
        await org_input.fill(QUERY)
        await expect(first_suggestion).to_be_visible(timeout=max(5000, int(MAX_MS) + 500))
        elapsed_ms = (time.perf_counter() - t0) * 1000

        label = (await first_suggestion.inner_text()).strip()
        assert CACHED_ORG_NAME in label or label == CACHED_ORG_NAME, (
            f"Expected cached org label, got {label!r}"
        )

        if elapsed_ms > MAX_MS:
            raise AssertionError(
                f"Autocomplete from cache took {elapsed_ms:.0f}ms; "
                f"max allowed CALLLOG_TEST_ORG_INSTANT_MAX_MS={MAX_MS:g}ms. "
                "Ensure local org list + debounced filter stay fast."
            )

    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()


if __name__ == "__main__":
    asyncio.run(run_test())
