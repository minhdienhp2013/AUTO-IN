import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { demoOrders, demoSession } from '../../web/src/fixtures.ts';
import { staffSessionUiReducer, type StaffSessionUiState } from '../../web/src/session-ui-state.ts';
import { classifySessionFailure, type SessionRequestScope } from '../../web/src/session-request.ts';

const shopA: SessionRequestScope = {
  epoch: 7, sessionVersion: 4, actorId: 'staff-A', role: 'staff', shopId: 'shop-A',
};
const shopB: SessionRequestScope = {
  epoch: 10, sessionVersion: 5, actorId: 'staff-B', role: 'staff', shopId: 'shop-B',
};
const populated = (actorId: string): StaffSessionUiState => ({
  session: { ...demoSession, actor_id: actorId },
  orders: [{ ...demoOrders[0], order_id: `order-${actorId}` }],
  selected: `order-${actorId}`,
  inboundItems: [{
    id: '11111111-1111-4111-8111-111111111111', kind: 'file', status: 'NEEDS_HUMAN',
    media_state: 'AWAITING_MEDIA', raw_event_sha256: 'a'.repeat(64),
    received_at: '2026-10-24T00:00:00Z', mapped_customer: false,
  }],
});

test('current selected-order 401 clears session, orders, selection and inbound rows', () => {
  const previous = populated('staff-A');
  // The API client has cleared its shop ID after the 401, while the App's
  // actor and session generation still identify the request as current.
  const afterCredentialClear = { ...shopA, shopId: null };
  const next = staffSessionUiReducer(previous, {
    type: 'request-401', expected: shopA, current: afterCredentialClear,
  });
  assert.deepEqual(next, { session: null, orders: [], selected: null, inboundItems: null });
  assert.deepEqual(previous.orders.map(order => order.order_id), ['order-staff-A']);
});

test('late shop-A 401 preserves the entire shop-B UI session', () => {
  const shopBState = populated('staff-B');
  const next = staffSessionUiReducer(shopBState, {
    type: 'request-401', expected: shopA, current: shopB,
  });
  assert.strictEqual(next, shopBState);
  assert.equal(next.session?.actor_id, 'staff-B');
  assert.equal(next.selected, 'order-staff-B');
  assert.equal(next.inboundItems?.length, 1);
});

test('late shop-A 401 preserves shop B even when the staff actor and role are unchanged', async () => {
  const sameActorShopB: SessionRequestScope = {
    ...shopA, epoch: 10, sessionVersion: 5, shopId: 'shop-B',
  };
  const shopBState: StaffSessionUiState = {
    ...populated('staff-A'),
    orders: [{ ...demoOrders[1], order_id: 'shop-B-order' }],
    selected: 'shop-B-order',
  };
  assert.equal(classifySessionFailure(401, shopA, sameActorShopB), 'stale');
  const next = staffSessionUiReducer(shopBState, {
    type: 'request-401', expected: shopA, current: sameActorShopB,
  });
  assert.strictEqual(next, shopBState);
  assert.equal(next.session?.actor_id, 'staff-A');
  assert.deepEqual(next.orders.map(order => order.order_id), ['shop-B-order']);
  assert.equal(next.selected, 'shop-B-order');
  assert.equal(next.inboundItems?.length, 1);

  // App increments the session generation before every login, including a
  // shop switch by the same actor. These source checks bind that premise to
  // the reducer test; this is not a mounted React test.
  const app = await readFile(new URL('../../web/src/App.tsx', import.meta.url), 'utf8');
  const clearStart = app.indexOf('const clearStaffSession = useCallback');
  const clearEnd = app.indexOf('const [deliveryValue', clearStart);
  const loginStart = app.indexOf('const doLogin = async');
  const loginEnd = app.indexOf('const doLogout = async', loginStart);
  assert.ok(clearStart >= 0 && clearEnd > clearStart && loginStart >= 0 && loginEnd > loginStart);
  assert.match(app.slice(clearStart, clearEnd), /sessionVersion\.current\+\+/);
  assert.match(app.slice(loginStart, loginEnd), /clearStaffSession\(\);[\s\S]*?await port\.login\(/);
});
