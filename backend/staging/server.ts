import pg from 'pg';
import { createOfficialZaloVerifiedIngress } from '../integrations/zalo/official-quarantine.js';
import { createOfficialZaloWebhookAdapter, type OfficialZaloWebhookConfig } from '../integrations/zalo/official-webhook.js';
import { PostgresInboundEventRepository, type SqlClient, type TransactionRunner } from '../integrations/zalo/postgres-events.js';
import { createZaloTransactions, type PostgreSqlPool } from '../integrations/zalo/transaction-runner.js';
import { buildLocalStagingApp } from './app.js';
import { readStagingRuntimeConfig } from './config.js';
import { assertLocalStagingSchema as assertLocalStagingSchemaSnapshot } from './schema-guard.js';
import { createStagingZaloReceiver } from './zalo-receiver.js';

const config = readStagingRuntimeConfig();
const pool = new pg.Pool({
  connectionString: config.database_url,
  connectionTimeoutMillis: 5000,
  max: 2,
  idleTimeoutMillis: 10000,
  application_name: 'auto-in-local-staging-webhook'
});

const postgres: PostgreSqlPool = {
  async connect() {
    const client = await pool.connect();
    return {
      async query(sql: string, params: unknown[] = []) {
        const result = await client.query(sql, params);
        return { rows: result.rows, rowCount: result.rowCount };
      },
      release() { client.release(); }
    };
  }
};
const transactions = createZaloTransactions(postgres);
const eventTransactions: TransactionRunner = {
  transaction<T>(body: (client: SqlClient) => Promise<T>): Promise<T> {
    return transactions.transaction(tx => body({
      query(sql, params = []) { return tx.query(sql, params); }
    }));
  }
};
const identities = config.ingress.test_users;
const webhookConfig: OfficialZaloWebhookConfig = {
  app_id: config.ingress.app_id,
  oa_id: config.ingress.oa_id,
  oa_secret_key: config.ingress.oa_secret_key,
  resolve_verified_user(userIdByApp) { return identities.get(userIdByApp) ?? null; }
};
const ingress = createOfficialZaloVerifiedIngress(
  webhookConfig,
  new PostgresInboundEventRepository(eventTransactions),
  transactions
);
const { verifier } = createOfficialZaloWebhookAdapter(webhookConfig);
const receiver = createStagingZaloReceiver({
  ...webhookConfig,
  test_user_ids: new Set(identities.keys())
}, ingress, verifier);
const app = buildLocalStagingApp(receiver);

async function assertLocalStagingSchema(): Promise<void> {
  const result = await pool.query<{ events: string | null; queue: string | null;
    quarantine: string | null; scopes: string | null }>(
    `SELECT to_regclass('public.zalo_inbound_events')::text AS events,
      to_regclass('public.zalo_process_queue')::text AS queue,
      to_regclass('public.zalo_official_quarantine')::text AS quarantine,
      to_regclass('public.zalo_official_quarantine_scopes')::text AS scopes`
  );
  const schema = result.rows[0];
  const idempotency = await pool.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='zalo_official_quarantine'
        AND column_name='provider_event_id'`
  );
  const providerEventIndex = await pool.query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes
      WHERE schemaname='public' AND tablename='zalo_official_quarantine'
        AND indexname='zalo_official_quarantine_event_id_unique'`
  );
  assertLocalStagingSchemaSnapshot({
    inbound_events: !!schema?.events,
    process_queue: !!schema?.queue,
    quarantine: !!schema?.quarantine,
    quarantine_scopes: !!schema?.scopes,
    provider_event_id_column: idempotency.rowCount === 1,
    provider_event_index_definition: providerEventIndex.rows[0]?.indexdef ?? null
  });
}

app.addHook('onClose', async () => { await pool.end(); });
try {
  await assertLocalStagingSchema();
  await app.listen({ host: config.host, port: config.port });
  console.info('AUTO-IN inbound-only local staging listener ready on loopback');
} catch {
  await app.close();
  console.error('AUTO-IN local staging start failed; check explicit local staging config and test database migrations');
  process.exitCode = 1;
}

for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => { void app.close(); });
