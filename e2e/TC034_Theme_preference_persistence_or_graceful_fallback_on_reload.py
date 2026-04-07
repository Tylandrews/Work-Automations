"""
TC034: Toggle theme, reload — document still has a valid data-theme and shell remains usable.
"""
import asyncio
import os

from tc_browser import launch_test_browser
from playwright.async_api import async_playwright, expect

BASE_URL = os.environ.get("CALLLOG_TEST_BASE_URL", "http://localhost:4173")
LOGIN_EMAIL = os.environ.get("CALLLOG_TEST_EMAIL", "")
LOGIN_PASSWORD = os.environ.get("CALLLOG_TEST_PASSWORD", "")


async def run_test() -> None:
    pw = None
    browser = None
    context = None

    try:
        pw = await async_playwright().start()
        browser = await launch_test_browser(pw)
        context = await browser.new_context()
        context.set_default_timeout(25000)
        page = await context.new_page()
        await page.goto(BASE_URL, wait_until="domcontentloaded", timeout=30000)

        auth_screen = page.locator("#authScreen")
        if await auth_screen.is_visible():
            await page.locator("#authBrandCard").click()
            await expect(page.locator("#authFormCard")).to_have_attribute("aria-hidden", "false")
            await page.locator("#authEmail").fill(LOGIN_EMAIL)
            await page.locator("#authPassword").fill(LOGIN_PASSWORD)
            await page.locator("#authSignInBtn").click()
            await expect(page.locator("#appShell")).to_be_visible(timeout=30000)

        await page.locator("#themeToggleBtn").click()
        await page.wait_for_function(
            """() => {
                const t = document.documentElement.getAttribute('data-theme')
                return t === 'light' || t === 'dark'
            }"""
        )

        await page.reload(wait_until="load")
        app_shell = page.locator("#appShell")
        try:
            await expect(app_shell).to_be_visible(timeout=15000)
        except AssertionError:
            await page.locator("#authBrandCard").click()
            await expect(page.locator("#authFormCard")).to_have_attribute(
                "aria-hidden", "false", timeout=10000
            )
            await page.locator("#authEmail").fill(LOGIN_EMAIL)
            await page.locator("#authPassword").fill(LOGIN_PASSWORD)
            await page.locator("#authSignInBtn").click()
            await expect(app_shell).to_be_visible(timeout=30000)

        theme_after_reload = await page.evaluate(
            "() => document.documentElement.getAttribute('data-theme')"
        )
        assert theme_after_reload in ("light", "dark")
        await expect(page.locator("#callForm")).to_be_visible(timeout=15000)

    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()


if __name__ == "__main__":
    asyncio.run(run_test())
