"""
TC006: Opening the sign-in card from the brand area shows email and password fields.

Requires Supabase configured (sign-in UI, not the no-config screen).
"""
import asyncio
import os

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

        await expect(page.locator("#authScreen")).to_be_visible(timeout=10000)
        await page.locator("#authBrandCard").click()
        await expect(page.locator("#authFormCard")).to_have_attribute("aria-hidden", "false")

        await expect(page.locator("#authEmail")).to_be_visible()
        await expect(page.locator("#authPassword")).to_be_visible()
        await expect(page.locator("#authEmail")).to_be_enabled()
        await expect(page.locator("#authPassword")).to_be_enabled()

    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()


if __name__ == "__main__":
    asyncio.run(run_test())
