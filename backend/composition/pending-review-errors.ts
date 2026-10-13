import { DomainError } from '../core/model.js';
import type { SqlPool, QueryResult } from '../storage/database.js';

/** Translate only AI0's known admission trigger, before AI1's HTTP wrapper
 * catches unexpected DB errors. Never change transaction/rollback semantics,
 * retry approval, or expose PostgreSQL detail/query/customer data to clients.
 */
export function pendingReviewSqlPool(pool: SqlPool): SqlPool {
  async function query<T>(run: () => Promise<QueryResult<T>>): Promise<QueryResult<T>> {
    try { return await run(); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'P0001' &&
          error.message === 'AI0_PENDING_INBOUND_REVIEW') {
        throw new DomainError('PENDING_INBOUND_REVIEW',
          'Có tin/file chưa đối soát; cần xử lý trước khi chốt in', 409);
      }
      throw error;
    }
  }
  return {
    query: <T>(sql: string, args?: unknown[]) => query(() => pool.query<T>(sql, args)),
    async connect() {
      const connection = await pool.connect();
      return {
        query: <T>(sql: string, args?: unknown[]) => query(() => connection.query<T>(sql, args)),
        release: () => connection.release()
      };
    }
  };
}
