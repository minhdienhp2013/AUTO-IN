import type { FastifyPluginAsync } from 'fastify';
import { createOfficialZaloVerifiedIngress } from '../integrations/zalo/official-quarantine.js';
import type { OfficialZaloWebhookConfig } from '../integrations/zalo/official-webhook.js';
import { PostgresInboundEventRepository, type TransactionRunner, type SqlClient } from '../integrations/zalo/postgres-events.js';
import type { PgTransactions, PgTx } from '../integrations/zalo/postgres-durable.js';
import type { SqlPool } from '../storage/database.js';

export type OfficialZaloSimulationCredentials = Pick<
  OfficialZaloWebhookConfig, 'app_id' | 'oa_id' | 'oa_secret_key'
>;

function createTransactions(pool: SqlPool): PgTransactions {
  return {
    async transaction<T>(action: (tx: PgTx) => Promise<T>): Promise<T> {
      const connection = await pool.connect();
      try {
        await connection.query('BEGIN');
        const tx: PgTx = {
          query: async <R = Record<string, unknown>>(sql: string, params: readonly unknown[] = []) => {
            const result = await connection.query<R>(sql, [...params]);
            return { rows: result.rows, rowCount: result.rowCount };
          }
        };
        const result = await action(tx);
        await connection.query('COMMIT');
        return result;
      } catch (error) {
        try { await connection.query('ROLLBACK'); } catch { /* preserve original error */ }
        throw error;
      } finally {
        connection.release();
      }
    }
  };
}

function createInboundEventRepository(transactions: PgTransactions): PostgresInboundEventRepository {
  const runner: TransactionRunner = {
    transaction<T>(action: (client: SqlClient) => Promise<T>): Promise<T> {
      return transactions.transaction(tx => action({
        query: async (sql: string, params: readonly unknown[]) =>
          (await tx.query(sql, params)).rowCount
      }));
    }
  };
  return new PostgresInboundEventRepository(runner);
}

/**
 * Create a raw-body Fastify route only for an explicitly injected simulation
 * runtime. OA/app/shop and user/chat bindings are loaded from AI0's server-owned
 * registry; secrets are passed by the caller and never stored in PostgreSQL.
 * The default server does not call this factory and continues returning 503.
 */
export async function createOfficialZaloWebhookPlugin(
  pool: SqlPool,
  credentials: OfficialZaloSimulationCredentials
): Promise<FastifyPluginAsync> {
  if (!credentials || !credentials.app_id || !credentials.oa_id ||
      typeof credentials.oa_secret_key !== 'string' || !credentials.oa_secret_key.startsWith('synthetic-only-') || credentials.oa_secret_key.length < 16)
    throw new Error('OFFICIAL_ZALO_SIMULATION_CONFIG_REQUIRED');

  const registration = await pool.query<{ shop_id: string }>(
    'SELECT r.shop_id ' +
    'FROM ai0_official_zalo_oa_registry r ' +
    'JOIN core_shop_settings s ON s.shop_id=r.shop_id AND s.mode=$3 ' +
    'WHERE r.oa_id=$1 AND r.app_id=$2 AND r.enabled=true',
    [credentials.oa_id, credentials.app_id, 'simulation']
  );
  if (registration.rows.length !== 1) throw new Error('OFFICIAL_ZALO_SIMULATION_SCOPE_DISABLED');
  const shopId = registration.rows[0]!.shop_id;

  const mapped = await pool.query<{
    provider_user_id: string; customer_id: string; conversation_id: string
  }>(
    'SELECT provider_user_id,customer_id,conversation_id ' +
    'FROM ai0_official_zalo_identity_map ' +
    'WHERE oa_id=$1 AND shop_id=$2 AND active=true ' +
    'ORDER BY provider_user_id',
    [credentials.oa_id, shopId]
  );
  const users = new Map<string, { customer_id: string; conversation_id: string }>();
  for (const row of mapped.rows) {
    if (users.has(row.provider_user_id)) throw new Error('OFFICIAL_ZALO_IDENTITY_AMBIGUOUS');
    users.set(row.provider_user_id, {
      customer_id: row.customer_id,
      conversation_id: row.conversation_id
    });
  }

  const transactions = createTransactions(pool);
  const events = createInboundEventRepository(transactions);
  const ingress = createOfficialZaloVerifiedIngress({
    ...credentials,
    resolve_verified_user: providerUserId => users.get(providerUserId) ?? null
  }, events, transactions);

  const plugin: FastifyPluginAsync = async scoped => {
    // Keep the exact JSON bytes for signature verification in this route scope.
    scoped.removeContentTypeParser('application/json');
    scoped.addContentTypeParser('application/json', { parseAs: 'buffer' },
      (_request, body, done) => done(null, body));
    scoped.post('/webhooks/zalo', async (request, reply) => {
      if (!Buffer.isBuffer(request.body))
        return reply.code(400).send({ error: { code: 'RAW_BODY_REQUIRED' } });
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.headers))
        if (typeof value === 'string') headers[name] = value;
      const result = await ingress.receive_webhook(request.body, headers);
      return reply.code(result.status_code).send(result.body);
    });
  };
  return plugin;
}
