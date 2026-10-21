import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { ApiFault, DemoPrintPort, HttpPrintPort } from '../../web/src/api.ts';
import { demoOrders } from '../../web/src/fixtures.ts';
import { type StaffSession } from '../../web/src/domain.ts';
import { listenForPilotConnection, loadPilotShopCode, parsePilotShopCodeDisplay, pilotOrderPrintStatus, PilotShopCodePanelView, type PilotShopCodeDisplay } from '../../web/src/pilot-shop-code.ts';

const fromWeb = createRequire(new URL('../../web/package.json', import.meta.url));
const React = fromWeb('react');
const { renderToStaticMarkup } = fromWeb('react-dom/server');

const shopId = 'shop-42';
const staff: StaffSession = { actor_id: 'staff-7', display_name: 'Nhân viên', role: 'staff', can_approve: false, can_manage_schedule: false };
const validDto: PilotShopCodeDisplay = {
  schema: 'ai0.pilot_shop_code_display.v1', shop_id: shopId, code: 'A7KQ2M9R6V',
  server_time: '2026-10-21T10:00:00.000Z', expires_at: '2026-10-21T10:30:00.000Z',
};
const jsonResponse = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json' },
});
const loginPrincipal = { id: staff.actor_id, shop_id: shopId, role: 'staff', verified: true };

test('pilot code DTO accepts the locked wire format and rejects malformed codes or time windows', () => {
  assert.deepEqual(parsePilotShopCodeDisplay(validDto), validDto);
  for (const value of [
    { ...validDto, schema: 'wrong' },
    { ...validDto, code: '   ' },
    { ...validDto, code: 'A7KQ-2026' },
    { ...validDto, code: 'a7kq2m9r6v' },
    { ...validDto, code: 'A7KQ2M9R6I' },
    { ...validDto, code: 'A7KQ2M9R6L' },
    { ...validDto, code: 'A7KQ2M9R6O' },
    { ...validDto, code: 'A7KQ2M9R6U' },
    { ...validDto, code: 'A7KQ2M9R6' },
    { ...validDto, code: 'A7KQ2M9R6V7' },
    { ...validDto, code: '<img src=x>' },
    { ...validDto, expires_at: '2026-10-21T09:59:59.000Z' },
    { ...validDto, expires_at: '2026-10-21T10:30:01.000Z' },
    { ...validDto, server_time: 'not-a-time' },
  ]) assert.equal(parsePilotShopCodeDisplay(value), null);
});

test('loader requires an authenticated staff session and matching server shop; RTT reduces displayed lifetime', async () => {
  let calls = 0, now = 100;
  const port = { async loadCurrentShopCode() { calls++; return validDto; } };
  assert.deepEqual(await loadPilotShopCode(port, null, shopId, () => now), { status: 'unauthenticated' });
  assert.equal((await loadPilotShopCode(port, { ...staff, role: 'staff' }, null, () => now)).status, 'unauthenticated');
  assert.equal((await loadPilotShopCode(port, { ...staff, role: 'owner' }, shopId, () => now)).status, 'ready');
  assert.equal((await loadPilotShopCode(port, { ...staff, role: 'customer' } as unknown as StaffSession, shopId, () => now)).status, 'unauthenticated');
  assert.equal(calls, 1, 'only the authorized owner request reached the port');
  const state = await loadPilotShopCode(port, staff, shopId, () => { const current = now; now += 75; return current; });
  assert.equal(state.status, 'ready');
  if (state.status === 'ready') assert.equal(state.remainingAtReceiptMs, 30 * 60 * 1000 - 75);
  assert.equal((await loadPilotShopCode(port, staff, 'other-shop', () => now)).status, 'unavailable');
  assert.equal((await loadPilotShopCode({ async loadCurrentShopCode() { throw new ApiFault(401, 'EXPIRED', 'expired'); } }, staff, shopId)).status, 'session-expired');
  assert.equal((await loadPilotShopCode({ async loadCurrentShopCode() { throw new Error('offline'); } }, staff, shopId)).status, 'unavailable');
  for (const status of [403, 409, 503]) {
    const failed = await loadPilotShopCode({ async loadCurrentShopCode() { throw new ApiFault(status, `HTTP_${status}`, 'unavailable'); } }, staff, shopId);
    assert.equal(failed.status, 'unavailable', `HTTP ${status} hides code and requires staff handling`);
  }
});

test('countdown uses server time and a monotonic clock, not the device wall clock', async () => {
  const originalDateNow = Date.now;
  try {
    Date.now = () => 9_999_999_999_999;
    const state = await loadPilotShopCode({ async loadCurrentShopCode() { return validDto; } }, staff, shopId);
    assert.equal(state.status, 'ready');
    if (state.status === 'ready') {
      assert.ok(state.remainingAtReceiptMs > 29 * 60 * 1000);
      assert.ok(state.remainingAtReceiptMs <= 30 * 60 * 1000);
    }
  } finally { Date.now = originalDateNow; }
});

test('each refresh receives the rotated server code and errors produce no displayable old code', async () => {
  const rotated: PilotShopCodeDisplay = {
    ...validDto, code: 'B9M2R6V4KQ', server_time: '2026-10-21T10:29:59.000Z', expires_at: '2026-10-21T10:59:59.000Z',
  };
  let request = 0;
  const port = { async loadCurrentShopCode() { return [validDto, rotated][request++]; } };
  const first = await loadPilotShopCode(port, staff, shopId);
  const second = await loadPilotShopCode(port, staff, shopId);
  assert.equal(first.status, 'ready');
  assert.equal(second.status, 'ready');
  if (first.status === 'ready' && second.status === 'ready') {
    assert.equal(first.display.code, 'A7KQ2M9R6V');
    assert.equal(second.display.code, 'B9M2R6V4KQ');
  }
  const afterNetworkFailure = await loadPilotShopCode({ async loadCurrentShopCode() { throw new Error('offline'); } }, staff, shopId);
  const unavailable = renderToStaticMarkup(React.createElement(PilotShopCodePanelView, {
    authenticatedStaff: true, apiHealthy: true, state: afterNetworkFailure, orders: [], remainingMs: null, onRefresh() {},
  }));
  assert.doesNotMatch(unavailable, /A7KQ2M9R6V|B9M2R6V4KQ/);
  assert.match(unavailable, /pilot-code-unavailable/);
});

test('offline invalidates the displayed code and order snapshot; online requests a fresh read', () => {
  const handlers = new Map<string, EventListener>();
  const target = {
    addEventListener(type: string, listener: EventListener) { handlers.set(type, listener); },
    removeEventListener(type: string, listener: EventListener) { handlers.delete(type); },
  } as unknown as Window;
  let codeVisible = true, ordersFresh = true, refreshCount = 0;
  const unlisten = listenForPilotConnection(target, () => { codeVisible = false; ordersFresh = false; }, () => { refreshCount++; });
  handlers.get('offline')!(new Event('offline'));
  assert.equal(codeVisible, false);
  assert.equal(ordersFresh, false);
  handlers.get('online')!(new Event('online'));
  assert.equal(refreshCount, 1);
  unlisten();
  assert.equal(handlers.size, 0);
});

test('pilot order status maps waiting, sending, sent, blocked and UNKNOWN without treating ACK as print proof', () => {
  const printState = (state: 'NOT_SENT'|'SENDING'|'SENT_UNVERIFIED'|'UNKNOWN', manual_lock = false) =>
    pilotOrderPrintStatus({ print_state: state, manual_lock });
  assert.equal(printState('NOT_SENT').status, 'WAITING');
  assert.equal(printState('NOT_SENT').label, 'Chờ xử lý · chưa gửi máy');
  assert.equal(printState('SENDING').status, 'SENDING');
  assert.equal(printState('SENT_UNVERIFIED').status, 'SENT');
  assert.match(printState('SENT_UNVERIFIED').label, /chưa xác minh giấy/);
  assert.equal(printState('NOT_SENT', true).status, 'BLOCKED');
  assert.equal(printState('UNKNOWN').status, 'UNKNOWN');
  assert.doesNotMatch(printState('SENT_UNVERIFIED').label, /đã in/i);
});

test('panel renders only authenticated escaped code, hides stale order rows, and marks uncertain print state UNKNOWN', () => {
  const unsafe = { ...validDto, code: '<img src=x onerror=alert(1)>' };
  const ready = { status: 'ready' as const, display: unsafe, receivedAt: 0, remainingAtReceiptMs: 120000 };
  const authenticatedHtml = renderToStaticMarkup(React.createElement(PilotShopCodePanelView, {
    authenticatedStaff: true, apiHealthy: true, state: ready, orders: [], remainingMs: 120000, onRefresh() {},
  }));
  assert.match(authenticatedHtml, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(authenticatedHtml, /<img src=x/);
  assert.match(authenticatedHtml, /pilot-code-expiry/);

  const lockedHtml = renderToStaticMarkup(React.createElement(PilotShopCodePanelView, {
    authenticatedStaff: false, apiHealthy: true, state: ready, orders: [], remainingMs: 120000, onRefresh() {},
  }));
  assert.doesNotMatch(lockedHtml, /A7KQ2M9R6V|pilot-code-ready/);

  const staleOrder = { ...structuredClone(demoOrders[0]), order_id: 'old-order' };
  const currentCode = { status: 'ready' as const, display: validDto, receivedAt: 0, remainingAtReceiptMs: 120000 };
  const orderUnavailableHtml = renderToStaticMarkup(React.createElement(PilotShopCodePanelView, {
    authenticatedStaff: true, apiHealthy: false, state: currentCode, orders: [staleOrder], remainingMs: 120000, onRefresh() {},
  }));
  assert.match(orderUnavailableHtml, /A7KQ2M9R6V/);
  assert.doesNotMatch(orderUnavailableHtml, /old-order/);
  assert.match(orderUnavailableHtml, /pilot-orders-unknown/);
  const codeUnavailableHtml = renderToStaticMarkup(React.createElement(PilotShopCodePanelView, {
    authenticatedStaff: true, apiHealthy: true, state: { status: 'unavailable' }, orders: [], remainingMs: null, onRefresh() {},
  }));
  assert.doesNotMatch(codeUnavailableHtml, /A7KQ2M9R6V|pilot-code-ready/);
  assert.match(codeUnavailableHtml, /pilot-code-unavailable/);

  const unknownOrder = { ...structuredClone(demoOrders[0]), order_id: 'current-order', print_state: 'UNKNOWN' as const };
  const unknownOrderHtml = renderToStaticMarkup(React.createElement(PilotShopCodePanelView, {
    authenticatedStaff: true, apiHealthy: true, state: currentCode, orders: [unknownOrder], remainingMs: 120000, onRefresh() {},
  }));
  assert.match(unknownOrderHtml, /UNKNOWN/);
  assert.match(unknownOrderHtml, /không tự gửi lại lệnh/i);
  assert.doesNotMatch(unknownOrderHtml, /Đã in/);

  const sessionExpiredHtml = renderToStaticMarkup(React.createElement(PilotShopCodePanelView, {
    authenticatedStaff: true, apiHealthy: true, state: { status: 'session-expired' }, orders: [], remainingMs: null, onRefresh() {},
  }));
  assert.doesNotMatch(sessionExpiredHtml, /A7KQ2M9R6V|B9M2R6V4KQ/);
  assert.match(sessionExpiredHtml, /pilot-code-unavailable/);
});

test('HTTP port calls only the authenticated #163 GET with Bearer and no-store; demo never synthesizes a code', async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  let codeReads = 0;
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = String(input); requests.push({ url, init });
    if (url.endsWith('/api/v1/auth/login')) return jsonResponse({ token: 'ephemeral-token', principal: loginPrincipal });
    if (url.endsWith('/api/v1/auth/me')) return jsonResponse({ principal: loginPrincipal });
    if (url.endsWith('/api/v1/pilot/shop-code')) {
      const rotated: PilotShopCodeDisplay = { ...validDto, code: 'B9M2R6V4KQ', server_time: '2026-10-21T10:29:59.000Z', expires_at: '2026-10-21T10:59:59.000Z' };
      return jsonResponse(codeReads++ === 0 ? validDto : rotated);
    }
    return jsonResponse({ error: { code: 'NOT_FOUND', message: 'not found' } }, 404);
  };
  const port = new HttpPrintPort('', fetcher);
  await assert.rejects(port.loadCurrentShopCode(), (error: unknown) => error instanceof ApiFault && error.status === 401);
  assert.equal(requests.length, 0);
  await port.login(shopId, 'staff', 'secret');
  const dto = await port.loadCurrentShopCode();
  const rotated = await port.loadCurrentShopCode();
  assert.deepEqual(dto, validDto);
  assert.equal(rotated.code, 'B9M2R6V4KQ');
  const request = requests.at(-1)!;
  assert.equal(request.url, '/api/v1/pilot/shop-code');
  assert.equal(request.init.method, undefined);
  assert.equal(request.init.cache, 'no-store');
  assert.equal(request.init.credentials, 'same-origin');
  assert.equal(new Headers(request.init.headers).get('Authorization'), 'Bearer ephemeral-token');
  await assert.rejects(new DemoPrintPort().loadCurrentShopCode(), (error: unknown) => error instanceof ApiFault && error.status === 503);
});

test('HTTP port rejects cross-shop and invalid DTO responses instead of displaying them', async () => {
  for (const responseDto of [{ ...validDto, shop_id: 'another-shop' }, { ...validDto, schema: 'unknown.v9' }]) {
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/api/v1/auth/login')) return jsonResponse({ token: 'token', principal: loginPrincipal });
      if (url.endsWith('/api/v1/auth/me')) return jsonResponse({ principal: loginPrincipal });
      return jsonResponse(responseDto);
    };
    const port = new HttpPrintPort('', fetcher);
    await port.login(shopId, 'staff', 'secret');
    await assert.rejects(port.loadCurrentShopCode(), (error: unknown) => error instanceof ApiFault && error.status === 503);
  }
});

test('pilot page is gated to a live staff session while the existing order-management view remains', async () => {
  const app = await readFile(new URL('../../web/src/App.tsx', import.meta.url), 'utf8');
  const api = await readFile(new URL('../../web/src/api.ts', import.meta.url), 'utf8');
  const panel = await readFile(new URL('../../web/src/pilot-shop-code.ts', import.meta.url), 'utf8');
  assert.ok(/!useDemo&&session&&<button[^>]+data-testid="pilot-shop-code-nav"/.test(app), 'navigation is staff-session gated');
  assert.ok(/setSession\(await port\.login\(loginShop,\s*loginUser,\s*loginPassword\)\);\s*setView\('shop-code'\)/.test(app), 'successful login opens the pilot page');
  assert.ok(/view === 'shop-code' \? <PilotShopCodePanel/.test(app), 'pilot page is part of the authenticated app');
  assert.ok(/view === 'orders'/.test(app), 'existing order-management flow remains');
  assert.ok(/this\.call\('\/api\/v1\/pilot\/shop-code'\)/.test(api), 'uses only the #163 route');
  assert.ok(/listenForPilotConnection\(window, onOffline, onOnline\)/.test(panel), 'offline/online events are attached to the pilot page');
  assert.ok(/setState\(\{ status: 'unavailable' \}\);\s*setRefreshing\(false\)/.test(panel), 'offline invalidates the old code immediately');
  assert.ok(/apiHealthy: apiHealthy && browserOnline && ordersFresh/.test(panel), 'offline and stale order data display UNKNOWN');
  assert.ok(/if \(next <= 0\)[\s\S]*?setState\(\{ status: 'expired' \}\);\s*void refresh\(\)/.test(panel), 'expiry hides the code and triggers a server refresh');
  assert.ok(/window\.setInterval\(tick, 1000\)/.test(panel), 'countdown ticks from the server-derived monotonic deadline');
  assert.ok(/if \(stillValidMs > 60_000\) void refresh\(\)[\s\S]*?\}, 60_000\)/.test(panel), 'reachability is periodically revalidated before expiry');
  assert.ok(!/localStorage|sessionStorage|URL\(|dangerouslySetInnerHTML|fetch\(/.test(panel), 'panel does not persist, generate, or fetch arbitrary code sources');
});
