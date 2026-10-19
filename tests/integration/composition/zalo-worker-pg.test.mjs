import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PgStore } from '../../../backend/storage/database.ts';
import { buildIntegratedApp } from '../../../backend/composition/runtime.ts';
import { asSqlPool, assertIsolatedSimulationDatabase } from '../../../backend/composition/postgres.ts';
import { createSyntheticZaloRuntime } from '../../../backend/composition/zalo-simulation.ts';

const url = process.env.TEST_DATABASE_URL;
test('AI0 synthetic Fastify → PG worker → AI1 draft; unregistered file routes HUMAN', {
  skip: !url ? 'TEST_DATABASE_URL unset: worker/PG not verified' : false
}, async () => {
  assertIsolatedSimulationDatabase(url);
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  const id = randomUUID(), shop = `ai0-worker-${id}`, oa = `oa-${id}`;
  const customer = `customer-${id}`, conversation = `conversation-${id}`;
  const key = randomUUID() + randomUUID();
  let app, created = false;
  const query = (sql, args = []) => pool.query(sql, args);
  const fixture = (eventId, kind, extra) => JSON.stringify({ synthetic_fixture: true,
    event_id: eventId, oa_id: oa, customer_id: customer, conversation_id: conversation,
    occurred_at: '2026-10-12T00:00:00Z', kind, ...extra });
  try {
    assert.match((await query('SELECT current_database() AS name')).rows[0].name, /test/i);
    await query('INSERT INTO core_shop_settings(shop_id) VALUES($1)', [shop]);
    created = true;
    const runtime = createSyntheticZaloRuntime(pool,
      { kind: 'synthetic_fixture', shop_id: shop, oa_id: oa, fixture_key: key },
      { store: new PgStore(asSqlPool(pool)) });
    app = buildIntegratedApp({ pool: asSqlPool(pool), zaloWebhook: runtime.webhook,
      zaloWorkerConfigured: true });
    await app.ready();
    assert.equal((await app.inject({ method: 'GET', url: '/health' })).json().zalo_worker_configured, true);
    const send = (body) => app.inject({ method: 'POST', url: '/webhooks/zalo',
      headers: { 'content-type': 'application/json', 'x-test-fixture-key': key }, payload: body });
    const first = `print-${id}`;
    assert.equal((await send(fixture(first, 'text', { text: 'In A4' }))).json().status, 'accepted');
    assert.equal((await runtime.tick_inbound()).ingested, 1);
    await query("UPDATE zalo_batches SET deadline_at=now()-interval '1 second' WHERE oa_id=$1 AND status='OPEN'", [oa]);
    assert.equal((await runtime.tick_inbound()).processed, 1);
    assert.equal((await query('SELECT count(*)::int AS n FROM core_ai_draft_proposals WHERE shop_id=$1', [shop])).rows[0].n, 1);
    assert.equal((await query('SELECT count(*)::int AS n FROM zalo_outbound WHERE shop_id=$1 AND oa_id=$2', [shop, oa])).rows[0].n, 1);
    assert.equal((await runtime.tick_outbound()).disabled, true);

    const file = `file-${id}`;
    assert.equal((await send(fixture(file, 'file', { file_ref: 'customer-controlled-ref.pdf' }))).json().status, 'accepted');
    assert.equal((await runtime.tick_inbound()).ingested, 1);
    await query("UPDATE zalo_batches SET deadline_at=now()-interval '1 second' WHERE oa_id=$1 AND status='OPEN'", [oa]);
    assert.equal((await runtime.tick_inbound()).held, 1);
    const control = (await query('SELECT status,claimed_by FROM core_conversation_controls WHERE shop_id=$1 AND conversation_id=$2', [shop, conversation])).rows[0];
    assert.deepEqual(control, { status: 'HUMAN', claimed_by: null });
    assert.equal((await query('SELECT count(*)::int AS n FROM core_ai_draft_proposals WHERE shop_id=$1', [shop])).rows[0].n, 1);
  } finally {
    if (app) await app.close();
    if (created) {
      await query('DELETE FROM ai0_inbound_document_artifacts WHERE shop_id=$1', [shop]);
      await query('DELETE FROM zalo_outbound WHERE shop_id=$1 AND oa_id=$2', [shop, oa]);
      await query('DELETE FROM zalo_batch_items WHERE oa_id=$1', [oa]);
      await query('DELETE FROM zalo_batches WHERE oa_id=$1', [oa]);
      await query('DELETE FROM zalo_process_queue WHERE oa_id=$1', [oa]);
      await query('DELETE FROM core_ai_draft_proposals WHERE shop_id=$1', [shop]);
      await query('DELETE FROM core_audit WHERE shop_id=$1', [shop]);
      await query('DELETE FROM core_idempotency WHERE shop_id=$1', [shop]);
      await query('DELETE FROM core_revisions WHERE order_id IN (SELECT id FROM core_orders WHERE shop_id=$1)', [shop]);
      await query('DELETE FROM core_orders WHERE shop_id=$1', [shop]);
      await query('DELETE FROM core_conversation_controls WHERE shop_id=$1', [shop]);
      await query('DELETE FROM core_users WHERE shop_id=$1', [shop]);
      await query('DELETE FROM core_shop_settings WHERE shop_id=$1', [shop]);
      await query('DELETE FROM zalo_inbound_events WHERE oa_id=$1', [oa]);
    }
    await pool.end();
  }
});
