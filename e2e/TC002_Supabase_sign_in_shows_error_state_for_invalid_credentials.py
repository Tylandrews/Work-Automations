"""
TC002: Invalid credentials show a visible authentication error; main shell stays hidden.

Supabase error copy varies (e.g. "Invalid login credentials"). We assert #authError is
non-empty and looks like an auth failure, not an exact string match.
"""
import asyncio
import os
import re

from tc_browser import launch_test_browser
from playwright.async_api import async_playwright, expect

BASE_URL = os.environ.get("CALLLOG_TEST_BASE_URL", "http://localhost:4173")


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
        await page.goto(BASE_URL, wait_until="domcontentloaded", timeout=30000)

        auth_screen = page.locator("#authScreen")
        app_shell = page.locator("#appShell")

        await expect(auth_screen).to_be_visible()

        await page.locator("#authBrandCard").click()
        await expect(page.locator("#authFormCard")).to_have_attribute("aria-hidden", "false")

        await page.locator("#authEmail").fill("invalid-user@example.com")
        await page.locator("#authPassword").fill("wrong-password")
        await page.locator("#authSignInBtn").click()

        err = page.locator("#authError")
        await expect(err).to_be_visible(timeout=10000)
        err_text = (await err.inner_text()).strip()
        assert err_text, "Expected non-empty auth error message"
        assert re.search(
            r"invalid|credentials|password|login|email|wrong|incorrect|failed|not\s+found|user",
            err_text,
            re.IGNORECASE,
        ), f"Unexpected auth error copy: {err_text!r}"

        await expect(app_shell).to_be_hidden()

    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()


if __name__ == "__main__":
    asyncio.run(run_test())
