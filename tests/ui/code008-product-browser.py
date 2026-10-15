"""AI4 compiled production UI -> real localhost Fastify/PostgreSQL browser.

No page.route, route.fulfill, API response intercept, customer/OA/printer credentials
or runtime endpoint added. Called by code008-product-pg.mjs after isolated seed.
The 409/503 GET/error and stale-hash cases remain explicitly NOT RUN until
AI0 supplies a deterministic safe test-side failure/seed contract.
"""
import json
import os
import shutil
import sys
from playwright.sync_api import sync_playwright

URL = os.environ["AUTOIN_CODE008_URL"]
SHOP = os.environ["AUTOIN_CODE008_SHOP"]
USER = os.environ["AUTOIN_CODE008_USER"]
PASSWORD = os.environ["AUTOIN_CODE008_PASSWORD"]
ORDERS = json.loads(os.environ["AUTOIN_CODE008_ORDERS"])

CASES = ("clear", "processing0", "needs_human0", "pending1", "stale_revision",
         "api401", "offline")


def chrome_path():
    for binary in ("google-chrome-stable", "google-chrome", "chromium", "chromium-browser"):
        found = shutil.which(binary)
        if found:
            return found
    raise RuntimeError("NOT RUN: Chromium binary absent; AI0 CI must install it")


def scenario(browser, viewport, case):
    width, height = viewport
    mobile = width < 600
    context = browser.new_context(
        viewport={"width": width, "height": height},
        is_mobile=mobile, has_touch=mobile, locale="vi-VN"
    )
    page = context.new_page()
    browser_errors = []
    mutations = []
    details = []
    page.on("pageerror", lambda error: browser_errors.append(str(error)))

    def inspect(request):
        from urllib.parse import urlsplit
        path = urlsplit(request.url).path
        if path.startswith("/api/v1/orders/") and request.method == "GET":
            details.append(path)
        if path.startswith("/api/v1/") and request.method not in ("GET", "HEAD", "OPTIONS"):
            if not (path == "/api/v1/auth/login" and request.method == "POST"):
                mutations.append(request.method + " " + path)
    page.on("request", inspect)
    try:
        path = "?order_id=" + ORDERS["stale_revision"] + "&revision=1" if case == "stale_revision" else ""
        page.goto(URL + path, wait_until="domcontentloaded", timeout=20000)
        login = page.locator('[data-testid="staff-login"]')
        login.wait_for(state="visible", timeout=15000)
        assert page.locator('[data-testid="order-list"]').count() == 0
        fields = login.locator("input")
        assert fields.count() == 3
        fields.nth(0).fill(SHOP)
        fields.nth(1).fill(USER)
        fields.nth(2).fill(PASSWORD)
        login.locator("button").first.click()
        cards = page.locator('[data-testid="order-list"] .order-card')
        order_id = ORDERS["clear"] if case in ("api401", "offline") else ORDERS[case]
        card = cards.filter(has_text=order_id)
        card.wait_for(state="visible", timeout=15000)
        card.click()
        detail = page.locator('[data-testid="order-detail"]')
        detail.locator(".detail-head h2").filter(has_text=order_id).wait_for(
            state="visible", timeout=15000
        )
        inbound = detail.locator('[data-testid="code008-inbound"]')
        inbound.wait_for(state="visible", timeout=15000)
        if case == "clear":
            inbound.locator('[data-testid="code008-clear"]').wait_for(timeout=15000)
            assert "đúng mã đơn" in inbound.inner_text()
        elif case in ("processing0", "needs_human0", "pending1"):
            blocked = inbound.locator('[data-testid="code008-blocked"]')
            blocked.wait_for(timeout=15000)
            msg = blocked.inner_text()
            if case == "needs_human0":
                assert "CẦN NHÂN VIÊN ĐỐI SOÁT" in msg
            else:
                assert "ĐANG CHỜ AI XỬ LÝ" in msg
            expected_count = 1 if case == "pending1" else 0
            assert inbound.locator(".inbound-item").count() == expected_count
            if case == "pending1":
                assert "đã ghép vào đơn" not in inbound.inner_text().lower()
        elif case == "stale_revision":
            error = page.locator('[data-testid="api-error"]')
            error.wait_for(state="visible", timeout=15000)
            assert "Thông báo thuộc phiên bản 1" in error.inner_text()
            assert "phiên bản" in inbound.inner_text().lower()
        elif case == "api401":
            print("CONTROL REVOKE_SESSIONS", flush=True)
            assert sys.stdin.readline().strip() == "OK", "DB 401 fixture control unavailable"
            page.get_by_role("button", name="Làm mới dữ liệu").click()
            login.wait_for(state="visible", timeout=15000)
            assert page.locator('[data-testid="order-list"]').count() == 0
            assert page.locator('[data-testid="approve-action"]').count() == 0
        elif case == "offline":
            context.set_offline(True)
            try:
                page.get_by_role("button", name="Làm mới dữ liệu").click()
                error = page.locator('[data-testid="api-error"]')
                lock = page.locator('[data-testid="api-lock-banner"]')
                error.wait_for(state="visible", timeout=15000)
                lock.wait_for(state="visible", timeout=15000)
                assert error.count() == lock.count() == 1
                assert "Mất kết nối API" in error.inner_text()
                assert "tạm khóa" in lock.inner_text()
                unknown = inbound.locator('[data-testid="code008-blocked"]')
                unknown.wait_for(state="visible", timeout=15000)
                assert "CHƯA XÁC ĐỊNH" in unknown.inner_text()
            finally:
                context.set_offline(False)
        if case != "api401":
            approve = detail.locator('[data-testid="approve-action"]')
            assert approve.is_disabled(), "Unconfirmed order is unexpectedly approvable"
        assert details, "No authenticated real Fastify GET order detail was observed"
        assert not mutations, "Unexpected browser mutation requests: " + repr(mutations)
        assert not browser_errors, "Page exception: " + repr(browser_errors[:1])
        print(f"PASS REAL CODE008 Chromium {width}x{height} {case} "
              f"GET_detail={len(details)} mutation=0", flush=True)
    finally:
        context.close()


def main():
    if not URL.startswith("http://127.0.0.1:"):
        raise RuntimeError("Must only connect to an isolated localhost Fastify")
    if not SHOP.startswith("autoin-test-code008-browser-"):
        raise RuntimeError("Not an isolated synthetic test shop")
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            executable_path=chrome_path(), headless=True,
            args=["--no-sandbox", "--disable-dev-shm-usage"]
        )
        try:
            for viewport in ((1440, 900), (390, 844)):
                for case in CASES:
                    scenario(browser, viewport, case)
        finally:
            browser.close()
    print("PASS REAL CODE008 Fastify/PostgreSQL Chromium: 14 viewport-scenarios; "
          "API 409/503/stale-hash=NOT_RUN; iPhone Safari=NOT_RUN", flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Credentials are never included in error messages.
        print("FAIL/NOT RUN CODE008 product browser: " + type(error).__name__ +
              ": " + str(error)[:240], file=sys.stderr)
        sys.exit(1)
