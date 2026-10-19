import type pg from 'pg';
import type { SqlPool } from '../storage/database.js';

/** This server is simulation-only. Refuse remote or production databases before
 * creating a pool so a mistyped DATABASE_URL cannot write into real shop data.
 */
export function assertIsolatedSimulationDatabase(connectionString: string): void {
  let url: URL;
  try { url = new URL(connectionString); }
  catch { throw new Error('DATABASE_URL must be a valid PostgreSQL URL'); }
  const refusal = () => new Error(
    'Simulation server requires an isolated autoin_test database on numeric loopback at explicit port 5432 without URL overrides'
  );
  const authorityHost = url.hostname.replace(/^\[(.+)\]$/, '$1').toLowerCase();
  const numericLoopbackHosts = new Set(['127.0.0.1', '::1']);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
      !numericLoopbackHosts.has(authorityHost) || url.port !== '5432' || url.search || url.hash) {
    throw refusal();
  }
  let database: string;
  try { database = decodeURIComponent(url.pathname.slice(1)); }
  catch { throw refusal(); }
  // Requiring explicit numeric host + port and rejecting URL parameters keeps
  // PGHOST/PGPORT and pg-connection-string query overrides from redirecting
  // the pool constructed after this guard.
  if (!/^(?:autoin_test|auto_in_test)(?:_[a-z0-9]+)?$/i.test(database)) {
    throw refusal();
  }
}

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
