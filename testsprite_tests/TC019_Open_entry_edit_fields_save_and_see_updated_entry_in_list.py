"""
TC019: Open an entry, set name to Edit Save Test, save, list shows the new name.
"""
import asyncio
import os
import time
from datetime import datetime

from tc_browser import is_headless_browser
from playwright.async_api import async_playwright, expect

BASE_URL = os.environ.get("CALLLOG_TEST_BASE_URL", "http://localhost:4173")
LOGIN_EMAIL = os.environ.get("CALLLOG_TEST_EMAIL", "")
LOGIN_PASSWORD = os.environ.get("CALLLOG_TEST_PASSWORD", "")

UPDATED = "Edit Save Test"


async def run_test() -> None:
    pw = None
    browser = None
    context = None

    try:
        pw = await async_playwright().start()
        browser = await pw.chromium.launch(
            headless=is_headless_browser(),
            args=["--window-size=1280,720", "--disable-dev-shm-usage"],
        )
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
        original = f"TC019_before_{int(time.time() * 1000) % 10 ** 8}"
        await page.locator("#name").fill(original)
        await page.locator("#organization").fill("TC019 Org")
        await page.locator("#mobile").fill("555-0190")
        await page.locator("#supportRequest").fill("Edit flow")
        await page.locator("#callDate").fill(datetime.now().strftime("%Y-%m-%dT%H:%M"))
        await page.get_by_role("button", name="Save Call").click()

        entries = page.locator("#entriesList")
        await expect(entries).to_contain_text(original, timeout=45000)

        await page.locator(".entry-card").filter(has_text=original).first.click()
        await expect(page.locator("#editModal")).to_be_visible()

        await page.locator("#editName").fill(UPDATED)
        await page.locator("#editModal").locator('button[type="submit"]').click()
        await expect(page.locator("#editModal")).to_be_hidden(timeout=45000)

        await expect(entries).to_contain_text(UPDATED, timeout=30000)
        await expect(entries).not_to_contain_text(original)

    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()


if __name__ == "__main__":
    asyncio.run(run_test())
