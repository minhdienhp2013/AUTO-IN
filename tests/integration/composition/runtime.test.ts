import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIntegratedApp, identityResolver } from '../../../backend/composition/runtime.js';
import { assertIsolatedSimulationDatabase } from '../../../backend/composition/postgres.js';
import { createZaloRawWebhook } from '../../../backend/composition/zalo-http.js';
import type { SqlPool } from '../../../backend/storage/database.js';
const unavailable: SqlPool = {
  query: async () => { throw new Error('DB must not be accessed without authentication'); },
  connect: async () => { throw new Error('DB must not be accessed without authentication'); }
};
test('Fastify registers AI1 routes once and rejects anonymous operations', async () => {
  const app = buildIntegratedApp({ pool: unavailable });
  try {
    await app.ready();
    const health = (await app.inject('/health')).json();
    assert.equal(health.auth_configured, true);
    assert.equal(health.processor_configured, false);
    assert.equal(health.registered_routes.length, new Set(health.registered_routes).size);
    for (const url of ['/api/v1/orders', '/api/v1/auth/me']) assert.equal((await app.inject(url)).statusCode, 401);
    assert.equal((await app.inject({method:'POST',url:'/internal/v1/print-jobs/claim',payload:{printer_id:'RMP7000'}})).statusCode,401);
    assert.equal((await app.inject({method:'POST',url:'/webhooks/zalo',payload:{}})).statusCode,503);
  } finally { await app.close(); }
});
test('configured agent cannot send against production shop settings', async () => {
  const pool: SqlPool = { ...unavailable, query: async <T>() => ({ rows: [{ mode: 'production' }] as T[], rowCount: 1 }) };
  const app=buildIntegratedApp({pool,identities:[{token:'x'.repeat(32),principal:{id:'agent',shop_id:'test',role:'print_agent',printer_ids:['RMP7000'],verified:true}}]});
  try {
    const response=await app.inject({method:'POST',url:'/internal/v1/print-jobs/claim',headers:{authorization:`Bearer ${'x'.repeat(32)}`},payload:{printer_id:'RMP7000'}});
    assert.equal(response.statusCode,409);
    assert.equal(response.json().error.code,'SIMULATION_REQUIRED');
  } finally { await app.close(); }
});
test('identity requires server configuration', async () => {
  assert.throws(()=>identityResolver([{token:'short',principal:{id:'x',shop_id:'s',role:'owner',verified:true}}]));
  await assert.rejects(identityResolver([])({headers:{authorization:'Bearer forged'}}));
});

test('simulation server accepts only isolated localhost PostgreSQL databases', () => {
  for (const url of [
    'postgresql://test:test@127.0.0.1:5432/autoin_test_305',
    'postgres://test:test@localhost:5432/auto_in_test',
    'postgresql://test:test@[::1]:5432/autoin_test_ci',
  ]) assert.doesNotThrow(() => assertIsolatedSimulationDatabase(url));
  for (const url of [
    'postgresql://test:test@db.example.com:5432/autoin_test_305',
    'postgresql://test:test@127.0.0.1:5432/production',
    'postgresql://test:test@127.0.0.1:5432/my_autoin_test',
    'mysql://test:test@localhost:3306/autoin_test',
  ]) assert.throws(() => assertIsolatedSimulationDatabase(url));
});

test('Zalo Fastify adapter passes exact raw bytes and signature headers to AI2', async () => {
  const rawBody = '{ "event_id": "fixture" }\n';
  let received: Uint8Array | undefined;
  let signature: string | undefined;
  const app = buildIntegratedApp({
    pool: unavailable,
    zaloWebhook: createZaloRawWebhook({
      async receive_webhook(raw, headers) {
        received = raw;
        signature = headers['x-test-fixture-key'];
        return { status_code: 200, body: { status: 'accepted', event_id: 'fixture' } };
      }
    })
  });
  try {
    await app.ready();
    const response = await app.inject({
      method: 'POST', url: '/webhooks/zalo',
      headers: { 'content-type': 'application/json', 'x-test-fixture-key': 'signed-fixture' },
      payload: rawBody
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(Buffer.from(received ?? []), Buffer.from(rawBody));
    assert.equal(signature, 'signed-fixture');
    assert.equal((await app.inject('/health')).json().zalo_webhook_configured, true);
  } finally { await app.close(); }
});
