"""
TC018: Filter with search, clear the input (not the close button), full day list returns while search stays open.
"""
import asyncio
import os
import secrets
from datetime import datetime

from tc_browser import is_headless_browser
from playwright.async_api import async_playwright, expect

BASE_URL = os.environ.get("CALLLOG_TEST_BASE_URL", "http://localhost:4173")
LOGIN_EMAIL = os.environ.get("CALLLOG_TEST_EMAIL", "andrews.s.tyler@gmail.com")
LOGIN_PASSWORD = os.environ.get("CALLLOG_TEST_PASSWORD", "123456")

# Per-run unique query so historical rows cannot match; T_B must not contain QUERY
_RUN = secrets.token_hex(6)
QUERY = f"uq7xm9k2{_RUN}tc018"
T_A = f"alpha_{QUERY}"
T_B = f"beta_other_{secrets.token_hex(4)}"


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
        today_dt = datetime.now().strftime("%Y-%m-%dT%H:%M")
        entries = page.locator("#entriesList")

        async def save_row(caller_label: str) -> None:
            await page.locator("#name").fill(caller_label)
            await page.locator("#organization").fill("Org TC018")
            await page.locator("#mobile").fill("555-0180")
            await page.locator("#supportRequest").fill("TC018 clear search")
            await page.locator("#callDate").fill(today_dt)
            await page.get_by_role("button", name="Save Call").click()
            await expect(entries).to_contain_text(caller_label, timeout=45000)

        await save_row(f"Caller {T_A}")
        await save_row(f"Caller {T_B}")

        search_wrap = page.locator("#searchContainer")
        inp = page.locator("#searchInput")
        await page.locator("#searchBtn").click()
        await expect(search_wrap).to_be_visible()

        await inp.fill(QUERY)
        await inp.evaluate(
            """el => el.dispatchEvent(new Event('input', { bubbles: true }))"""
        )
        await expect(entries.locator(".entry-card")).to_have_count(1, timeout=45000)
        await expect(entries).to_contain_text(T_A)
        await expect(entries).not_to_contain_text(T_B)

        await inp.fill("")
        await inp.evaluate(
            """el => el.dispatchEvent(new Event('input', { bubbles: true }))"""
        )
        await expect(search_wrap).to_be_visible()
        await expect(entries).to_contain_text(T_A, timeout=30000)
        await expect(entries).to_contain_text(T_B, timeout=30000)

    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()


if __name__ == "__main__":
    asyncio.run(run_test())
