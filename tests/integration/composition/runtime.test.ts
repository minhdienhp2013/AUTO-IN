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
test('V1 Core evidence is opt-in and synthetic-only in the simulation runtime', async () => {
  const invalid = {
    artifactRoot: '/tmp/autoin-evidence-fixture',
    printerCapabilities: { simulation_only: false, printer_id: 'RMP7000', queue_name: 'RMP7000' }
  };
  assert.throws(() => buildIntegratedApp({ pool: unavailable,
    trustedPrintEvidence: invalid as never }), /SIMULATION_PRINT_EVIDENCE_CONFIG_REQUIRED/);

  const app = buildIntegratedApp({ pool: unavailable, trustedPrintEvidence: {
    artifactRoot: '/tmp/autoin-evidence-fixture',
    printerCapabilities: { simulation_only: true, printer_id: 'RMP7000', queue_name: 'RMP7000' }
  } });
  try {
    await app.ready();
    const health = (await app.inject('/health')).json();
    assert.equal(health.trusted_print_evidence_v1_configured, true);
    assert.equal(health.live_enabled, false);
  } finally { await app.close(); }
});
test('Word review endpoints expose configuration truthfully and set no-store on errors', async () => {
  const root = '/tmp/autoin-word-review-route-probe';
  const app = buildIntegratedApp({ pool: unavailable,
    trustedPrintEvidence: { artifactRoot: root, printerCapabilities: {
      simulation_only: true, printer_id: 'RMP7000', queue_name: 'RMP7000'
    } },
    syntheticArtifactIngest: { artifactRoot: root, scope: { shop_id: 'shop-word', oa_id: 'oa-word' } },
    wordReviewArtifactRoot: root
  });
  try {
    await app.ready();
    assert.equal(app.hasRoute({ method: 'POST', url: '/api/v1/orders/:order_id/revisions/:revision/word-review-previews' }), true);
    assert.equal(app.hasRoute({ method: 'GET', url: '/api/v1/orders/:order_id/word-preview/pages/:index' }), true);
    const status = (await app.inject('/health')).json();
    assert.equal(status.word_review_source_configured, true);
    assert.equal(status.word_review_preview_configured, true);
    const post = await app.inject({ method: 'POST',
      url: '/api/v1/orders/00000000-0000-4000-8000-000000000011/revisions/1/word-review-previews', payload: {} });
    assert.equal(post.statusCode, 401);
    assert.equal(post.headers['cache-control'], 'no-store');
    const page = await app.inject({ method: 'GET',
      url: '/api/v1/orders/00000000-0000-4000-8000-000000000011/word-preview/pages/1' });
    assert.equal(page.statusCode, 401);
    assert.equal(page.headers['cache-control'], 'no-store');
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
