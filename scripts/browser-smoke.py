"""AI0 browser smoke: REAL headless Chromium on the compiled AI4 demo.

This is visual/interaction evidence only. It does NOT verify a live Zalo OA,
Windows Ricoh, staff login, real customer confirmations, or printing.
Never treat a mock/demo action as a product-backed acceptance test.
"""
from __future__ import annotations

from contextlib import contextmanager
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import shutil
import sys
import threading

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "web" / "dist"


class QuietStaticHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *args: object) -> None:
        pass


@contextmanager
def built_web_server():
    if not (DIST / "index.html").is_file() or not (ROOT / "web" / "package-lock.json").is_file():
        raise RuntimeError("AI4 Vite build or genuine npm lockfile missing: BROWSER NOT RUN")
    httpd = ThreadingHTTPServer(
        ("127.0.0.1", 0), partial(QuietStaticHandler, directory=str(DIST))
    )
    server = threading.Thread(target=httpd.serve_forever, daemon=True)
    server.start()
    try:
        yield f"http://127.0.0.1:{httpd.server_address[1]}/"
    finally:
        httpd.shutdown()
        httpd.server_close()
        server.join(timeout=5)


def browser_executable() -> str:
    # Ubuntu GitHub runner supplies Google Chrome; local dev may use Chromium.
    path = next((p for name in (
        "google-chrome-stable", "google-chrome", "chromium", "chromium-browser"
    ) if (p := shutil.which(name))), None)
    if not path:
        raise RuntimeError("Chrome/Chromium binary unavailable: BROWSER NOT RUN")
    return path


def smoke(browser, url: str, width: int, height: int) -> None:
    mobile = width < 600
    context = browser.new_context(
        viewport={"width": width, "height": height},
        is_mobile=mobile, has_touch=mobile,
        locale="vi-VN"
    )
    page = context.new_page()
    page_errors: list[str] = []
    page.on("pageerror", lambda error: page_errors.append(str(error)))
    try:
        response = page.goto(url, wait_until="networkidle", timeout=30_000)
        assert response and response.status == 200, "Vite static UI did not serve"
        page.locator('[data-testid="operation-mode"]').wait_for(state="visible", timeout=12_000)
        mode = page.locator('[data-testid="operation-mode"]').inner_text()
        assert "MÔ PHỎNG" in mode and "KHÔNG IN THẬT" in mode, mode

        cards = page.locator('[data-testid="order-list"] .order-card')
        assert cards.count() >= 4, "Synthetic demo order list missing"

        # No overflow on desktop and iPhone-size viewport.
        overflow = page.evaluate(
            "() => ({scroll:document.documentElement.scrollWidth,width:window.innerWidth})"
        )
        assert overflow["scroll"] <= overflow["width"] + 1, (
            f"{width} viewport horizontal overflow: {overflow}"
        )

        # Unknown print outcome is displayed as an alert; no second print/approval.
        cards.filter(has_text="MD-260003").click()
        detail = page.locator('[data-testid="order-detail"]')
        detail.locator(".simulation-note").wait_for(state="visible")
        assert "không in" in detail.locator(".simulation-note").inner_text().lower()
        detail.locator(".risk-note").wait_for(state="visible")
        assert "Không tự gửi lại" in detail.locator(".risk-note").inner_text()
        assert detail.locator('[data-testid="approve-action"]').is_disabled(), (
            "UNKNOWN/manual lock must block approval"
        )

        # Unsupported Word preview must stay explicitly untrusted and cannot
        # enable the approval button, irrespective of stale/mock metadata.
        cards.filter(has_text="MD-260002").click()
        detail.locator(".invalid-label").first.wait_for(state="visible")
        assert "Chưa có ảnh preview" in detail.locator(".preview-placeholder").inner_text()
        assert detail.locator('[data-testid="approve-action"]').is_disabled(), (
            "Untrusted Word preview must not enable approval"
        )
        assert not page_errors, f"Browser console uncaught errors: {page_errors}"
        print(f"PASS REAL Chromium demo UI {width}x{height}: mode, UNKNOWN, untrusted preview, approval, overflow")
    finally:
        context.close()


def main() -> int:
    with built_web_server() as url:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(
                executable_path=browser_executable(), headless=True,
                args=["--no-sandbox", "--disable-dev-shm-usage"]
            )
            try:
                smoke(browser, url, 1440, 900)
                smoke(browser, url, 390, 844)
            finally:
                browser.close()
    print("BROWSER_SCOPE=real_Chromium_automated; DATA=synthetic_demo; DEVICE/OA=NOT_RUN")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(f"FAIL Chromium demo browser smoke: {error}", file=sys.stderr)
        sys.exit(1)
