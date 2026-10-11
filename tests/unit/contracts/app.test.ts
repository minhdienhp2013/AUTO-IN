import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../../backend/app.js';
import { ContractError, type AuthPort } from '../../../contracts/ports.js';
import type { AuthPrincipal } from '../../../contracts/schemas.js';
const staff: AuthPrincipal = { actor_id: 'staff_demo', role: 'staff', permissions: ['orders:read', 'orders:quote'] };
const authenticate = (principal: AuthPrincipal): AuthPort => ({ authenticate: async () => principal });
const quote = { expected_revision: 1, idempotency_key: 'key', amount_vnd: 10000, deposit_requested_vnd: 0, significant_cost: false };

test('default health reports simulation and absent integration truthfully', async t => {
  const app = buildApp(); t.after(() => app.close());
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().configured_operations, []);
  assert.equal(res.json().mode, 'simulation'); assert.equal(res.json().live_enabled, false);
  assert.equal(res.json().auth_configured, false);
  for (const url of ['/api/v1/auth/login', '/webhooks/zalo']) {
    const reply = await app.inject({ method: 'POST', url, payload: url.endsWith('login') ? { username: 'owner', password: 'example_only' } : {} });
    assert.equal(reply.statusCode, 503);
  }
});
test('client principal headers do not authenticate; protected handler is never invoked', async t => {
  let called = false;
  const app = buildApp({ handlers: { listOrders: async () => { called = true; return { orders: [] }; } } }); t.after(() => app.close());
  const res = await app.inject({ method: 'GET', url: '/api/v1/orders', headers: { 'x-role': 'owner', 'x-actor-id': 'owner' } });
  assert.equal(res.statusCode, 401); assert.equal(called, false);
});
test('authenticated missing module is 503; absent permission is 403', async t => {
  const app = buildApp({ auth: authenticate(staff) }); t.after(() => app.close());
  assert.equal((await app.inject('/api/v1/orders')).statusCode, 503);
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/orders/order_demo/approvals', payload: {} })).statusCode, 403);
});
test('payload validation rejects fake actor and does not invoke domain service', async t => {
  let called = false;
  const app = buildApp({ auth: authenticate(staff), handlers: { quoteOrder: async () => { called = true; return {}; } } }); t.after(() => app.close());
  const res = await app.inject({ method: 'POST', url: '/api/v1/orders/order_demo/quote', payload: { ...quote, actor_id: 'owner' } });
  assert.equal(res.statusCode, 422); assert.equal(called, false);
});
test('trusted injected service receives server identity and parsed bounded query', async t => {
  const app = buildApp({ auth: authenticate(staff), handlers: { listOrders: async ctx => {
    assert.equal(ctx.principal?.actor_id, 'staff_demo'); assert.deepEqual(ctx.input, { limit: 10 });
    assert.equal(ctx.setSessionCookie, undefined); return { orders: [] };
  } } }); t.after(() => app.close());
  assert.equal((await app.inject('/api/v1/orders?limit=10')).statusCode, 200);
  for (const value of ['1.5', '101', 'foo', '0']) assert.equal((await app.inject(`/api/v1/orders?limit=${value}`)).statusCode, 422);
});
test('revision conflicts preserve 409 and current revision', async t => {
  const app = buildApp({ auth: authenticate(staff), handlers: { quoteOrder: async () => { throw new ContractError(409, 'REVISION_CONFLICT', 'Revision changed', false, 2); } } }); t.after(() => app.close());
  const res = await app.inject({ method: 'POST', url: '/api/v1/orders/order_demo/quote', payload: quote });
  assert.equal(res.statusCode, 409); assert.equal(res.json().error.current_revision, 2);
});
test('invalid service output and unexpected errors are sanitized 500 responses', async t => {
  const app = buildApp({ auth: authenticate(staff), handlers: { listOrders: async () => ({ invalid: true }), quoteOrder: async () => { throw new Error('secret-token'); } } }); t.after(() => app.close());
  for (const request of [{ method: 'GET' as const, url: '/api/v1/orders' }, { method: 'POST' as const, url: '/api/v1/orders/order_demo/quote', payload: quote }]) {
    const res = await app.inject(request); assert.equal(res.statusCode, 500); assert.ok(!res.body.includes('secret-token'));
  }
});
test('agent scoped credential cannot claim a different printer', async t => {
  const app = buildApp({ auth: authenticate({ actor_id: 'a', role: 'agent', permissions: ['jobs:send'], agent_id: 'a', printer_ids: ['RMP7000'] }) }); t.after(() => app.close());
  const res = await app.inject({ method: 'POST', url: '/internal/v1/print-jobs/claim', payload: { printer_id: 'other_printer', idempotency_key: 'key' } });
  assert.equal(res.statusCode, 403);
});
test('production and controlled test cannot start from environment/config flags', () => {
  for (const mode of ['production', 'controlled_test'] as const) assert.throws(() => buildApp({ mode }), /Live mode unavailable/);
});

test('safe mode blocks new claims without invoking service', async t => {
  let called = false;
  const app = buildApp({ mode: 'safe', auth: authenticate({ actor_id: 'a', role: 'agent', permissions: ['jobs:send'], agent_id: 'a', printer_ids: ['RMP7000'] }), handlers: { claimJob: async () => { called = true; return { job: null }; } } }); t.after(() => app.close());
  const res = await app.inject({ method: 'POST', url: '/internal/v1/print-jobs/claim', payload: { printer_id: 'RMP7000', idempotency_key: 'key' } });
  assert.equal(res.statusCode, 409); assert.equal(called, false);
});
