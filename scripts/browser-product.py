"""AI0 Chromium: true staff session -> Fastify/PostgreSQL, NOT demo data.

Run only via scripts/browser-product.mjs after isolated database migrations
and VITE_DEMO_MODE=false npm run build. No real customers/printing/OA.
"""
from __future__ import annotations

import os
import shutil
import sys
from playwright.sync_api import sync_playwright

URL = os.environ["AUTOIN_BROWSER_URL"]
SHOP = os.environ["AUTOIN_BROWSER_SHOP"]
USER = os.environ["AUTOIN_BROWSER_USER"]
PASSWORD = os.environ["AUTOIN_BROWSER_PASSWORD"]
ORDER = os.environ["AUTOIN_BROWSER_ORDER"]


def browser_executable() -> str:
    path = next((p for name in (
        "google-chrome-stable", "google-chrome", "chromium", "chromium-browser"
    ) if (p := shutil.which(name))), None)
    if not path:
        raise RuntimeError("Chrome/Chromium binary missing; product browser NOT RUN")
    return path


def scenario(browser, width: int, height: int) -> None:
    mobile = width < 600
    context = browser.new_context(
        viewport={"width": width, "height": height},
        is_mobile=mobile, has_touch=mobile, locale="vi-VN"
    )
    page = context.new_page()
    print(f"PRODUCT BROWSER {width}x{height}: start", flush=True)
    runtime_errors: list[str] = []
    page.on("pageerror", lambda error: runtime_errors.append(str(error)))
    try:
        api = page.request.get(URL + "api/v1/orders")
        assert api.status == 401, "Anonymous users must not see any order"
        page.goto(URL, wait_until="networkidle", timeout=30_000)
        login = page.locator('[data-testid="staff-login"]')
        login.wait_for(state="visible", timeout=15_000)
        print(f"PRODUCT BROWSER {width}x{height}: staff login form visible", flush=True)
        assert page.locator('[data-testid="order-list"]').count() == 0, (
            "Cannot reveal product orders before staff login"
        )
        inputs = login.locator("input")
        assert inputs.count() == 3
        inputs.nth(0).fill(SHOP)
        inputs.nth(1).fill(USER)
        inputs.nth(2).fill(PASSWORD)
        login.locator("button[type=submit],button").first.click()
        print(f"PRODUCT BROWSER {width}x{height}: login submitted", flush=True)
        cards = page.locator('[data-testid="order-list"] .order-card')
        try:
            cards.filter(has_text=ORDER).wait_for(state="visible", timeout=12_000)
        except Exception:
            alert = page.locator('[data-testid="api-error"]')
            messages = alert.all_inner_texts()
            print(f"PRODUCT BROWSER {width}x{height}: order list unavailable; "
                  f"login_form_visible={login.is_visible()} "
                  f"order_list_present={page.locator('[data-testid=order-list]').count()} "
                  f"order_cards={cards.count()} "
                  f"safe_error_messages={messages[:2]}", flush=True)
            raise
        print(f"PRODUCT BROWSER {width}x{height}: real PG order visible", flush=True)
        mode = page.locator('[data-testid="operation-mode"]').inner_text()
        assert "CHƯA XÁC MINH" in mode, (
            "AI4 must fail closed until authoritative staff-mode API is wired"
        )
        assert page.locator(".simulation-note").count() == 0, (
            "VITE_DEMO_MODE must be false: product API mode only"
        )
        cards.filter(has_text=ORDER).click()
        detail = page.locator('[data-testid="order-detail"]')
        detail.locator(".detail-head h2").wait_for(state="visible")
        assert detail.locator(".detail-head h2").inner_text() == ORDER
        assert detail.locator('[data-testid="approve-action"]').is_disabled(), (
            "Product order without a verified print plan/preview must not be approved"
        )
        assert "chưa cấp" in detail.inner_text().lower() or (
            "chưa có" in detail.inner_text().lower()
        ), "Unverified document preview must be described as unavailable"
        assert page.locator('[data-testid="api-error"]').count() == 0, (
            "Authenticated product API unexpectedly failed"
        )
        overflow = page.evaluate(
            "() => ({scroll:document.documentElement.scrollWidth,width:window.innerWidth})"
        )
        assert overflow["scroll"] <= overflow["width"] + 1, (
            f"Product UI overflow {width}x{height}: {overflow}"
        )
        assert not runtime_errors, f"Browser page errors: {runtime_errors}"
        print(
            f"PASS REAL Chromium PRODUCT {width}x{height}: "
            "staff login, real PG order, no verified preview or approval, no overflow"
        )
    finally:
        context.close()


def main() -> int:
    assert URL.startswith("http://127.0.0.1:"), "Product browser must be localhost"
    assert SHOP.startswith("autoin-test-browser-"), "Synthetic scope required"
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            executable_path=browser_executable(), headless=True,
            args=["--no-sandbox", "--disable-dev-shm-usage"]
        )
        try:
            scenario(browser, 1440, 900)
            scenario(browser, 390, 844)
        finally:
            browser.close()
    print("BROWSER_SCOPE=real_Chromium+Fastify+PostgreSQL; OA/RICOH=NOT_RUN")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        # Do not print credentials, bearer tokens, or exception URL params.
        print(f"FAIL PRODUCT browser: {type(error).__name__}", file=sys.stderr)
        sys.exit(1)
