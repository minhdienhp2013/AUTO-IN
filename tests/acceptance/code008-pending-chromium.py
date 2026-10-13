"""AI5 CODE-008 real Chromium against compiled React, staff-auth Fastify,
PostgreSQL order. pending_updates values are synthetic HTTP fixtures ONLY.
Never use this result as proof of live Zalo OA, real Ricoh or physical iPhone.
"""
import os
import shutil
import sys
from playwright.sync_api import sync_playwright

URL=os.environ["AUTOIN_BROWSER_URL"]
SHOP=os.environ["AUTOIN_BROWSER_SHOP"]
USER=os.environ["AUTOIN_BROWSER_USER"]
PASSWORD=os.environ["AUTOIN_BROWSER_PASSWORD"]
ORDER=os.environ["AUTOIN_BROWSER_ORDER"]

def chrome():
    for n in ("google-chrome-stable","google-chrome","chromium","chromium-browser"):
        path=shutil.which(n)
        if path:return path
    raise RuntimeError("Chromium missing: CODE008 real status browser NOT RUN")

def one(browser,width,height,case):
    context=browser.new_context(viewport={"width":width,"height":height},
        is_mobile=width<600,has_touch=width<600,locale="vi-VN")
    page=context.new_page()
    errors=[]
    page.on("pageerror",lambda err:errors.append(str(err)))
    try:
        result=page.request.post(URL+"__ai5__/pending/"+case)
        assert result.status==200, "Isolated test pending fixture route unavailable"
        page.goto(URL,wait_until="networkidle",timeout=30000)
        form=page.locator('[data-testid="staff-login"]')
        form.wait_for(state="visible",timeout=15000)
        fields=form.locator("input")
        assert fields.count()==3
        for index,value in enumerate((SHOP,USER,PASSWORD)):
            fields.nth(index).fill(value)
        form.locator("button").first.click()
        cards=page.locator('[data-testid="order-list"] .order-card')
        target=cards.filter(has_text=ORDER)
        target.wait_for(state="visible",timeout=15000)
        target.click()
        detail=page.locator('[data-testid="order-detail"]')
        detail.locator(".detail-head h2").wait_for(state="visible",timeout=15000)
        assert detail.locator(".detail-head h2").inner_text()==ORDER
        clear=detail.locator('[data-testid="code008-clear"]')
        blocked=detail.locator('[data-testid="code008-blocked"]')
        pending=detail.locator('[data-testid="code008-pending-count"]')
        if case=="clear":
            assert clear.is_visible(), "Scoped CLEAR not rendered correctly"
            assert blocked.count()==0
        else:
            assert blocked.is_visible(), "No/unsafe pending evidence must block print"
            assert clear.count()==0
            if case in ("processing0","processing2","needs_human0","needs_human1"):
                assert pending.is_visible(), "Known PROCESSING/NEEDS_HUMAN must not collapse into UNKNOWN"
                content=pending.inner_text().lower()
                expected="nhân viên" if case.startswith("needs_human") else "ai xử lý"
                assert expected in content, "AI4 displayed wrong pending state"
                n=0 if case.endswith("0") else 2 if case.endswith("2") else 1
                assert str(n) in content, "Missing authoritative unresolved_count"
        assert detail.locator('[data-testid="approve-action"]').is_disabled(), (
            "No signed customer confirmation or verified print plan: no approval")
        assert not errors,"React runtime exception in pending status"
        print(f"PASS CODE008 Chromium {width}x{height} pending_updates={case}",flush=True)
    finally:context.close()

def main():
    assert URL.startswith("http://127.0.0.1:"), "Localhost-only browser fixture required"
    assert SHOP.startswith("autoin-test-browser-"), "Synthetic shop only"
    with sync_playwright() as p:
        b=p.chromium.launch(executable_path=chrome(),headless=True,args=[
            "--no-sandbox","--disable-dev-shm-usage"])
        try:
            for width,height in ((1440,900),(390,844)):
                for case in ("clear","processing0","needs_human0","processing2",
                             "needs_human1","stale_hash","missing"):
                    one(b,width,height,case)
        finally:b.close()
    print("PASS CODE008 Chromium pending_updates 14 status-viewport cases, synthetic UI inputs")
if __name__=="__main__":
    try:main()
    except Exception as exc:
        print("FAIL CODE008 Chromium pending status: "+type(exc).__name__,file=sys.stderr)
        raise SystemExit(1)
