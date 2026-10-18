import type { FastifyPluginAsync } from 'fastify';
import { createOfficialZaloVerifiedIngress } from '../integrations/zalo/official-quarantine.js';
import type { OfficialZaloWebhookConfig } from '../integrations/zalo/official-webhook.js';
import { PostgresInboundEventRepository, type SqlClient, type TransactionRunner } from '../integrations/zalo/postgres-events.js';
import { createZaloTransactions, type PostgreSqlPool } from '../integrations/zalo/transaction-runner.js';
import type { SqlPool } from '../storage/database.js';
import type { PgStore } from '../storage/database.js';
import { createOfficialInboundReviewItems } from '../core/inbound-review-items.js';
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
  scope: OfficialZaloSimulationScope,
  coreStore: PgStore
): FastifyPluginAsync {
  if (!scope || typeof scope.shop_id !== 'string' || !scope.shop_id.trim() ||
      scope.shop_id.length > 128 || !scope.webhook)
    throw new Error('OFFICIAL_ZALO_SIMULATION_SCOPE_REQUIRED');
  if (!coreStore || typeof coreStore.tx !== 'function')
    throw new Error('OFFICIAL_ZALO_CORE_STORE_REQUIRED');
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
  const reviewItems = createOfficialInboundReviewItems({
    store: coreStore,
    trusted: { shop_id: scope.shop_id, oa_id: webhook.oa_id }
  });
  const guarded = {
    async receive_webhook(raw: Uint8Array, headers: Readonly<Record<string, string>>) {
      const binding = await pool.query(
        'SELECT 1 FROM core_shop_zalo_oa_registry WHERE shop_id=$1 AND oa_id=$2 AND app_id=$3',
        [scope.shop_id, webhook.oa_id, webhook.app_id]
      );
      if (binding.rows.length !== 1) {
        return { status_code: 503, body: { error: { code: 'OFFICIAL_ZALO_SCOPE_NOT_REGISTERED' } } };
      }
      const received = await ingress.receive_webhook(raw, headers);
      if (received.status_code !== 200 || !received.body || typeof received.body !== 'object' ||
          Array.isArray(received.body)) return received;
      const receipt = received.body as {
        status?: unknown; receipt_id?: unknown; pending?: unknown; kind?: unknown
      };
      // Core enqueue runs only after AI2 reports the quarantine transaction
      // committed. Replaying a pending duplicate repairs a crash in the narrow
      // gap between the two durable writes; Core uniqueness prevents duplicates.
      if ((receipt.status === 'held' || receipt.status === 'duplicate') &&
          receipt.pending === true && (receipt.kind === 'image' || receipt.kind === 'file') &&
          typeof receipt.receipt_id === 'string') {
        try {
          await reviewItems.enqueue_quarantined_event(receipt.receipt_id);
        } catch {
          // Do not acknowledge quarantine without its staff queue pointer.
          // The provider retry replays the committed receipt and repairs it.
          return { status_code: 503, body: { error: { code: 'OFFICIAL_INGRESS_UNAVAILABLE' } } };
        }
      }
      return received;
    }
  };
  return createZaloRawWebhook(guarded);
}
