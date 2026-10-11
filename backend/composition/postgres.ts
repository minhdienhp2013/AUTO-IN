import type pg from 'pg';
import type { SqlPool } from '../storage/database.js';
export function asSqlPool(pool: pg.Pool): SqlPool {
  const query = async <T>(sql: string, args?: unknown[]) => {
    const result = await pool.query(sql, args);
    return { rows: result.rows as T[], rowCount: result.rowCount };
  };
  return { query, async connect() {
    const client = await pool.connect();
    return { async query<T>(sql: string, args?: unknown[]) {
      const result = await client.query(sql, args);
      return { rows: result.rows as T[], rowCount: result.rowCount };
    }, release: () => client.release() };
  } };
}
