import type { FastifyPluginAsync } from 'fastify';
import { createOfficialZaloVerifiedIngress } from '../integrations/zalo/official-quarantine.js';
import type { OfficialZaloWebhookConfig } from '../integrations/zalo/official-webhook.js';
import { PostgresInboundEventRepository, type SqlClient, type TransactionRunner } from '../integrations/zalo/postgres-events.js';
import { createZaloTransactions, type PostgreSqlPool } from '../integrations/zalo/transaction-runner.js';
import type { SqlPool } from '../storage/database.js';
import { createZaloRawWebhook } from './zalo-http.js';

export interface OfficialZaloSimulationScope {
  /** Trusted server configuration; never derived from the event payload. */
  readonly shop_id: string;
  readonly webhook: OfficialZaloWebhookConfig;
}

/** Explicit synthetic-signature composition for isolated simulation tests.
 * The production server never reads this option or registers this route.
 * A persisted non-secret shop/app/OA binding is required before ingress.
 * Public Zalo signature canonicalization/provider schemas remain unverified.
 */
export function createOfficialZaloSimulationWebhook(
  pool: SqlPool,
  scope: OfficialZaloSimulationScope
): FastifyPluginAsync {
  if (!scope || typeof scope.shop_id !== 'string' || !scope.shop_id.trim() ||
      scope.shop_id.length > 128 || !scope.webhook)
    throw new Error('OFFICIAL_ZALO_SIMULATION_SCOPE_REQUIRED');
  const { webhook } = scope;
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
        query(sql, params = []) {
          return tx.query(sql, params);
        }
      }));
    }
  };
  const events = new PostgresInboundEventRepository(eventTransactions);
  const ingress = createOfficialZaloVerifiedIngress(webhook, events, transactions);
  const guarded = {
    async receive_webhook(raw: Uint8Array, headers: Readonly<Record<string, string>>) {
      const binding = await pool.query(
        'SELECT 1 FROM core_shop_zalo_oa_registry WHERE shop_id=$1 AND oa_id=$2 AND app_id=$3',
        [scope.shop_id, webhook.oa_id, webhook.app_id]
      );
      if (binding.rows.length !== 1) {
        return { status_code: 503, body: { error: { code: 'OFFICIAL_ZALO_SCOPE_NOT_REGISTERED' } } };
      }
      return ingress.receive_webhook(raw, headers);
    }
  };
  return createZaloRawWebhook(guarded);
}
