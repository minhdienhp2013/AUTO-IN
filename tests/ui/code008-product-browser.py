"""AI4 compiled production UI -> real localhost Fastify/PostgreSQL browser.

No page.route, route.fulfill, API response intercept, customer/OA/printer credentials
or runtime endpoint added. Called by code008-product-pg.mjs after isolated seed.
Optional order_detail_503 mode tests real authenticated GET503 and recovery;
other 409/503 preview or stale hash cases remain separate from browser PASS.
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
    auth_failures = []
    page.on("pageerror", lambda error: browser_errors.append(str(error)))
    page.on("response", lambda response: auth_failures.append(response.status)
            if response.status == 401 and "/api/v1/" in response.url else None)

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
        # A mobile deep-link hides the order list automatically. Verify the
        # card is attached, not visible; do not click away the stale revision.
        if case == "stale_revision":
            card.wait_for(state="attached", timeout=15000)
        else:
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
            pending_label = inbound.locator('[data-testid="code008-pending-count"]')
            assert pending_label.count() == 1
            state_name = "needs_human" if case == "needs_human0" else "processing"
            assert state_name in pending_label.inner_text()
            if case == "pending1":
                assert "Có 1 tin/file chưa xử lý" in pending_label.inner_text()
                assert "Tệp tin cần đối soát" in inbound.inner_text()
                assert "đã ghép vào đơn" not in inbound.inner_text().lower()
            else:
                assert "Chưa có mục được liệt kê" in pending_label.inner_text()
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
            assert 401 in auth_failures, "Real Fastify 401 response was not observed"
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



def order_detail_503(browser, viewport):
    """Exercise one real Core read-model 503, not a preview/API mock response."""
    from urllib.parse import urlsplit

    width, height = viewport
    mobile = width < 600
    context = browser.new_context(
        viewport={"width": width, "height": height},
        is_mobile=mobile, has_touch=mobile, locale="vi-VN"
    )
    page = context.new_page()
    order_id = ORDERS["clear"]
    endpoint = "/api/v1/orders/" + order_id
    mutations = []
    page_errors = []
    page.on("pageerror", lambda error: page_errors.append(str(error)))

    def is_detail(response, status):
        return (urlsplit(response.url).path == endpoint and
                response.request.method == "GET" and response.status == status)

    def inspect(request):
        path = urlsplit(request.url).path
        if path.startswith("/api/v1/") and request.method not in ("GET", "HEAD", "OPTIONS"):
            if not (path == "/api/v1/auth/login" and request.method == "POST"):
                mutations.append(request.method + " " + path)

    page.on("request", inspect)
    locked = False
    try:
        page.goto(URL, wait_until="domcontentloaded", timeout=20000)
        login = page.locator('[data-testid="staff-login"]')
        login.wait_for(state="visible", timeout=15000)
        fields = login.locator("input")
        assert fields.count() == 3
        fields.nth(0).fill(SHOP)
        fields.nth(1).fill(USER)
        fields.nth(2).fill(PASSWORD)
        login.locator("button").first.click()
        card = page.locator('[data-testid="order-list"] .order-card').filter(has_text=order_id)
        card.wait_for(state="visible", timeout=15000)
        card.click()
        detail = page.locator('[data-testid="order-detail"]')
        detail.locator(".detail-head h2").filter(has_text=order_id).wait_for(
            state="visible", timeout=15000
        )
        inbound = detail.locator('[data-testid="code008-inbound"]')
        inbound.locator('[data-testid="code008-clear"]').wait_for(
            state="visible", timeout=15000
        )
        approve = detail.locator('[data-testid="approve-action"]')
        assert approve.is_disabled(), "Unconfirmed test order must stay disabled"

        print("CONTROL LOCK_ORDER_DETAIL", flush=True)
        assert sys.stdin.readline().strip() == "OK", "isolated PG lock control missing"
        locked = True
        try:
            with page.expect_response(lambda r: is_detail(r, 503), timeout=20000) as failed:
                page.get_by_role("button", name="Làm mới dữ liệu").click()
            fault = failed.value.json()
            assert fault.get("error", {}).get("code") == "PENDING_READ_UNAVAILABLE", (
                "Real GET order-detail was 503 but not Core PENDING_READ_UNAVAILABLE"
            )
            api_error = page.locator('[data-testid="api-error"]')
            api_lock = page.locator('[data-testid="api-lock-banner"]')
            blocked = inbound.locator('[data-testid="code008-blocked"]')
            api_error.wait_for(state="visible", timeout=15000)
            api_lock.wait_for(state="visible", timeout=15000)
            blocked.wait_for(state="visible", timeout=15000)
            assert api_error.count() == api_lock.count() == 1, (
                "API error and write-lock banner must remain separate"
            )
            assert "tạm khóa" in api_lock.inner_text()
            assert "CHƯA XÁC ĐỊNH" in blocked.inner_text()
            assert inbound.locator('[data-testid="code008-clear"]').count() == 0, (
                "Cached server CLEAR must be hidden on genuine GET503"
            )
            assert approve.is_disabled(), "Approval enabled while API details unavailable"
        finally:
            print("CONTROL RELEASE_ORDER_DETAIL", flush=True)
            assert sys.stdin.readline().strip() == "OK", "PostgreSQL ROLLBACK control failed"
            locked = False

        with page.expect_response(lambda r: is_detail(r, 200), timeout=20000):
            page.get_by_role("button", name="Làm mới dữ liệu").click()
        inbound.locator('[data-testid="code008-clear"]').wait_for(
            state="visible", timeout=15000
        )
        assert page.locator('[data-testid="api-error"]').count() == 0
        assert page.locator('[data-testid="api-lock-banner"]').count() == 0
        assert approve.is_disabled(), "Recovery must not bypass customer confirmation"
        assert not mutations, "Business HTTP mutation attempted: " + repr(mutations)
        assert not page_errors, "Page exception: " + repr(page_errors[:1])
        print(f"PASS REAL CODE008 Chromium {width}x{height} order_detail_503 "
              "GET=503 PENDING_READ_UNAVAILABLE rollback_recovery=200 "
              "api_error=1 api_lock_banner=1 blocked=1 approve_disabled=true "
              "stale_clear_hidden=true mutation=0", flush=True)
    finally:
        if locked:
            # Node parent also releases the PG transaction on browser exit.
            print("CONTROL RELEASE_ORDER_DETAIL", flush=True)
            sys.stdin.readline()
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
            mode = os.environ.get('AUTOIN_CODE008_BROWSER_MODE', '')
            if mode == 'order_detail_503':
                for viewport in ((1440, 900), (390, 844)):
                    order_detail_503(browser, viewport)
            elif mode == '':
                for viewport in ((1440, 900), (390, 844)):
                    for case in CASES:
                        scenario(browser, viewport, case)
            else:
                raise RuntimeError('Unexpected CODE008 browser mode')
        finally:
            browser.close()
    if os.environ.get("AUTOIN_CODE008_BROWSER_MODE") == "order_detail_503":
        print("PASS REAL CODE008 Browser 503: 2 viewport-scenarios; "
              "GET 409/order preview=NOT_RUN; iPhone Safari=NOT_RUN", flush=True)
    else:
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
