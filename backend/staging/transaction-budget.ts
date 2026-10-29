import type { PgTransactions, PgTx } from '../integrations/zalo/postgres-durable.js';

/** Staging-only PostgreSQL limits. A lock wait or statement must not consume
 * the entire webhook response window before Zalo's retry can take over.
 */
export const STAGING_LOCK_TIMEOUT = '300ms';
export const STAGING_STATEMENT_TIMEOUT = '900ms';

export function createStagingTransactions(source: PgTransactions): PgTransactions {
  return {
    transaction<T>(action: (tx: PgTx) => Promise<T>): Promise<T> {
      return source.transaction(async tx => {
        await tx.query(`SET LOCAL lock_timeout = '${STAGING_LOCK_TIMEOUT}'`);
        await tx.query(`SET LOCAL statement_timeout = '${STAGING_STATEMENT_TIMEOUT}'`);
        return action(tx);
      });
    }
  };
}
