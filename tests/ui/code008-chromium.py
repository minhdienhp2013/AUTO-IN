"""AI4 CODE-008 browser acceptance — compiled production UI, SYNTHETIC API fixtures.

Usage from checkout with web/dist built using VITE_DEMO_MODE=false:
    python3 tests/ui/code008-chromium.py

This never connects to external networks, customer accounts, Zalo or a printer.
No claim of actual customer consent, staff approval, or Fastify/PostgreSQL
behavior is made by this test. The backend integration acceptance is separate.
`detail_unverified` is a UI-only simulated response sequence, not backend evidence.
"""
from __future__ import annotations

from copy import deepcopy
import json
import os
from pathlib import Path
import shutil
import socket
import struct
import subprocess
import sys
import time
from urllib.error import URLError
from urllib.request import urlopen
import zlib

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
WEB = ROOT / 'web'
URL = 'http://127.0.0.1:4173/'
ORDER = '00000000-0000-4000-8000-000000000111'
OTHER = '00000000-0000-4000-8000-000000000999'
HASH = 'a' * 64
STAMP = '2026-10-14T06:00:00.000Z'
TOKEN = 'synthetic-only-ai4-browser-token'
ROLE = {'id': 'ai4-browser-fixture-owner', 'shop_id': 'ai4-browser-fixture-shop',
        'role': 'owner', 'verified': True}


def png_chunk(name: bytes, payload: bytes) -> bytes:
    chunk = name + payload
    return (struct.pack('>I', len(payload)) + chunk +
            struct.pack('>I', zlib.crc32(chunk) & 0xffffffff))


PREVIEW_PNG = (b'\x89PNG\r\n\x1a\n' +
               png_chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 6, 0, 0, 0)) +
               png_chunk(b'IDAT', zlib.compress(b'\x00\x00\x00\x00\xff')) +
               png_chunk(b'IEND', b''))


def executable() -> str:
    for name in ('google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser'):
        path = shutil.which(name)
        if path:
            return path
    raise RuntimeError('CHROMIUM NOT RUN: no local Google Chrome/Chromium binary')


def inbound(state: str, *, count: int = 0, items: list[dict] | None = None) -> dict:
    return {'order_id': ORDER, 'revision': 2, 'request_hash': HASH,
            'status': state, 'unresolved_count': count, 'items': items or []}


def details(name: str) -> dict:
    if name in ('clear', 'detail_unverified', 'offline', 'api401', 'api409', 'api503'):
        pending = inbound('clear')
    elif name == 'processing0':
        pending = inbound('processing')
    elif name == 'needs_human0':
        pending = inbound('needs_human')
    elif name == 'processing2':
        pending = inbound('processing', count=2, items=[
            {'kind': 'file', 'label': 'Tệp cần AI xử lý', 'summary': 'Metadata tổng hợp', 'received_at': STAMP},
            {'kind': 'message', 'label': 'Tin đang chờ', 'summary': 'Metadata an toàn', 'received_at': STAMP}])
    elif name == 'needs_human1':
        pending = inbound('needs_human', count=1, items=[
            {'kind': 'file', 'label': 'Cần người đối soát', 'summary': 'Chưa cập nhật vào đơn', 'received_at': STAMP}])
    elif name == 'stale_order':
        pending = inbound('clear'); pending['order_id'] = OTHER
    elif name == 'stale_revision':
        pending = inbound('clear'); pending['revision'] = 1
    elif name == 'stale_hash':
        pending = inbound('clear'); pending['request_hash'] = 'b' * 64
    elif name == 'missing':
        pending = None
    elif name == 'bad_count':
        pending = inbound('clear', count=1)
    else:
        raise AssertionError(f'Unhandled fixture: {name}')
    current = {
        'revision': 2, 'request_hash': HASH,
        # A hash-bound plan is not a verified document preview, and a preview
        # is not signed customer consent; do not create either from a fixture.
        'verified_plan': {'ready': True, 'request_hash': HASH, 'physical_sheets': 1,
                          'verified_by': 'synthetic-browser-only',
                          'artifact_ref': 'synthetic-untrusted-not-for-print'},
        'request_confirmation': None,
        'price_confirmation': None,
        'approval': None,
    }
    if pending is not None:
        current['pending_updates'] = pending
    return {
        'order': {'id': ORDER, 'shop_id': ROLE['shop_id'],
                  'customer_id': 'ai4-synthetic-customer', 'conversation_id': 'ai4-synthetic-chat',
                  'active_revision': 2, 'manual_lock': False, 'print_closed': False,
                  'created_at': STAMP, 'delivered_sheets': 0},
        'revisions': [{'revision': 2, 'request_hash': HASH, 'plan': {},
                       'request_data': {'documents': []}}],
        'jobs': [], 'quote': {'quote_revision': 1, 'amount_vnd': 10000,
                             'deposit_required_vnd': 0, 'significant_cost': False},
        'received_vnd': 0, 'current': current,
        'conversation_control': {'status': 'AI', 'generation': 1},
    }


CASES = ('clear', 'detail_unverified', 'processing0', 'needs_human0', 'processing2', 'needs_human1',
         'stale_order', 'stale_revision', 'stale_hash', 'missing', 'bad_count',
         'api401', 'api409', 'api503', 'offline')


def run_case(browser, viewport: tuple[int, int], case: str) -> None:
    width, height = viewport
    mobile = width < 600
    context = browser.new_context(viewport={'width': width, 'height': height},
                                  is_mobile=mobile, has_touch=mobile, locale='vi-VN')
    page = context.new_page()
    calls = {'login': 0, 'detail': 0, 'preview_catalog': 0, 'preview_png': 0,
             'mutation': 0, 'unauthorized': 0}
    detail_snapshots: list[tuple[str, int, str, bool]] = []
    crashes: list[str] = []
    page.on('pageerror', lambda e: crashes.append(str(e)))
    if case == 'detail_unverified':
        page.add_init_script('''
          (() => {
            const state = window.__autoinPreviewBlobLifecycle = {created: [], revoked: []};
            const create = URL.createObjectURL.bind(URL);
            const revoke = URL.revokeObjectURL.bind(URL);
            URL.createObjectURL = blob => {
              const url = create(blob);
              state.created.push(url);
              return url;
            };
            URL.revokeObjectURL = url => {
              state.revoked.push(url);
              return revoke(url);
            };
          })();
        ''')

    def mocked_api(route) -> None:
        req = route.request
        path = req.url.split('/api/v1/', 1)[-1].split('?', 1)[0]
        method = req.method
        def reply(payload: object, code: int = 200) -> None:
            route.fulfill(status=code, body=json.dumps(payload, ensure_ascii=False),
                          content_type='application/json', headers={'Cache-Control': 'no-store'})
        def error(code: int) -> None:
            reply({'error': {'code': f'SYNTHETIC_HTTP_{code}',
                             'message': f'Synthetic API error {code}'}}, code)
        if path == 'auth/login' and method == 'POST':
            calls['login'] += 1
            reply({'token': TOKEN, 'principal': ROLE})
            return
        if req.headers.get('authorization') != f'Bearer {TOKEN}':
            calls['unauthorized'] += 1
            error(401)
            return
        if path == 'auth/me' and method == 'GET':
            reply({'principal': ROLE})
        elif path == 'orders' and method == 'GET':
            reply({'orders': [{'id': ORDER, 'active_revision': 2,
                               'customer_id': 'ai4-synthetic-customer',
                               'conversation_id': 'ai4-synthetic-chat',
                               'created_at': STAMP, 'manual_lock': False,
                               'print_closed': False, 'delivered_sheets': 0}]})
        elif path == f'orders/{ORDER}' and method == 'GET':
            calls['detail'] += 1
            if case == 'offline':
                route.abort('failed')
            elif case == 'api401':
                error(401)
            elif case == 'api409':
                error(409)
            elif case == 'api503':
                error(503)
            else:
                payload = deepcopy(details('clear' if case == 'detail_unverified' else case))
                if case == 'detail_unverified' and calls['detail'] > 1:
                    payload.pop('current', None)
                if case == 'detail_unverified':
                    detail_snapshots.append((payload['order']['id'],
                                             payload['order']['active_revision'],
                                             payload['revisions'][0]['request_hash'],
                                             'current' in payload))
                reply(payload)
        elif path == f'orders/{ORDER}/revisions/2/previews' and method == 'GET':
            calls['preview_catalog'] += 1
            if case != 'detail_unverified':
                error(503)
            else:
                reply({'order_id': ORDER, 'revision': 2, 'request_hash': HASH,
                       'preview_verified': True, 'preview_count': 1,
                       'previews': [{'index': 0,
                                     'url': f'/api/v1/orders/{ORDER}/revisions/2/previews/0',
                                     'content_type': 'image/png'}]})
        elif path == f'orders/{ORDER}/revisions/2/previews/0' and method == 'GET':
            calls['preview_png'] += 1
            if case != 'detail_unverified':
                error(503)
            else:
                route.fulfill(status=200, body=PREVIEW_PNG, content_type='image/png',
                              headers={'Cache-Control': 'no-store',
                                       'X-Content-Type-Options': 'nosniff'})
        elif method != 'GET':
            calls['mutation'] += 1
            error(409)  # Even a browser regression can never mint an approval.
        else:
            error(503)

    try:
        page.route('**/api/v1/**', mocked_api)
        page.goto(URL, wait_until='domcontentloaded', timeout=20000)
        login = page.locator('[data-testid="staff-login"]')
        login.wait_for(state='visible', timeout=12000)
        assert page.locator('[data-testid="order-list"]').count() == 0, 'orders leaked before login'
        fields = login.locator('input')
        assert fields.count() == 3, 'staff credential form contract changed'
        fields.nth(0).fill(ROLE['shop_id'])
        fields.nth(1).fill('fixture-owner')
        fields.nth(2).fill('not-a-real-password')
        login.locator('button').first.click()
        if case == 'api401':
            # 401 revokes the in-memory session and never exposes order details.
            page.wait_for_function("() => Boolean(document.querySelector('[data-testid=staff-login]')) && "
                                   "!document.querySelector('[data-testid=order-list]')",
                                   timeout=20000)
            assert page.locator('[data-testid="approve-action"]').count() == 0
        else:
            detail = page.locator('[data-testid="order-detail"]')
            card = page.locator('[data-testid="order-list"] .order-card').filter(has_text=ORDER)
            card.wait_for(state='visible', timeout=15000)
            if mobile:
                card.click()  # mobile detail is intentionally hidden until selected
            detail.locator('.detail-head h2').filter(has_text=ORDER).wait_for(timeout=15000)
            if case == 'detail_unverified':
                gallery = detail.locator('[data-testid="verified-preview-gallery"]')
                image = gallery.locator('[data-testid="verified-preview-image"]').first
                image.wait_for(state='visible', timeout=15000)
                assert image.evaluate('(element) => element.complete && element.naturalWidth == 1'), (
                    'initial synthetic PNG should render before refresh')
                blobs = page.evaluate('() => window.__autoinPreviewBlobLifecycle')
                assert len(blobs['created']) == 1 and blobs['revoked'] == [], (
                    'initial snapshot should own one live preview Blob URL')
                with page.expect_response(
                        lambda response: response.request.method == 'GET' and
                        response.url.split('/api/v1/', 1)[-1].split('?', 1)[0] ==
                        f'orders/{ORDER}' and response.status == 200,
                        timeout=15000):
                    page.get_by_role('button', name='Làm mới dữ liệu').click()
                gallery.locator('[data-testid="preview-unavailable"]').wait_for(
                    state='visible', timeout=15000)
                assert gallery.locator('[data-testid="verified-preview-image"]').count() == 0, (
                    'same-identity detail validation loss must hide the previous image')
                assert page.locator('[data-testid="api-lock-banner"]').count() == 0, (
                    'a successful HTTP detail response keeps API health true')
                assert calls['detail'] == 2 and detail_snapshots == [
                    (ORDER, 2, HASH, True), (ORDER, 2, HASH, False)], (
                    'fixture must preserve order/revision/hash while current disappears')
                blobs = page.evaluate('() => window.__autoinPreviewBlobLifecycle')
                assert len(blobs['created']) == 1 and blobs['revoked'] == blobs['created'], (
                    'detail validation loss must revoke the previous Blob URL')
                assert calls['preview_catalog'] == calls['preview_png'] == 1, (
                    'unverified detail must not request another preview')

            if case in ('offline', 'api409', 'api503'):
                # The specific API error and the independent fail-closed guard
                # are BOTH required. Distinct test ids make this contract
                # unambiguous; do not use .first() to hide duplicate alerts.
                fault = page.locator('[data-testid="api-error"]')
                locked = page.locator('[data-testid="api-lock-banner"]')
                fault.wait_for(state='visible', timeout=12000)
                locked.wait_for(state='visible', timeout=12000)
                assert fault.count() == 1, 'exactly one specific API fault must be displayed'
                assert locked.count() == 1, 'exactly one global read-only API guard must be displayed'
                expected = ('Mất kết nối API' if case == 'offline'
                            else 'Synthetic API error 409' if case == 'api409'
                            else 'Synthetic API error 503')
                assert expected in fault.inner_text(), 'specific HTTP/network failure must remain visible'
                assert 'Không xác minh được API' in locked.inner_text()
                assert 'tạm khóa' in locked.inner_text(), 'read-only gate warning must remain visible'
                page.locator('[data-testid="code008-blocked"]').wait_for(timeout=12000)
                assert 'CHƯA XÁC ĐỊNH' in page.locator('[data-testid="code008-blocked"]').inner_text()
            else:
                pending = page.locator('[data-testid="code008-inbound"]')
                pending.wait_for(state='visible', timeout=15000)
                if case == 'clear':
                    page.locator('[data-testid="code008-clear"]').wait_for(timeout=15000)
                    assert 'đúng mã đơn' in page.locator('[data-testid="code008-clear"]').inner_text()
                else:
                    pending.locator('[data-testid="code008-blocked"]').wait_for(timeout=15000)
                    body = pending.inner_text()
                    if case.startswith('processing'):
                        assert 'ĐANG CHỜ AI XỬ LÝ' in body, body
                    elif case.startswith('needs_human'):
                        assert 'CẦN NHÂN VIÊN ĐỐI SOÁT' in body, body
                    else:
                        assert 'CHƯA XÁC ĐỊNH' in body, body
                    if case in ('processing2', 'needs_human1'):
                        count = {'processing2': 2, 'needs_human1': 1}[case]
                        assert pending.locator('.inbound-item').count() == count, 'pending safe metadata missing'
                        assert 'đã nhập vào đơn' not in body.lower(), 'fabricated append claim'
            approve = detail.locator('[data-testid="approve-action"]')
            assert approve.is_disabled(), 'approval enabled without verified signed customer confirmation/preview'
            assert detail.locator('[data-testid="confirmation-request"]').count() == 1
            assert 'Chưa có xác nhận' in detail.locator('[data-testid="confirmation-request"]').inner_text()
        assert calls['login'] == 1, 'unexpected login replay'
        assert calls['mutation'] == 0, 'UI automatically created a mutation/approval/print job'
        assert not crashes, f'uncaught browser exception: {crashes[:1]}'
        detail_gate = (' same_snapshot=true preview_hidden=true blob_revoked=true'
                       if case == 'detail_unverified' else '')
        print(f'PASS CODE008 SYNTHETIC Chromium {width}x{height} scenario={case} '
              f'GET_detail={calls["detail"]} mutation=0{detail_gate}', flush=True)
    finally:
        context.close()


def main() -> int:
    if not (WEB / 'dist' / 'index.html').is_file():
        raise RuntimeError('NOT RUN: first build real UI with VITE_DEMO_MODE=false npm run build')
    chrome = executable()
    vite = WEB / 'node_modules' / '.bin' / 'vite'
    if not vite.is_file():
        raise RuntimeError('NOT RUN: first cd web && npm ci')
    with socket.socket() as sock:
        if sock.connect_ex(('127.0.0.1', 4173)) == 0:
            raise RuntimeError('Refusing to hijack pre-existing localhost:4173 server')
    process = subprocess.Popen([str(vite), 'preview', '--host', '127.0.0.1',
                                '--port', '4173', '--strictPort'], cwd=WEB,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(60):
            if process.poll() is not None:
                raise RuntimeError('Vite preview exited before becoming ready')
            try:
                with urlopen(URL, timeout=1) as resp:
                    if resp.status == 200:
                        break
            except (URLError, OSError):
                time.sleep(0.25)
        else:
            raise RuntimeError('Vite preview did not become ready on localhost')
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=chrome, headless=True,
                                                 args=['--no-sandbox', '--disable-dev-shm-usage'])
            try:
                for viewport in ((1440, 900), (390, 844)):
                    for case in CASES:
                        run_case(browser, viewport, case)
                # Additional CODE501 synthetic UI tests. Existing CODE008
                # assertions remain; detail_unverified adds a focused regression.
                from shop_schedule_browser import CASES as SHOP_CASES, run_schedule_case
                for viewport in ((1440, 900), (390, 844)):
                    for case in SHOP_CASES:
                        run_schedule_case(browser, viewport, case)
            finally:
                browser.close()
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
    print(f'PASS CODE008 SYNTHETIC Chromium {len(CASES) * 2} scenario-viewport cases; '
          'LIVE_FASTIFY_PG=NOT_RUN; OA=NOT_RUN; RICOH=NOT_RUN; physical_iPhone=NOT_RUN')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as exc:
        print(f'FAIL/NOT RUN CODE008 SYNTHETIC Chromium: {type(exc).__name__}: {exc}', file=sys.stderr)
        sys.exit(1)
