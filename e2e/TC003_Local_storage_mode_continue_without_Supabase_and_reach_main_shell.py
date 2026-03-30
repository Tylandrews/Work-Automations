"""
TC003 (revised): Without Supabase URL/key, the app stays on the auth screen and does not
open the main shell. Call data is Supabase-only — there is no local call storage fallback.

Stubs supabaseConfig.js with empty credentials (same as a missing misconfiguration).
"""
import asyncio
import os

from tc_browser import launch_test_browser
from tc_selectors import AUTH_NO_CONFIG_TITLE
from playwright.async_api import async_playwright, expect

BASE_URL = os.environ.get("CALLLOG_TEST_BASE_URL", "http://localhost:4173")

STUB_SUPABASE_CONFIG_JS = (
    "window.supabaseConfig = { SUPABASE_URL: '', SUPABASE_ANON_KEY: '' };"
)


async def run_test() -> None:
    pw = None
    browser = None
    context = None

    try:
        pw = await async_playwright().start()

        browser = await launch_test_browser(pw)

        context = await browser.new_context()
        context.set_default_timeout(15000)

        page = await context.new_page()

        async def stub_supabase_config(route):
            await route.fulfill(
                status=200,
                content_type="application/javascript; charset=utf-8",
                body=STUB_SUPABASE_CONFIG_JS,
            )

        await page.route("**/supabaseConfig.js", stub_supabase_config)

        await page.goto(BASE_URL, wait_until="domcontentloaded", timeout=30000)

        await expect(page.locator("#authScreen")).to_be_visible(timeout=10000)
        await expect(page.locator("#authNoConfig")).to_be_visible()
        await expect(page.locator(AUTH_NO_CONFIG_TITLE)).to_be_visible()
        await expect(page.locator("#appShell")).to_be_hidden()

    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()


if __name__ == "__main__":
    asyncio.run(run_test())
