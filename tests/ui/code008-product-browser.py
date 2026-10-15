"""AI4 Chromium vs genuine Fastify and isolated PostgreSQL; NO HTTP mocks.

Must be started by tests/ui/code008-product-browser.mjs after real DB seed.
Browser never calls mutation endpoints other than genuine staff login.
"""
from __future__ import annotations
import json
import os
import shutil
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright

URL = os.environ['AI4_BROWSER_URL']
SHOP = os.environ['AI4_SHOP']
PASSWORD = os.environ['AI4_PASSWORD']
ORDERS = json.loads(os.environ['AI4_ORDERS'])
OLD_HASH = os.environ['AI4_OLD_HASH']
BEARER = os.environ['AI4_BEARER']
BEARER_409 = os.environ['AI4_409_BEARER']

def executable():
    for name in ('google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser'):
        path = shutil.which(name)
        if path:
            return path
    raise RuntimeError('NOT RUN: Chrome/Chromium not in PATH')

def scenario(browser, width, height, kind):
    mobile = width < 600
    ctx = browser.new_context(viewport={'width':width,'height':height},
                              is_mobile=mobile, has_touch=mobile, locale='vi-VN')
    page = ctx.new_page()
    errors = []
    calls = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('request', lambda request: calls.append((request.method, urlsplit(request.url).path))
            if '/api/' in request.url else None)
    try:
        # A clean browser context is intentionally used for every scenario.
        page.goto(URL, wait_until='domcontentloaded')
        form = page.locator('[data-testid="staff-login"]')
        form.wait_for(state='visible')
        fields = form.locator('input')
        assert fields.count() == 3
        fields.nth(0).fill(SHOP)
        fields.nth(1).fill('owner')
        fields.nth(2).fill('incorrect-synthetic-password' if kind == 'api401' else PASSWORD)
        form.locator('button').first.click()
        if kind == 'api401':
            page.locator('[data-testid="api-error"]').wait_for(state='visible')
            assert page.locator('[data-testid="api-lock-banner"]').count() == 1
            assert page.locator('[data-testid="order-list"]').count() == 0
            assert page.locator('[data-testid="approve-action"]').count() == 0
        else:
            target = ORDERS.get(kind) or ORDERS['clear']
            card = page.locator('[data-testid="order-list"] .order-card').filter(has_text=target)
            card.wait_for(state='visible', timeout=20000)
            card.click()
            detail = page.locator('[data-testid="order-detail"]')
            detail.locator('.detail-head h2').filter(has_text=target).wait_for(timeout=20000)
            approve = detail.locator('[data-testid="approve-action"]')
            assert approve.is_disabled(), 'staff approval is enabled without verified consent/preview'
            pending = detail.locator('[data-testid="code008-inbound"]')
            pending.wait_for(state='visible')
            if kind == 'clear':
                label = pending.locator('[data-testid="code008-clear"]')
                label.wait_for(state='visible')
                assert 'đúng mã đơn' in label.inner_text()
            elif kind == 'processing0':
                assert 'ĐANG CHỜ AI XỬ LÝ' in pending.inner_text()
                assert 'Chưa có mục được liệt kê' in pending.inner_text()
            elif kind == 'needs_human0':
                assert 'CẦN NHÂN VIÊN ĐỐI SOÁT' in pending.inner_text()
                assert 'Chưa có mục được liệt kê' in pending.inner_text()
            elif kind == 'pending1':
                assert 'ĐANG CHỜ AI XỬ LÝ' in pending.inner_text()
                assert 'Có 1 tin/file chưa xử lý' in pending.inner_text()
                assert pending.locator('.inbound-item').count() == 1
                assert 'đã ghép vào đơn' not in pending.inner_text().lower()
            elif kind == 'stale_hash':
                assert pending.locator('[data-testid="code008-clear"]').count() == 0
                assert 'ĐANG CHỜ AI XỬ LÝ' in pending.inner_text()
                assert 'CẦN XÁC NHẬN LẠI' in pending.inner_text().upper() or (
                    pending.locator('[data-testid="code008-reconfirm"]').count() == 1)
            elif kind == 'stale_revision':
                # Real navigation to a previous revision; actual backend returns latest.
                # This MUST NOT replay an obsolete approval or change current order.
                assert 'đúng mã đơn' in pending.inner_text() or (
                    pending.locator('[data-testid="code008-blocked"]').count() == 1)
                assert approve.is_disabled()
            elif kind == 'offline':
                ctx.set_offline(True)  # browser network disabled; NO route.fulfill/interception
                page.get_by_role('button', name='Làm mới dữ liệu').click()
                fault = page.locator('[data-testid="api-error"]')
                lock = page.locator('[data-testid="api-lock-banner"]')
                fault.wait_for(state='visible', timeout=15000)
                lock.wait_for(state='visible', timeout=15000)
                assert fault.count() == 1 and lock.count() == 1
                assert 'Mất kết nối API' in fault.inner_text()
                assert 'tạm khóa' in lock.inner_text()
                assert 'CHƯA XÁC ĐỊNH' in pending.inner_text()
                assert approve.is_disabled()
                ctx.set_offline(False)
            elif kind == 'api409':
                # Actual existing authenticated GET endpoint; not an injected error.
                response = page.request.get(URL + 'api/v1/runtime-status',
                    headers={'Authorization': 'Bearer ' + BEARER_409})
                assert response.status == 409, 'live Fastify runtime-status expected 409'
                assert approve.is_disabled()
            elif kind == 'api503':
                response = page.request.get(URL + 'api/v1/orders/' +
                    ORDERS['clear'] + '/revisions/1/previews',
                    headers={'Authorization': 'Bearer ' + BEARER})
                assert response.status == 503, 'live Fastify preview route expected 503'
                assert approve.is_disabled()
        mutations = [(method,path) for method,path in calls
                     if method not in ('GET','HEAD','OPTIONS')
                     and path != '/api/v1/auth/login']
        assert mutations == [], 'browser sent a product mutation: ' + repr(mutations)
        assert not errors, 'browser errors: ' + repr(errors[:2])
        print('PASS REAL Fastify+PG Chromium ' + str(width) + 'x' + str(height) +
              ' ' + kind + ' mutation=0', flush=True)
    finally:
        ctx.close()

def main():
    assert URL.startswith('http://127.0.0.1:'), 'localhost only'
    assert SHOP.startswith('autoin-test-ai4-'), 'isolated shop only'
    assert len(OLD_HASH) == 64
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=executable(), headless=True,
                                    args=['--no-sandbox', '--disable-dev-shm-usage'])
        try:
            for dims in ((1440, 900), (390, 844)):
                for name in ('clear','processing0','needs_human0','pending1',
                             'stale_hash','stale_revision','api401','api409','api503','offline'):
                    scenario(browser, *dims, name)
        finally:
            browser.close()
    print('PASS 20 REAL browser-viewport scenarios; 409/503 UI error banner injection '
          'NOT RUN; iPhone/Safari/OA/Ricoh NOT RUN', flush=True)

if __name__ == '__main__':
    main()
