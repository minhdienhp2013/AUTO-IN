import type {PgTransactions,PgTx,PgQueryResult} from './postgres-durable.ts';

/** Structural PG interfaces: pg.Pool matches these without importing AI1 code
 * or creating a second database. AI0 supplies the already-configured pool.
 * A SINGLE checked-out client is used for every query, including AI1's
 * core_conversation_controls FOR UPDATE and AI2's outbound reservation.
 */
export interface PostgreSqlClient {
  query(sql:string,params?:unknown[]):Promise<{rows:unknown[];rowCount:number|null}>;
  release():void;
}
export interface PostgreSqlPool {
  connect():Promise<PostgreSqlClient>;
}
export function createZaloTransactions(pool:PostgreSqlPool):PgTransactions {
  return {
    async transaction<T>(work:(tx:PgTx)=>Promise<T>):Promise<T> {
      const client=await pool.connect();
      try {
        await client.query('BEGIN');
        const tx:PgTx={
          async query<R=Record<string,unknown>>(sql:string,params:readonly unknown[]=[]):Promise<PgQueryResult<R>> {
            const result=await client.query(sql,[...params]);
            return {rows:result.rows as R[],rowCount:result.rowCount};
          }
        };
        const answer=await work(tx);
        await client.query('COMMIT');
        return answer;
      } catch (error) {
        try {await client.query('ROLLBACK');} catch { /* original error takes priority */ }
        throw error;
      } finally {
        client.release();
      }
    }
  };
}
