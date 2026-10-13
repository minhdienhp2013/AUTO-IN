"""AI5 CODE-008 real Chromium against compiled React, staff-auth Fastify,
PostgreSQL order. pending_updates values are synthetic HTTP fixtures ONLY.
Never use this result as proof of live Zalo OA, real Ricoh or physical iPhone.
"""
import os
import shutil
import sys
import traceback
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
    viewport=f"{width}x{height}"
    step="create Chromium context"
    print(f"START CODE008 viewport={viewport} scenario={case}",flush=True)
    context=browser.new_context(viewport={"width":width,"height":height},
        is_mobile=width<600,has_touch=width<600,locale="vi-VN")
    page=context.new_page()
    errors=[]
    page.on("pageerror",lambda err:errors.append(str(err)))
    try:
        step="set localhost synthetic pending fixture"
        result=page.request.post(URL+"__ai5__/pending/"+case)
        assert result.status==200, "Isolated test pending fixture route unavailable"
        step="load compiled React over localhost Fastify"
        page.goto(URL,wait_until="networkidle",timeout=30000)
        step="wait for staff login form"
        form=page.locator('[data-testid="staff-login"]')
        form.wait_for(state="visible",timeout=15000)
        fields=form.locator("input")
        assert fields.count()==3
        step="fill synthetic test-only staff login"
        for index,value in enumerate((SHOP,USER,PASSWORD)):
            fields.nth(index).fill(value)
        step="submit staff credentials"
        form.locator("button").first.click()
        cards=page.locator('[data-testid="order-list"] .order-card')
        target=cards.filter(has_text=ORDER)
        step="wait for real PostgreSQL order card"
        target.wait_for(state="visible",timeout=15000)
        step="open selected order detail"
        target.click()
        detail=page.locator('[data-testid="order-detail"]')
        step="wait for authenticated order detail"
        detail.locator(".detail-head h2").wait_for(state="visible",timeout=15000)
        assert detail.locator(".detail-head h2").inner_text()==ORDER
        clear=detail.locator('[data-testid="code008-clear"]')
        blocked=detail.locator('[data-testid="code008-blocked"]')
        pending=detail.locator('[data-testid="code008-pending-count"]')
        step=f"check {case} scoped pending banner"
        if case=="clear":
            assert clear.is_visible(), "Scoped CLEAR not rendered correctly"
            assert blocked.count()==0
        else:
            assert blocked.is_visible(), "No/unsafe pending evidence must block print"
            assert clear.count()==0
            if case in ("missing","stale_hash"):
                assert "chưa xác định" in blocked.inner_text().lower(), (
                    "Missing or mismatched authoritative data must be visibly UNKNOWN")
                assert pending.count()==0, (
                    "UNKNOWN must never display a stale PROCESSING/NEEDS_HUMAN status")
            if case in ("processing0","processing2","needs_human0","needs_human1"):
                assert pending.is_visible(), "Known PROCESSING/NEEDS_HUMAN must not collapse into UNKNOWN"
                content=pending.inner_text().lower()
                blocked_text=blocked.inner_text().lower()
                status="needs_human" if case.startswith("needs_human") else "processing"
                expected_warning="cần nhân viên đối soát" if status=="needs_human" else "đang chờ ai xử lý"
                # AI4 deliberately separates the machine-readable status/count
                # line from the human-facing blocking warning. Verify BOTH.
                # Only fixed synthetic status messages, never URL/token/page dump.
                print(f"OBS CODE008 viewport={viewport} scenario={case} "
                      f"status_text={content!r} warning={blocked_text!r}",flush=True)
                assert f"trạng thái: {status}" in content, (
                    f"Wrong explicit server status: expected={status!r} actual={content!r}")
                assert expected_warning in blocked_text, (
                    f"Wrong user-facing block reason: expected={expected_warning!r} actual={blocked_text!r}")
                n=0 if case.endswith("0") else 2 if case.endswith("2") else 1
                if n==0:
                    assert "chưa có mục được liệt kê" in content and "chưa chứng thực clear" in content, (
                        f"Empty unresolved list must NEVER look like CLEAR: {content!r}")
                else:
                    assert f"có {n} tin/file chưa xử lý" in content, (
                        f"Wrong exact unresolved count={n}: {content!r}")
        step="assert approval disabled under test-only unconfirmed order"
        assert detail.locator('[data-testid="approve-action"]').is_disabled(), (
            "No signed customer confirmation or verified print plan: no approval")
        step="check React runtime errors"
        assert not errors,"React runtime exception in pending status"
        print(f"PASS CODE008 Chromium {width}x{height} pending_updates={case}",flush=True)
    except Exception as exc:
        # Do not log synthetic passwords, bearer tokens, browser URL or page body.
        # The original Python traceback (including the exact failed assertion and
        # Playwright call log) is essential for identifying harness vs. AI4 defect.
        print(f"FAIL CODE008 viewport={viewport} scenario={case} step={step} "+
              f"error={type(exc).__name__}",file=sys.stderr,flush=True)
        traceback.print_exc(file=sys.stderr)
        raise
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
    except Exception:
        # Scenario-specific traceback has already been printed inside one().
        # Outside a scenario (e.g. browser launch), preserve its traceback here.
        if sys.exc_info()[2] and sys.exc_info()[2].tb_frame.f_code.co_name != "one":
            traceback.print_exc(file=sys.stderr)
        raise SystemExit(1)
