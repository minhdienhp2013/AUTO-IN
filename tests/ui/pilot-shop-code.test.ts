import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { ApiFault, DemoPrintPort, HttpPrintPort } from '../../web/src/api.ts';
import { demoOrders } from '../../web/src/fixtures.ts';
import { type StaffSession } from '../../web/src/domain.ts';
import { loadPilotShopCode, parsePilotShopCodeDisplay, PilotShopCodePanelView, type PilotShopCodeDisplay } from '../../web/src/pilot-shop-code.ts';

const fromWeb = createRequire(new URL('../../web/package.json', import.meta.url));
const React = fromWeb('react');
const { renderToStaticMarkup } = fromWeb('react-dom/server');

const shopId = 'shop-42';
const staff: StaffSession = { actor_id: 'staff-7', display_name: 'Nhân viên', role: 'staff', can_approve: false, can_manage_schedule: false };
const validDto: PilotShopCodeDisplay = {
  schema: 'ai0.pilot_shop_code_display.v1', shop_id: shopId, code: 'A7KQ-2026',
  server_time: '2026-10-21T10:00:00.000Z', expires_at: '2026-10-21T10:30:00.000Z',
};
const jsonResponse = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json' },
});
const loginPrincipal = { id: staff.actor_id, shop_id: shopId, role: 'staff', verified: true };

test('pilot code DTO accepts the #163 contract and rejects stale, oversized, or malformed windows', () => {
  assert.deepEqual(parsePilotShopCodeDisplay(validDto), validDto);
  for (const value of [
    { ...validDto, schema: 'wrong' },
    { ...validDto, code: '   ' },
    { ...validDto, expires_at: '2026-10-21T09:59:59.000Z' },
    { ...validDto, expires_at: '2026-10-21T10:30:01.000Z' },
    { ...validDto, server_time: 'not-a-time' },
  ]) assert.equal(parsePilotShopCodeDisplay(value), null);
});

test('loader requires an authenticated staff session and matching server shop; RTT reduces displayed lifetime', async () => {
  let calls = 0, now = 100;
  const port = { async loadCurrentShopCode() { calls++; return validDto; } };
  assert.deepEqual(await loadPilotShopCode(port, null, shopId, () => now), { status: 'unauthenticated' });
  assert.equal(calls, 0);
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

test('panel renders only authenticated code as escaped text and hides code plus old orders on unhealthy API', () => {
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
  assert.doesNotMatch(lockedHtml, /A7KQ-2026|pilot-code-ready/);

  const staleOrder = { ...structuredClone(demoOrders[0]), order_id: 'old-order' };
  const currentCode = { status: 'ready' as const, display: validDto, receivedAt: 0, remainingAtReceiptMs: 120000 };
  const orderUnavailableHtml = renderToStaticMarkup(React.createElement(PilotShopCodePanelView, {
    authenticatedStaff: true, apiHealthy: false, state: currentCode, orders: [staleOrder], remainingMs: 120000, onRefresh() {},
  }));
  assert.match(orderUnavailableHtml, /A7KQ-2026/);
  assert.doesNotMatch(orderUnavailableHtml, /old-order/);
  assert.match(orderUnavailableHtml, /pilot-orders-unknown/);
  const codeUnavailableHtml = renderToStaticMarkup(React.createElement(PilotShopCodePanelView, {
    authenticatedStaff: true, apiHealthy: true, state: { status: 'unavailable' }, orders: [], remainingMs: null, onRefresh() {},
  }));
  assert.doesNotMatch(codeUnavailableHtml, /A7KQ-2026|pilot-code-ready/);
  assert.match(codeUnavailableHtml, /pilot-code-unavailable/);
});

test('HTTP port calls only the authenticated #163 GET with Bearer and no-store; demo never synthesizes a code', async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = String(input); requests.push({ url, init });
    if (url.endsWith('/api/v1/auth/login')) return jsonResponse({ token: 'ephemeral-token', principal: loginPrincipal });
    if (url.endsWith('/api/v1/auth/me')) return jsonResponse({ principal: loginPrincipal });
    if (url.endsWith('/api/v1/pilot/shop-code')) return jsonResponse(validDto);
    return jsonResponse({ error: { code: 'NOT_FOUND', message: 'not found' } }, 404);
  };
  const port = new HttpPrintPort('', fetcher);
  await assert.rejects(port.loadCurrentShopCode(), (error: unknown) => error instanceof ApiFault && error.status === 401);
  assert.equal(requests.length, 0);
  await port.login(shopId, 'staff', 'secret');
  const dto = await port.loadCurrentShopCode();
  assert.deepEqual(dto, validDto);
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
  assert.ok(/!useDemo&&session&&<button[^>]+data-testid="pilot-shop-code-nav"/.test(app), 'navigation is staff-session gated');
  assert.ok(/setSession\(await port\.login\(loginShop,\s*loginUser,\s*loginPassword\)\);\s*setView\('shop-code'\)/.test(app), 'successful login opens the pilot page');
  assert.ok(/view === 'shop-code' \? <PilotShopCodePanel/.test(app), 'pilot page is part of the authenticated app');
  assert.ok(/view === 'orders'/.test(app), 'existing order-management flow remains');
  assert.ok(/this\.call\('\/api\/v1\/pilot\/shop-code'\)/.test(api), 'uses only the #163 route');
  assert.ok(!/localStorage|sessionStorage|URL\(|dangerouslySetInnerHTML|fetch\(/.test(await readFile(new URL('../../web/src/pilot-shop-code.ts', import.meta.url), 'utf8')), 'panel does not persist, generate, or fetch arbitrary code sources');
});
