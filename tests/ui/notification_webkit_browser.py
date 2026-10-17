"""TN008-WEBKIT-REGRESSION-01: real WebKit renderer + synthetic Notification/API.

This runs the VITE_DEMO_MODE=false production React bundle at localhost with
Playwright WebKit. Only notification permission states are synthetic; this is
NOT Safari on iPhone, an actual OS permission prompt, Web Push subscription,
backend push delivery, Zalo OA, or a real physical device test.

Usage: cd web && npm ci && VITE_DEMO_MODE=false npm run build && \
       npm run test:webkit:notifications
Requires Python playwright==1.58.0 and `python -m playwright install --with-deps webkit`
in an AI0-approved Linux CI job; do not change the root workflow here.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
from urllib.error import URLError
from urllib.request import urlopen

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
WEB = ROOT / "web"
PORT = int(os.environ.get("AUTO_IN_WEBKIT_PORT", "4175"))
URL = f"http://127.0.0.1:{PORT}/"
TOKEN = "synthetic-webkit-only-token"
SHOP = "synthetic-webkit-only-shop"

EXPLANATION = (
    "Web Push thật chưa được kết nối; thông báo sẽ mở đúng đơn "
    "sau khi có backend phát Push được xác thực."
)
STATUS = {
    "unsupported": "Trình duyệt hoặc kết nối HTTPS chưa hỗ trợ thông báo",
    "denied": "Đã từ chối quyền — kiểm tra cài đặt trình duyệt",
    "default": "Chưa cấp quyền thông báo",
    "granted": "Đã cấp quyền, chưa nối Web Push",
    "rejected": "Yêu cầu quyền thất bại. Có thể thử lại; Web Push chưa kết nối.",
}
# Three unsupported capabilities + all permission outcomes and retry/busy flows.
CASES = (
    "unsupported_notification", "unsupported_no_prompt", "unsupported_insecure",
    "denied", "default", "default_stays", "granted",
    "rejected", "reject_then_retry", "pending_no_duplicate",
)


def fixture_script(case: str) -> str:
    return f"""(() => {{
      const scenario = {json.dumps(case)};
      const probe = {{ calls: 0, subscriptionCalls: 0, resolve: null }};
      Object.defineProperty(window, '__notificationProbe', {{configurable:true, value:probe}});
      const fake = {{ permission: (scenario==='denied'?'denied':scenario==='granted'?'granted':'default') }};
      if (scenario !== 'unsupported_no_prompt') fake.requestPermission = () => {{
        probe.calls += 1;
        if (scenario==='rejected') return Promise.reject(new Error('synthetic browser refusal'));
        if (scenario==='reject_then_retry' && probe.calls===1)
          return Promise.reject(new Error('synthetic browser refusal'));
        if (scenario==='pending_no_duplicate') return new Promise(resolve=>{{
          probe.resolve = (value) => {{ fake.permission=value; resolve(value); }};
        }});
        if (scenario==='default_stays') return Promise.resolve('default');
        fake.permission='granted';
        return Promise.resolve('granted');
      }};
      Object.defineProperty(window,'Notification',{{configurable:true,
         value:scenario==='unsupported_notification'?undefined:fake}});
      if (scenario==='unsupported_insecure')
        Object.defineProperty(window,'isSecureContext',{{configurable:true, value:false}});
      // WebKit on Linux might not expose serviceWorker in a disposable context.
      // Supply only the capability surface needed by the UI, never a PushManager.
      if (!('serviceWorker' in navigator))
        Object.defineProperty(navigator,'serviceWorker',{{configurable:true,
          value:{{register:()=>Promise.resolve({{}})}}}});
      if ('PushManager' in window && window.PushManager?.prototype?.subscribe) {{
        const original=window.PushManager.prototype.subscribe;
        window.PushManager.prototype.subscribe=function(...args) {{
          probe.subscriptionCalls += 1;
          throw new Error('Subscription must not be invoked by this UI');
        }};
      }}
    }})();"""


def run_case(browser, viewport: tuple[int, int], case: str) -> None:
    width, height = viewport
    context = browser.new_context(
        viewport={"width": width, "height": height},
        is_mobile=width < 600, has_touch=width < 600, locale="vi-VN",
    )
    context.add_init_script(script=fixture_script(case))
    page = context.new_page()
    errors: list[str] = []
    counts = {"login": 0, "mutation": 0, "push_endpoint": 0}
    page.on("pageerror", lambda e: errors.append(str(e)))

    def api(route) -> None:
        request = route.request
        path = request.url.split("/api/v1/", 1)[-1].split("?", 1)[0]

        def reply(body: dict, status: int = 200) -> None:
            route.fulfill(
                status=status,
                body=json.dumps(body, ensure_ascii=False),
                content_type="application/json",
                headers={"Cache-Control": "no-store"},
            )

        if "push" in path or "subscription" in path:
            counts["push_endpoint"] += 1
        if path == "auth/login" and request.method == "POST":
            counts["login"] += 1
            reply({"token": TOKEN, "principal": {"id": "synthetic-webkit-user",
                  "shop_id": SHOP, "role": "owner", "verified": True}})
        elif request.headers.get("authorization") != f"Bearer {TOKEN}":
            reply({"error": {"code": "UNAUTHENTICATED"}}, 401)
        elif path == "auth/me" and request.method == "GET":
            reply({"principal": {"id": "synthetic-webkit-user",
                  "shop_id": SHOP, "role": "owner", "verified": True}})
        elif path == "orders" and request.method == "GET":
            reply({"orders": []})
        elif path == "settings/schedule" and request.method == "GET":
            reply({"shop_id": SHOP, "version": 1, "open_at": "07:00",
                   "close_at": "21:30", "timezone": "Asia/Ho_Chi_Minh",
                   "manual_lock": False, "holiday_dates": [],
                   "operational_guard": {"mode": "simulation", "printing_enabled": False}})
        elif request.method not in ("GET", "HEAD", "OPTIONS"):
            counts["mutation"] += 1
            reply({"error": {"code": "SYNTHETIC_BLOCKED"}}, 409)
        else:
            reply({"error": {"code": "SYNTHETIC_NOT_AVAILABLE"}}, 503)

    def attempts() -> int:
        return page.evaluate("window.__notificationProbe.calls")

    def wait_label(locator, expected: str) -> None:
        locator.wait_for(state="visible", timeout=10000)
        assert locator.inner_text() == expected, f"wrong permission wording: {locator.inner_text()!r}"

    try:
        page.route("**/api/v1/**", api)
        page.goto(URL, wait_until="domcontentloaded", timeout=20000)
        login = page.locator('[data-testid="staff-login"]')
        login.wait_for(state="visible", timeout=15000)
        inputs = login.locator("input")
        assert inputs.count() == 3
        for i, text in enumerate((SHOP, "fixture-owner", "no-real-password")):
            inputs.nth(i).fill(text)
        login.locator("button").first.click()
        menu_entry = page.get_by_role("button", name="Cài đặt & lịch")
        menu_entry.wait_for(state="attached", timeout=15000)
        if width < 600:
            page.get_by_role("button", name="Mở menu").click()
        menu_entry.click()
        card = page.locator(".settings-box").filter(has_text="Thông báo thiết bị")
        card.wait_for(state="visible", timeout=15000)
        label = card.locator(".setting-heading p")
        button = card.locator("button.outline-btn")
        wait_label(card.locator(":scope > p"), EXPLANATION)
        assert attempts() == 0, "requestPermission called on page load/settings open"

        if case.startswith("unsupported_"):
            wait_label(label, STATUS["unsupported"])
            assert button.is_disabled()
        elif case == "denied":
            wait_label(label, STATUS["denied"])
            assert button.is_disabled()
        elif case == "granted":
            wait_label(label, STATUS["granted"])
            assert button.is_disabled()
        else:
            wait_label(label, STATUS["default"])
            assert button.is_enabled()
            assert button.inner_text() == "Yêu cầu quyền thiết bị"
            button.click()
            if case == "pending_no_duplicate":
                page.get_by_role("button", name="Đang yêu cầu quyền…").wait_for(
                    state="visible", timeout=10000)
                assert button.is_disabled(), "permission request must be single-flight"
                button.evaluate("element => element.click()")
                assert attempts() == 1, "disabled repeated click requested twice"
                page.evaluate("window.__notificationProbe.resolve('granted')")
                wait_label(label, STATUS["granted"])
            elif case in ("rejected", "reject_then_retry"):
                wait_label(label, STATUS["rejected"])
                assert label.get_attribute("role") == "alert"
                assert button.inner_text() == "Thử lại yêu cầu quyền"
                assert button.is_enabled()
                if case == "reject_then_retry":
                    button.click()
                    wait_label(label, STATUS["granted"])
                    assert button.is_disabled()
            elif case == "default_stays":
                # The original label is already visible while request is busy;
                # wait for the async prompt to finish before claiming recovery.
                wait_label(label, STATUS["default"])
                page.wait_for_function("() => { const b=[...document.querySelectorAll('.settings-box button')].find(x=>x.textContent?.includes('Yêu cầu quyền thiết bị')); return !!b && !b.disabled; }", timeout=10000)
                assert button.is_enabled()
            else:
                wait_label(label, STATUS["granted"])
                assert button.is_disabled()

        expected_calls = 2 if case == "reject_then_retry" else (0 if case in (
            "unsupported_notification", "unsupported_no_prompt", "unsupported_insecure",
            "denied", "granted") else 1)
        assert attempts() == expected_calls, f"unexpected permission requests: {attempts()}"
        assert page.evaluate("window.__notificationProbe.subscriptionCalls") == 0
        assert counts["push_endpoint"] == 0, "unexpected push/subscription backend request"
        assert counts["mutation"] == 0, "unexpected business mutation"
        assert counts["login"] == 1, "unexpected login replay"
        assert not errors, f"uncaught WebKit JS error: {errors[:1]}"
        print(f"PASS TN008 WEBKIT SYNTHETIC {width}x{height} case={case} "
              f"permission_calls={expected_calls} subscriptions=0", flush=True)
    finally:
        context.close()


def main() -> None:
    if not (WEB / "dist" / "index.html").is_file():
        raise RuntimeError("NOT RUN: build VITE_DEMO_MODE=false production UI first")
    vite = WEB / "node_modules" / ".bin" / "vite"
    if not vite.is_file():
        raise RuntimeError("NOT RUN: cd web && npm ci first")
    with sync_playwright() as playwright:
        executable = Path(playwright.webkit.executable_path)
        if not executable.exists():
            raise RuntimeError("NOT RUN: WebKit binary missing; AI0 must install Playwright WebKit")
        with socket.socket() as sock:
            if sock.connect_ex(("127.0.0.1", PORT)) == 0:
                raise RuntimeError("Refusing to reuse a non-owned localhost WebKit preview")
        server = subprocess.Popen(
            [str(vite), "preview", "--host", "127.0.0.1", "--port", str(PORT), "--strictPort"],
            cwd=WEB, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        try:
            for _ in range(80):
                if server.poll() is not None:
                    raise RuntimeError("NOT RUN: Vite preview exited unexpectedly")
                try:
                    with urlopen(URL, timeout=1) as response:
                        if response.status == 200:
                            break
                except (URLError, OSError):
                    time.sleep(0.25)
            else:
                raise RuntimeError("NOT RUN: localhost Vite preview not available")
            browser = playwright.webkit.launch(headless=True)
            try:
                for viewport in ((1440, 900), (390, 844)):
                    for case in CASES:
                        run_case(browser, viewport, case)
            finally:
                browser.close()
        finally:
            server.terminate()
            try:
                server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait(timeout=5)
    print(f"PASS TN008 WEBKIT SYNTHETIC {len(CASES) * 2} cases; "
          "REAL_SAFARI_IPHONE=NOT_RUN; ACTUAL_WEB_PUSH=NOT_RUN; "
          "PROVIDER_DELIVERY=NOT_RUN", flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"FAIL/NOT RUN TN008 WEBKIT: {type(error).__name__}: {error}", file=sys.stderr)
        sys.exit(1)