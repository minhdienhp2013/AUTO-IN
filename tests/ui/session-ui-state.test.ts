import test from 'node:test';
import assert from 'node:assert/strict';
import { demoOrders, demoSession } from '../../web/src/fixtures.ts';
import { staffSessionUiReducer, type StaffSessionUiState } from '../../web/src/session-ui-state.ts';
import type { SessionRequestScope } from '../../web/src/session-request.ts';

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
