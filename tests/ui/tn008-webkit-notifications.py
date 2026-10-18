"""TN008-WEBKIT-REGRESSION-01.

Real Playwright WebKit renders the built React application. Notification
permissions, service-worker registration, and existing staff API responses
are EXPLICITLY SYNTHETIC fixtures except for the read-only native_probe.
Not evidence of real iOS Safari, OS permission, Push subscription/delivery,
live Fastify, Zalo OA or printers. No external requests are allowed.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import traceback
from urllib.error import URLError
from urllib.parse import urlsplit
from urllib.request import urlopen

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[2]
WEB = ROOT / "web"
URL = "http://127.0.0.1:4175/"
TOKEN = "tn008-synthetic-session-only"
SHOP = "tn008-synthetic-shop"
ROLE = {"id": "tn008-synthetic-owner", "shop_id": SHOP, "role": "owner", "verified": True}
NOTICE = "Web Push thật chưa được kết nối; thông báo sẽ mở đúng đơn sau khi có backend phát Push được xác thực."
MESSAGES = {
    "unsupported": "Trình duyệt hoặc kết nối HTTPS chưa hỗ trợ thông báo",
    "default": "Chưa cấp quyền thông báo",
    "denied": "Đã từ chối quyền — kiểm tra cài đặt trình duyệt",
    "granted": "Đã cấp quyền, chưa nối Web Push",
    "rejected": "Yêu cầu quyền thất bại. Có thể thử lại; Web Push chưa kết nối.",
}
CASES = (
    "native_probe", "unsupported_no_notification", "unsupported_missing_method",
    "unsupported_insecure", "denied", "default", "granted",
    "granted_on_click", "rejected_then_retry", "rejected_to_denied",
)
VIEWPORTS = ((1440, 900), (390, 844))

# Installed before any app scripts. This is NOT a real OS permission or
# push registration. Calling subscribe records an unsafe attempt and fails.
INIT = r"""
(() => {
  const scenario = __TN008_CASE__;
  const stats = { permissionCalls: 0, subscribeCalls: 0 };
  Object.defineProperty(window, "__tn008", { configurable: true, value: stats });
  if (scenario === "unsupported_insecure") {
    Object.defineProperty(window, "isSecureContext",
                          { configurable: true, value: false });
  }
  const registration = { pushManager: {
    getSubscription: async () => null,
    subscribe: async () => {
      stats.subscribeCalls++;
      throw new Error("Unapproved Web Push subscription");
    }
  } };
  const sw = {
    register: async () => registration,
    get ready() { return Promise.resolve(registration); }
  };
  Object.defineProperty(navigator, "serviceWorker",
                        { configurable: true, value: sw });
  if (scenario === "unsupported_no_notification") {
    Object.defineProperty(window, "Notification",
                          { configurable: true, value: undefined });
    return;
  }
  let permission = scenario === "denied" ? "denied" :
                   scenario === "granted" ? "granted" : "default";
  const notification = function SyntheticNotification() {};
  Object.defineProperty(notification, "permission", {
    configurable: true, get: () => permission
  });
  if (scenario !== "unsupported_missing_method") {
    notification.requestPermission = async () => {
      stats.permissionCalls++;
      if (scenario === "granted_on_click") {
        permission = "granted";
        return "granted";
      }
      if (scenario === "rejected_then_retry") {
        if (stats.permissionCalls === 1) throw Error("synthetic rejection");
        permission = "granted";
        return "granted";
      }
      if (scenario === "rejected_to_denied") {
        permission = "denied";
        throw Error("synthetic denial");
      }
      return permission;
    };
  }
  Object.defineProperty(window, "Notification", {
    configurable: true, writable: true, value: notification
  });
})();
"""


def initial_expectation(case, native):
    if case == "native_probe":
        supports = native["secure"] and native["serviceWorker"] and native["requestMethod"]
        if not supports or native["permission"] not in ("default", "denied", "granted"):
            return "unsupported", False
        state = native["permission"]
        return state, state == "default"
    if case.startswith("unsupported_"):
        return "unsupported", False
    if case in ("denied", "granted"):
        return case, False
    return "default", True


def run_case(browser, viewport, case, evidence):
    width, height = viewport
    context = browser.new_context(
        viewport={"width": width, "height": height},
        is_mobile=width < 600, has_touch=width < 600, locale="vi-VN"
    )
    page = context.new_page()
    errors, unauthorized_mutations, push_calls = [], [], []
    calls = {"login": 0}
    page.on("pageerror", lambda e: errors.append(str(e)))
    if case != "native_probe":
        page.add_init_script(INIT.replace("__TN008_CASE__", json.dumps(case)))

    def local_only(route):
        if urlsplit(route.request.url).hostname not in ("127.0.0.1", "localhost"):
            route.abort("blockedbyclient")
        else:
            route.continue_()

    def api(route):
        request = route.request
        path = urlsplit(request.url).path.split("/api/v1/", 1)[-1]
        if any(term in path for term in ("push", "subscription", "notification", "vapid")):
            push_calls.append(path)
        def send(data, status=200):
            route.fulfill(status=status, content_type="application/json",
                          headers={"Cache-Control": "no-store"},
                          body=json.dumps(data, ensure_ascii=False))
        if request.method not in ("GET", "HEAD", "OPTIONS") and not (
            path == "auth/login" and request.method == "POST"
        ):
            unauthorized_mutations.append(request.method + " " + path)
        if path == "auth/login" and request.method == "POST":
            calls["login"] += 1
            send({"token": TOKEN, "principal": ROLE})
        elif request.headers.get("authorization") != "Bearer " + TOKEN:
            send({"error": {"code": "SYNTHETIC_401"}}, 401)
        elif path == "auth/me" and request.method == "GET":
            send({"principal": ROLE})
        elif path == "orders" and request.method == "GET":
            send({"orders": []})
        elif path == "settings/schedule" and request.method == "GET":
            send({"shop_id": SHOP, "version": 1, "open_at": "07:00",
                  "close_at": "21:30", "timezone": "Asia/Ho_Chi_Minh",
                  "holiday_dates": [], "manual_lock": False,
                  "operational_guard": {"mode": "simulation", "printing_enabled": False}})
        else:
            send({"error": {"code": "SYNTHETIC_NO_BACKEND"}}, 503)

    # Page API mocks are for login/schedule navigation ONLY, never Push.
    context.route("**/*", local_only)
    page.route("**/api/v1/**", api)
    try:
        page.goto(URL, wait_until="domcontentloaded", timeout=20000)
        login = page.locator('[data-testid="staff-login"]')
        expect(login).to_be_visible(timeout=15000)
        inputs = login.locator("input")
        assert inputs.count() == 3
        for i, value in enumerate((SHOP, "fixture-owner", "not-a-secret")):
            inputs.nth(i).fill(value)
        login.locator("button").first.click()
        settings = page.get_by_role("button", name="Cài đặt & lịch")
        settings.wait_for(state="attached", timeout=15000)
        if width < 600:
            page.get_by_role("button", name="Mở menu").click()
        settings.click()
        box = page.locator(".settings-box").filter(
            has=page.get_by_role("heading", name="Thông báo thiết bị")
        )
        expect(box).to_be_visible(timeout=15000)
        status = box.locator(".setting-heading p")
        notice = box.locator("p").filter(has_text=NOTICE)
        assert status.count() == 1
        expect(notice).to_have_text(NOTICE)
        native = None
        if case == "native_probe":
            native = page.evaluate("""() => ({
                secure: window.isSecureContext,
                serviceWorker: 'serviceWorker' in navigator,
                requestMethod: typeof window.Notification?.requestPermission === 'function',
                permission: window.Notification?.permission ?? null
            })""")
        state, enabled = initial_expectation(case, native)
        expect(status).to_have_text(MESSAGES[state])
        button = box.get_by_role("button", name="Yêu cầu quyền thiết bị")
        assert button.count() == 1
        if enabled:
            expect(button).to_be_enabled()
        else:
            expect(button).to_be_disabled()
        if case != "native_probe":
            assert page.evaluate("() => window.__tn008.permissionCalls") == 0, (
                "Unexpected automatic notification permission prompt"
            )

        if case == "default":
            button.click()
            expect(status).to_have_text(MESSAGES["default"])
            expect(button).to_be_enabled()
        elif case == "granted_on_click":
            button.click()
            expect(status).to_have_text(MESSAGES["granted"])
            expect(button).to_be_disabled()
        elif case == "rejected_then_retry":
            button.click()
            alert = box.get_by_role("alert")
            expect(alert).to_have_text(MESSAGES["rejected"])
            retry = box.get_by_role("button", name="Thử lại yêu cầu quyền")
            expect(retry).to_be_enabled()
            retry.click()
            expect(status).to_have_text(MESSAGES["granted"])
            assert box.get_by_role("alert").count() == 0
            expect(box.get_by_role("button", name="Yêu cầu quyền thiết bị")).to_be_disabled()
        elif case == "rejected_to_denied":
            button.click()
            expect(status).to_have_text(MESSAGES["denied"])
            expect(box.get_by_role("button", name="Yêu cầu quyền thiết bị")).to_be_disabled()

        if case != "native_probe":
            stats = page.evaluate("() => window.__tn008")
            n = 2 if case == "rejected_then_retry" else (
                1 if case in ("default", "granted_on_click", "rejected_to_denied") else 0
            )
            assert stats["permissionCalls"] == n, stats
            assert stats["subscribeCalls"] == 0, "Automatic subscription was attempted"
        expect(notice).to_have_text(NOTICE)
        assert calls["login"] == 1
        assert not unauthorized_mutations, unauthorized_mutations
        assert not push_calls, push_calls
        assert not errors, errors
        evidence.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(evidence / f"{width}x{height}-{case}.png"), full_page=True)
        print(f"PASS TN008 WEBKIT {width}x{height} case={case} "
              f"state={state} permission_fixture={case != 'native_probe'} "
              "push_subscribe=0 push_backend=0 mutations=0", flush=True)
    except BaseException:
        print(f"FAIL TN008 WEBKIT {width}x{height} case={case}", flush=True)
        traceback.print_exc()
        raise
    finally:
        context.close()


def main():
    if not (WEB / "dist" / "index.html").is_file():
        raise RuntimeError("NOT RUN: build VITE_DEMO_MODE=false web/dist first")
    vite = WEB / "node_modules" / ".bin" / "vite"
    if not vite.is_file():
        raise RuntimeError("NOT RUN: run web/npm ci first")
    evidence = Path(os.environ.get(
        "AUTOIN_TN008_EVIDENCE_DIR", "/tmp/autoin-tn008-webkit-evidence"
    ))
    with sync_playwright() as playwright:
        if not Path(playwright.webkit.executable_path).exists():
            raise RuntimeError("NOT RUN: WebKit binary absent; AI0 must provision Playwright WebKit")
        browser = playwright.webkit.launch(headless=True)
        try:
            with socket.socket() as sock:
                if sock.connect_ex(("127.0.0.1", 4175)) == 0:
                    raise RuntimeError("Refusing existing server on localhost:4175")
            process = subprocess.Popen(
                [str(vite), "preview", "--host", "127.0.0.1",
                 "--port", "4175", "--strictPort"],
                cwd=WEB, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
            )
            try:
                for _ in range(80):
                    if process.poll() is not None:
                        raise RuntimeError("Vite preview exited before ready")
                    try:
                        with urlopen(URL, timeout=1) as response:
                            if response.status == 200:
                                break
                    except (URLError, OSError):
                        time.sleep(0.25)
                else:
                    raise RuntimeError("Vite preview did not start")
                for viewport in VIEWPORTS:
                    for case in CASES:
                        run_case(browser, viewport, case, evidence)
            finally:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
        finally:
            browser.close()
    print("PASS TN008 WEBKIT 20 synthetic/native-probe browser cases; "
          "physical_iPhone_Safari=NOT_RUN; Web_Push_delivery=NOT_RUN; "
          "real_subscription=NOT_RUN; real_Push_backend=NOT_RUN")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        print("FAIL/NOT RUN TN008 WEBKIT: "
              + type(e).__name__ + ": " + str(e)[:400], file=sys.stderr)
        sys.exit(1)
