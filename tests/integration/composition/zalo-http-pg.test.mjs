import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { buildIntegratedApp } from '../../../backend/composition/runtime.ts';
import { asSqlPool } from '../../../backend/composition/postgres.ts';
import { createSyntheticZaloIngress } from '../../../backend/composition/zalo-simulation.ts';

test('synthetic Zalo ingress requires a server-owned OA, shop and long fixture key', () => {
  for (const input of [null, {}, {kind:'synthetic_fixture', shop_id:'shop', oa_id:'oa', fixture_key:'short'},
    {kind:'production', shop_id:'shop', oa_id:'oa', fixture_key:'x'.repeat(32)}]) {
    assert.throws(() => createSyntheticZaloIngress({}, input), /Invalid synthetic Zalo registry/);
  }
});

const url = process.env.TEST_DATABASE_URL;
test('Fastify raw Zalo fixture verifies signature then commits/deduplicates in PostgreSQL', {
  skip: !url ? 'TEST_DATABASE_URL unset: HTTP/PG webhook composition NOT VERIFIED' : false
}, async () => {
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  const oa = `synthetic-oa-${randomUUID()}`;
  const shop = `synthetic-shop-${randomUUID()}`;
  const eventId = randomUUID();
  const key = `${randomUUID()}${randomUUID()}`;
  const zaloWebhook = createSyntheticZaloIngress(pool, {
    kind: 'synthetic_fixture', shop_id: shop, oa_id: oa, fixture_key: key
  });
  const app = buildIntegratedApp({ pool: asSqlPool(pool), zaloWebhook });
  const raw = `{ "synthetic_fixture": true, "event_id": "${eventId}", "oa_id": "${oa}", "customer_id": "fixture-customer", "conversation_id": "fixture-conversation", "occurred_at": "2026-10-12T00:00:00Z", "kind": "text", "text": "Xin chào" }\n`;
  const send = fixtureKey => app.inject({ method: 'POST', url: '/webhooks/zalo',
    headers: { 'content-type': 'application/json', 'x-test-fixture-key': fixtureKey }, payload: raw });
  try {
    await app.ready();
    assert.equal((await app.inject({method:'GET',url:'/health'})).json().zalo_worker_configured, false);
    assert.equal((await send('wrong-key')).statusCode, 403);
    const wrongScope = await app.inject({ method: 'POST', url: '/webhooks/zalo',
      headers: { 'content-type': 'application/json', 'x-test-fixture-key': key },
      payload: raw.replace(oa, 'untrusted-oa') });
    assert.equal(wrongScope.statusCode, 422);
    const first = await send(key);
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().status, 'accepted');
    const second = await send(key);
    assert.equal(second.statusCode, 200);
    assert.equal(second.json().status, 'duplicate');
    const stored = await pool.query('SELECT count(*)::int AS n FROM zalo_inbound_events WHERE oa_id=$1 AND event_id=$2', [oa, eventId]);
    const queued = await pool.query('SELECT count(*)::int AS n FROM zalo_process_queue WHERE oa_id=$1 AND event_id=$2', [oa, eventId]);
    assert.equal(stored.rows[0].n, 1);
    assert.equal(queued.rows[0].n, 1);
  } finally {
    await app.close();
    await pool.query('DELETE FROM zalo_process_queue WHERE oa_id=$1', [oa]);
    await pool.query('DELETE FROM zalo_inbound_events WHERE oa_id=$1', [oa]);
    await pool.end();
  }
});
