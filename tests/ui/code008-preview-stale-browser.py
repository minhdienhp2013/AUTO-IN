"""AI4 CODE-008: product-backed Chromium stale AI3-sealed preview gate.

AI0 owns the real Fastify/PostgreSQL/AI3 artifact fixture from PR #108,
including an external test-only controller. This file does NOT seed
manifests, forge API responses, bypass auth or change Core/composition.

AI0 passes AUTOIN_CODE008_PREVIEW_URL (localhost), SHOP/USER/PASSWORD and
AUTOIN_CODE008_PREVIEW_ORDERS JSON mapping desktop/mobile to two isolated
revision-2 orders with genuine AI3-sealed preview catalogs + PNGs.

Protocol on stdout/stdin (each viewport):
  CONTROL REVISE desktop|mobile
  <parent genuine authenticated Core POST 2->3, validates hash/anchor; replies OK>
The browser itself must subsequently GET the OLD /revisions/2/previews
and receive HTTP409 STALE_OR_UNVERIFIED_PREVIEW. No page.route or response
interception; never rerun existing 14 Chromium or 2 order-detail-503 cases.
"""
import json
import os
import re
import shutil
import sys
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright

BASE = os.environ["AUTOIN_CODE008_PREVIEW_URL"]
SHOP = os.environ["AUTOIN_CODE008_PREVIEW_SHOP"]
USER = os.environ["AUTOIN_CODE008_PREVIEW_USER"]
PASSWORD = os.environ["AUTOIN_CODE008_PREVIEW_PASSWORD"]
ORDERS = json.loads(os.environ["AUTOIN_CODE008_PREVIEW_ORDERS"])

def chrome_path():
    for candidate in ("google-chrome-stable", "google-chrome",
                      "chromium", "chromium-browser"):
        found = shutil.which(candidate)
        if found:
            return found
    raise RuntimeError("NOT RUN: Chromium unavailable in AI0 fixture job")

def scenario(browser, viewport, device):
    width, height = viewport
    order_id = ORDERS[device]
    old_catalog = ("/api/v1/orders/" + order_id +
                   "/revisions/2/previews")
    mobile = width < 600
    context = browser.new_context(
        viewport={"width": width, "height": height},
        is_mobile=mobile, has_touch=mobile, locale="vi-VN"
    )
    page = context.new_page()
    responses = []
    mutations = []
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))

    def on_response(response):
        if response.request.method == "GET":
            responses.append((urlsplit(response.url).path, response.status))

    def on_request(request):
        path = urlsplit(request.url).path
        if (path.startswith("/api/v1/") and
                request.method not in ("GET", "HEAD", "OPTIONS") and
                not (path == "/api/v1/auth/login" and request.method == "POST")):
            mutations.append(request.method + " " + path)

    page.on("request", on_request)
    page.on("response", on_response)
    try:
        page.goto(BASE, wait_until="domcontentloaded", timeout=20000)
        login = page.locator('[data-testid="staff-login"]')
        login.wait_for(state="visible", timeout=15000)
        fields = login.locator("input")
        assert fields.count() == 3
        fields.nth(0).fill(SHOP)
        fields.nth(1).fill(USER)
        fields.nth(2).fill(PASSWORD)
        login.locator("button").first.click()
        cards = page.locator('[data-testid="order-list"] .order-card')
        card = cards.filter(has_text=order_id)
        card.wait_for(state="visible", timeout=15000)
        card.click()
        detail = page.locator('[data-testid="order-detail"]')
        detail.locator(".detail-head h2").filter(
            has_text=order_id).wait_for(state="visible", timeout=15000)
        gallery = detail.locator('[data-testid="verified-preview-gallery"]')
        gallery.locator('[data-testid="verified-preview-image"]').first.wait_for(
            state="visible", timeout=20000)
        assert (old_catalog, 200) in responses, (
            "Real AI3-sealed preview catalog GET200 not observed")
        assert (old_catalog + "/0", 200) in responses, (
            "Real AI3-sealed preview PNG GET200 not observed")
        assert "phiên bản 2" in gallery.inner_text().lower()
        approve = detail.locator('[data-testid="approve-action"]')
        assert approve.is_disabled(), "Preview never substitutes customer confirmation"

        # Switching away removes the old gallery and revokes its local blob URL.
        page.get_by_role("tab", name=re.compile("Lịch sử")).click()
        assert detail.locator('[data-testid="verified-preview-image"]').count() == 0

        # The AI0 controller advances the REAL Core order, never PostgreSQL
        # tampering / fake hash: revision 2 -> 3, old sealed anchor unchanged.
        print("CONTROL REVISE " + device, flush=True)
        assert sys.stdin.readline().strip() == "OK", (
            "AI0-owned genuine Core revision fixture not available")

        # React is still on the previously loaded revision-2 order until a
        # deliberate refresh; reopening the tab must issue a real stale GET409.
        with page.expect_response(
                lambda r: (r.request.method == "GET" and
                           urlsplit(r.url).path == old_catalog and
                           r.status == 409),
                timeout=20000) as stale:
            page.get_by_role("tab", name="Tài liệu & duyệt").click()
        body = stale.value.json()
        assert body.get("error", {}).get("code") == "STALE_OR_UNVERIFIED_PREVIEW"
        gallery.locator('[data-testid="preview-unavailable"]').wait_for(
            state="visible", timeout=15000)
        assert gallery.locator('[data-testid="verified-preview-image"]').count() == 0
        assert gallery.locator('[data-testid="verified-document-list"]').count() == 0
        assert "Không dùng ảnh thiếu tin cậy" in gallery.inner_text()
        assert approve.is_disabled(), "Stale 409 must never unlock approval"

        # Once staff reloads, React must use revision 3 and never show the
        # previous revision-2 raster as currently verified.
        current_detail = "/api/v1/orders/" + order_id
        with page.expect_response(
                lambda r: (r.request.method == "GET" and
                           urlsplit(r.url).path == current_detail and
                           r.status == 200),
                timeout=20000):
            page.get_by_role("button", name="Làm mới dữ liệu").click()
        detail.locator('[data-testid="code008-revision"]').filter(
            has_text="3").wait_for(state="visible", timeout=15000)
        gallery = detail.locator('[data-testid="verified-preview-gallery"]')
        gallery.locator('[data-testid="preview-unavailable"]').wait_for(
            state="visible", timeout=15000)
        assert gallery.locator('[data-testid="verified-preview-image"]').count() == 0
        assert approve.is_disabled(), "Revision 3 still lacks customer confirmation"
        assert mutations == [], "Browser attempted business mutation: " + repr(mutations)
        assert errors == [], "Browser page exception: " + repr(errors)
        print("PASS REAL CODE008 Chromium " + str(width) + "x" + str(height) +
              " preview_stale catalog=200 png=200 -> catalog=409 " +
              "STALE_OR_UNVERIFIED_PREVIEW stale_image_removed=true " +
              "reloaded_revision=3 approve_disabled=true browser_mutation=0",
              flush=True)
    finally:
        context.close()

def main():
    assert BASE.startswith("http://127.0.0.1:") and BASE.endswith("/"), (
        "Only disposable localhost authenticated Fastify allowed")
    assert SHOP.startswith("autoin-test-preview-ui-"), (
        "Shop must be an isolated AI0 browser fixture")
    assert set(ORDERS) == {"desktop", "mobile"} and (
        ORDERS["desktop"] != ORDERS["mobile"]), (
        "AI0 must provide distinct sealed revision-2 orders for two viewports")
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            executable_path=chrome_path(), headless=True,
            args=["--no-sandbox", "--disable-dev-shm-usage"])
        try:
            scenario(browser, (1440, 900), "desktop")
            scenario(browser, (390, 844), "mobile")
        finally:
            browser.close()
    print("PASS REAL CODE008 AI3 sealed preview browser: 2 viewport cases; "
          "physical Safari/OA/Ricoh/TN037=NOT_RUN", flush=True)

if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("FAIL/NOT RUN AI4 stale preview Chromium: " +
              type(error).__name__ + ": " + str(error)[:260],
              file=sys.stderr)
        sys.exit(1)
