import { DomainError, idempotencyHash, type Principal } from '../core/model.js';

export interface QueryResult<T> { rows: T[]; rowCount: number | null; }
export interface SqlConnection { query<T = Record<string,unknown>>(sql: string, args?: unknown[]): Promise<QueryResult<T>>; release(): void; }
export interface SqlPool { connect(): Promise<SqlConnection>; query<T = Record<string,unknown>>(sql: string, args?: unknown[]): Promise<QueryResult<T>>; }
export class PgStore {
 constructor(readonly pool: SqlPool) {}
 async tx<T>(fn:(db: SqlConnection)=>Promise<T>): Promise<T> {
  const db=await this.pool.connect();
  try { await db.query('BEGIN'); const value=await fn(db); await db.query('COMMIT'); return value; }
  catch(error) { try { await db.query('ROLLBACK'); } catch { /* preserve original error */ } throw error; }
  finally { db.release(); }
 }
 async one<T>(db: SqlConnection, sql: string, args: unknown[]=[]): Promise<T> {
  const res=await db.query<T>(sql,args); if (!res.rows[0]) throw new DomainError('NOT_FOUND','Không tìm thấy dữ liệu',404); return res.rows[0];
 }
 async once<T>(db:SqlConnection, principal:Principal, action:string, key:string, payload:unknown, callback:()=>Promise<T>): Promise<T> {
  if (!key || key.length>128) throw new DomainError('IDEMPOTENCY_REQUIRED','Thiếu idempotency_key hợp lệ');
  const hash=idempotencyHash(principal,action,payload);
  // Unique insert with row-level conflict lock: second concurrent call blocks until first commits.
  const inserted=await db.query('INSERT INTO core_idempotency (shop_id, actor_id, action, key, payload_hash) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING key',[principal.shop_id,principal.id,action,key,hash]);
  if (!inserted.rows.length) {
   const previous=await this.one<{payload_hash:string;response:unknown}>(db,'SELECT payload_hash,response FROM core_idempotency WHERE shop_id=$1 AND actor_id=$2 AND action=$3 AND key=$4 FOR UPDATE',[principal.shop_id,principal.id,action,key]);
   if (previous.payload_hash!==hash) throw new DomainError('IDEMPOTENCY_CONFLICT','Cùng khóa nhưng dữ liệu khác nhau',409);
   if (previous.response === null) throw new DomainError('IDEMPOTENCY_PENDING','Yêu cầu đang xử lý',409,true);
   return previous.response as T;
  }
  const value=await callback();
  await db.query('UPDATE core_idempotency SET response=$5::jsonb WHERE shop_id=$1 AND actor_id=$2 AND action=$3 AND key=$4',[principal.shop_id,principal.id,action,key,JSON.stringify(value)]);
  return value;
 }
}
