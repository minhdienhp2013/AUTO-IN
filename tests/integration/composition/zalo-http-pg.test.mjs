import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { buildIntegratedApp } from '../../../backend/composition/runtime.ts';
import { asSqlPool } from '../../../backend/composition/postgres.ts';
import { createZaloRawWebhook } from '../../../backend/composition/zalo-http.ts';
import { createZaloPipeline } from '../../../backend/integrations/zalo/pipeline.ts';
import { SyntheticFixtureNormalizer, SyntheticTestVerifier } from '../../../backend/integrations/zalo/protocol.ts';

const url = process.env.TEST_DATABASE_URL;
test('Fastify raw Zalo fixture verifies signature then commits/deduplicates in PostgreSQL', {
  skip: !url ? 'TEST_DATABASE_URL unset: HTTP/PG webhook composition NOT VERIFIED' : false
}, async () => {
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  const db = {
    async transaction(action) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await action({ async query(sql, params = []) {
          const value = await client.query(sql, [...params]);
          return { rows: value.rows, rowCount: value.rowCount };
        } });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
    }
  };
  const oa = `synthetic-oa-${randomUUID()}`;
  const eventId = randomUUID();
  const key = `fixture-${randomUUID()}`;
  const pipeline = createZaloPipeline({
    db, trusted_shop_id: `synthetic-shop-${randomUUID()}`, trusted_oa_id: oa,
    orders: { async suggest_draft() { throw new Error('NOT_CALLED'); }, async route_human() { throw new Error('NOT_CALLED'); } },
    documents: { async inspect() { return []; } },
    schedule: { allowed() { return false; } }, clock: { now: () => new Date() },
    synthetic_provider: { kind: 'synthetic_fixture', verifier: new SyntheticTestVerifier(key),
      normalizer: new SyntheticFixtureNormalizer() }
  });
  const app = buildIntegratedApp({ pool: asSqlPool(pool), zaloWebhook: createZaloRawWebhook(pipeline) });
  const raw = `{ "synthetic_fixture": true, "event_id": "${eventId}", "oa_id": "${oa}", "customer_id": "fixture-customer", "conversation_id": "fixture-conversation", "occurred_at": "2026-10-12T00:00:00Z", "kind": "text", "text": "Xin chào" }\n`;
  const send = fixtureKey => app.inject({ method: 'POST', url: '/webhooks/zalo',
    headers: { 'content-type': 'application/json', 'x-test-fixture-key': fixtureKey }, payload: raw });
  try {
    await app.ready();
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
