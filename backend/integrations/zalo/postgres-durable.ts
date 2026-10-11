import {randomUUID} from "node:crypto";
import {batchKey,type Batch} from "../../conversation/batch.ts";
import type {GateSnapshot,OutboundPort} from "../../conversation/gate.ts";
import type {InboundEvent} from "./protocol.ts";

/** AI0 supplies a real PostgreSQL transaction runner (BEGIN/COMMIT/ROLLBACK).
 * Never use separate connections between gate lock and outbound reservation.
 */
export interface PgQueryResult<T> { rows:T[]; rowCount:number|null }
export interface PgTx {
  query<T = Record<string,unknown>>(sql:string,params?:readonly unknown[]):Promise<PgQueryResult<T>>;
}
export interface PgTransactions {
  transaction<T>(action:(tx:PgTx)=>Promise<T>):Promise<T>;
}
function positiveInt(value:number,max:number):number {
  if(!Number.isSafeInteger(value)||value<1||value>max) throw new Error("INVALID_QUEUE_LIMIT");
  return value;
}
function normalized(value:unknown):InboundEvent {
  const event=(typeof value==="string"?JSON.parse(value):value) as InboundEvent;
  if(!event||typeof event!=="object"||!event.oa_id||!event.event_id||
    !event.conversation_id||!event.customer_id) throw new Error("INVALID_STORED_EVENT");
  return event;
}
export interface LeasedBatch extends Batch { batch_id:string; lease_token:string; attempts:number }

/** Move durable incoming event markers into durable batches atomically.
 * A committed marker means batch item is committed, not that AI responded.
 * Multiple workers use FOR UPDATE SKIP LOCKED; crashes rollback all changes.
 */
export class PostgresConversationQueue {
  private readonly db:PgTransactions;
  private readonly oa_id:string | undefined;
  constructor(db:PgTransactions,oa_id?:string){this.db=db;this.oa_id=oa_id;}
  async ingest_pending(limit=100):Promise<number> {
    positiveInt(limit,1000);
    return this.db.transaction(async tx=>{
      const picked=await tx.query<{oa_id:string;event_id:string;payload_json:unknown}>(`
        SELECT q.oa_id,q.event_id,e.payload_json FROM zalo_process_queue q
        JOIN zalo_inbound_events e USING(oa_id,event_id)
        WHERE q.status='QUEUED' AND ($2::text IS NULL OR q.oa_id=$2)
        ORDER BY q.created_at,q.oa_id,q.event_id
        LIMIT $1 FOR UPDATE OF q SKIP LOCKED`,[limit,this.oa_id??null]);
      for(const row of picked.rows) {
        const evt=normalized(row.payload_json),key=batchKey(evt);
        const created=await tx.query<{id:string}>(`
          INSERT INTO zalo_batches(batch_key,oa_id) VALUES($1,$2)
          ON CONFLICT (batch_key) WHERE status='OPEN' DO NOTHING RETURNING id`,[key,evt.oa_id]);
        const found=await tx.query<{id:string}>(`
          SELECT id FROM zalo_batches WHERE batch_key=$1 AND oa_id=$2 AND status='OPEN'
          FOR UPDATE`,[key,evt.oa_id]);
        const id=found.rows[0]?.id;
        if(!id) throw new Error("BATCH_LOCK_UNAVAILABLE");
        const inserted=await tx.query(`
          INSERT INTO zalo_batch_items(batch_id,oa_id,event_id)
          VALUES($1,$2,$3) ON CONFLICT (oa_id,event_id) DO NOTHING`,
          [id,evt.oa_id,evt.event_id]);
        if(inserted.rowCount===1) {
          await tx.query(`UPDATE zalo_batches SET event_count=event_count+1,
            deadline_at=CASE WHEN $2 THEN deadline_at
            ELSE LEAST(first_at+interval '60 seconds',now()+interval '10 seconds') END
            WHERE id=$1`,[id,created.rowCount===1]);
        } else if(inserted.rowCount!==0) throw new Error("BATCH_INSERT_UNCERTAIN");
        const done=await tx.query(`UPDATE zalo_process_queue
          SET status='COMMITTED',committed_at=now()
          WHERE oa_id=$1 AND event_id=$2 AND status='QUEUED'`,[row.oa_id,row.event_id]);
        if(done.rowCount!==1) throw new Error("QUEUE_ACK_UNCERTAIN");
      }
      return picked.rows.length;
    });
  }

  /** Expired processing leases are allowed to run again: AI1 side effects MUST
   * be idempotent by event IDs; outbound IDs cannot be sent again after reserve.
   */
  async claim_due(limit=10,leaseSeconds=90):Promise<LeasedBatch[]> {
    positiveInt(limit,100);positiveInt(leaseSeconds,3600);
    return this.db.transaction(async tx=>{
      const rows=await tx.query<{id:string;batch_key:string;first_at:Date;
        deadline_at:Date;attempts:number}>(`
        SELECT id,batch_key,first_at,deadline_at,attempts FROM zalo_batches
        WHERE ((status='OPEN' AND deadline_at<=now())
           OR (status='LEASED' AND lease_until<=now()))
          AND ($2::text IS NULL OR oa_id=$2)
        ORDER BY deadline_at,id LIMIT $1 FOR UPDATE SKIP LOCKED`,[limit,this.oa_id??null]);
      const claimed:LeasedBatch[]=[];
      for(const row of rows.rows) {
        const token=randomUUID();
        const changed=await tx.query(`UPDATE zalo_batches SET status='LEASED',
          lease_token=$2::uuid,lease_until=now()+($3::int*interval '1 second'),
          attempts=attempts+1 WHERE id=$1`,[row.id,token,leaseSeconds]);
        if(changed.rowCount!==1) throw new Error("BATCH_LEASE_UNCERTAIN");
        const items=await tx.query<{payload_json:unknown}>(`
          SELECT e.payload_json FROM zalo_batch_items i
          JOIN zalo_inbound_events e USING(oa_id,event_id)
          WHERE i.batch_id=$1 ORDER BY e.occurred_at,e.event_id`,[row.id]);
        claimed.push({batch_id:String(row.id),lease_token:token,attempts:row.attempts+1,
          key:row.batch_key,first_at:new Date(row.first_at).getTime(),
          deadline_at:new Date(row.deadline_at).getTime(),
          events:items.rows.map(item=>normalized(item.payload_json))});
      }
      return claimed;
    });
  }
  async complete(batch:LeasedBatch):Promise<boolean> {
    return this.db.transaction(async tx=>{
      const result=await tx.query(`UPDATE zalo_batches SET status='DONE',
        lease_token=NULL,lease_until=NULL WHERE id=$1 AND lease_token=$2::uuid
        AND status='LEASED'`,[batch.batch_id,batch.lease_token]);
      return result.rowCount===1;
    });
  }
  async fail(batch:LeasedBatch,errorCode="PROCESSING_FAILED",maxAttempts=5):Promise<"retry"|"needs_human"|"lost_lease"> {
    positiveInt(maxAttempts,100);
    return this.db.transaction(async tx=>{
      const terminal=batch.attempts>=maxAttempts;
      const done=await tx.query(`UPDATE zalo_batches SET
        status=$3,lease_token=NULL,lease_until=NULL,
        deadline_at=CASE WHEN $3='OPEN' THEN now()+interval '10 seconds' ELSE deadline_at END,
        last_error_code=$4
        WHERE id=$1 AND lease_token=$2::uuid AND status='LEASED'`,
        [batch.batch_id,batch.lease_token,terminal?"NEEDS_HUMAN":"OPEN",errorCode.slice(0,100)]);
      return done.rowCount!==1?"lost_lease":terminal?"needs_human":"retry";
    });
  }
}

/** AI1-owned conversation control Port. This callback MUST lock AI1's
 * authoritative generation row using the SAME tx (SELECT FOR UPDATE).
 * Missing control/mismatch -> false, never silently assume mode AI.
 */
export interface AuthoritativeGateLock {
  lock_if_current(tx:PgTx,conversation_id:string,generation:number):Promise<boolean>;
}
export class PostgresOutboundRepository implements OutboundPort {
  private readonly db:PgTransactions;
  private readonly control:AuthoritativeGateLock;
  private readonly scope:{shop_id:string;oa_id:string} | undefined;
  constructor(db:PgTransactions,control:AuthoritativeGateLock,scope?:{shop_id:string;oa_id:string}){
    this.db=db;this.control=control;this.scope=scope;
    if(scope&&(!scope.shop_id||!scope.oa_id))throw new Error('INVALID_OUTBOUND_SCOPE');
  }
  async enqueue(input:{outbound_id:string;conversation_id:string;generation:number;text:string}):Promise<void> {
    if(!input.outbound_id||!input.conversation_id||!Number.isSafeInteger(input.generation)||
       input.generation<0||!input.text||input.text.length>4000) throw new Error("INVALID_OUTBOUND");
    await this.db.transaction(async tx=>{
      const inserted=await tx.query(`INSERT INTO zalo_outbound
        (outbound_id,conversation_id,generation,body_text,status,shop_id,oa_id)
        VALUES($1,$2,$3,$4,'QUEUED',$5,$6) ON CONFLICT(outbound_id) DO NOTHING`,
        [input.outbound_id,input.conversation_id,input.generation,input.text,
          this.scope?.shop_id??null,this.scope?.oa_id??null]);
      if(inserted.rowCount===1) return;
      const old=await tx.query<{conversation_id:string;generation:number;body_text:string;shop_id:string|null;oa_id:string|null}>(`
        SELECT conversation_id,generation,body_text,shop_id,oa_id FROM zalo_outbound
        WHERE outbound_id=$1 FOR UPDATE`,[input.outbound_id]);
      const value=old.rows[0];
      if(!value||value.conversation_id!==input.conversation_id||
         value.generation!==input.generation||value.body_text!==input.text||
         (value.shop_id??null)!==(this.scope?.shop_id??null)||
         (value.oa_id??null)!==(this.scope?.oa_id??null))
        throw new Error("OUTBOUND_IDEMPOTENCY_CONFLICT");
      // Keep SENT/UNKNOWN/CANCELLED/RESERVED unchanged; never resurrect a reply.
    });
  }
  /** Read-only polling: concurrent dispatchers compete through reserve_if_current; only one wins. */
  async list_queued(limit=20):Promise<Array<{outbound_id:string;conversation_id:string;generation:number;text:string}>> {
    positiveInt(limit,100);
    return this.db.transaction(async tx=>{
      const waiting=await tx.query<{outbound_id:string;conversation_id:string;generation:string;body_text:string}>(
        `SELECT outbound_id,conversation_id,generation::text AS generation,body_text
         FROM zalo_outbound WHERE status='QUEUED' AND
         ($2::text IS NULL OR (shop_id=$2 AND oa_id=$3))
         ORDER BY created_at,outbound_id LIMIT $1`,[limit,this.scope?.shop_id??null,this.scope?.oa_id??null]);
      return waiting.rows.map(row=>{
        const generation=Number(row.generation);
        if(!Number.isSafeInteger(generation)||generation<0)throw new Error('INVALID_OUTBOUND_GENERATION');
        return {outbound_id:row.outbound_id,conversation_id:row.conversation_id,generation,text:row.body_text};
      });
    });
  }
  async reserve_if_current(outbound_id:string,conversation_id:string,generation:number):Promise<boolean> {
    return this.db.transaction(async tx=>{
      if(!await this.control.lock_if_current(tx,conversation_id,generation)) return false;
      const changed=await tx.query(`UPDATE zalo_outbound SET status='RESERVED',reserved_at=now()
        WHERE outbound_id=$1 AND conversation_id=$2 AND generation=$3
        AND status='QUEUED'
        AND ($4::text IS NULL OR (shop_id=$4 AND oa_id=$5))`,
        [outbound_id,conversation_id,generation,this.scope?.shop_id??null,this.scope?.oa_id??null]);
      return changed.rowCount===1;
    });
  }
  async mark(outbound_id:string,status:"SENT"|"UNKNOWN"|"CANCELLED"):Promise<void> {
    const current=status==="CANCELLED"?"('QUEUED','RESERVED')":"('RESERVED')";
    await this.db.transaction(async tx=>{
      const result=await tx.query(`UPDATE zalo_outbound SET status=$2,finished_at=now()
        WHERE outbound_id=$1 AND status IN ${current}
        AND ($3::text IS NULL OR (shop_id=$3 AND oa_id=$4))`,
        [outbound_id,status,this.scope?.shop_id??null,this.scope?.oa_id??null]);
      if(result.rowCount!==1) throw new Error("OUTBOUND_INVALID_TRANSITION");
    });
  }
  /** Called after restart. Never move uncertain attempts back to QUEUED. */
  async reconcile_stale_reserved(seconds=120):Promise<number> {
    positiveInt(seconds,86400);
    return this.db.transaction(async tx=>{
      const result=await tx.query(`UPDATE zalo_outbound SET status='UNKNOWN',finished_at=now()
        WHERE status='RESERVED' AND reserved_at < now()-($1::int*interval '1 second')
          AND ($2::text IS NULL OR (shop_id=$2 AND oa_id=$3))`,
        [seconds,this.scope?.shop_id??null,this.scope?.oa_id??null]);
      return result.rowCount??0;
    });
  }
}
export function gateMatches(snapshot:GateSnapshot,conversation_id:string,generation:number):boolean {
  return snapshot.conversation_id===conversation_id &&
    snapshot.mode==="AI" && snapshot.generation===generation;
}
