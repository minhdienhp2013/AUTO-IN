import type { FastifyPluginAsync } from 'fastify';
import { createOfficialZaloVerifiedIngress } from '../integrations/zalo/official-quarantine.js';
import type { OfficialZaloWebhookConfig } from '../integrations/zalo/official-webhook.js';
import { PostgresInboundEventRepository, type SqlClient, type TransactionRunner } from '../integrations/zalo/postgres-events.js';
import { createZaloTransactions, type PostgreSqlPool } from '../integrations/zalo/transaction-runner.js';
import type { SqlPool } from '../storage/database.js';
import { createZaloRawWebhook } from './zalo-http.js';

/** Explicit synthetic-contract composition for isolated simulation tests.
 * The production server never reads this option or registers this route.
 * Public Zalo signature canonicalization/provider schemas remain unverified.
 */
export function createOfficialZaloSimulationWebhook(
  pool: SqlPool,
  config: OfficialZaloWebhookConfig
): FastifyPluginAsync {
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
  const ingress = createOfficialZaloVerifiedIngress(config, events, transactions);
  return createZaloRawWebhook(ingress);
}
