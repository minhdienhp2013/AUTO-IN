import type {InboundEvent,InboundEventRepository} from "./protocol.ts";
/**
 * Optional PostgreSQL adapter; AI0/AI1 must create/approve migration and transaction
 * adapter. Do NOT use until tables are migrated. No in-memory substitute in live.
 */
export interface SqlClient {
  query(sql:string,params:readonly unknown[]):Promise<{rowCount:number|null}>;
}
export interface TransactionRunner {
  transaction<T>(body:(client:SqlClient)=>Promise<T>):Promise<T>;
}
export class PostgresInboundEventRepository implements InboundEventRepository {
  constructor(private readonly db:TransactionRunner) {}
  async insert_once(event:InboundEvent):Promise<"inserted"|"duplicate"> {
    return this.db.transaction(async tx=>{
      const written=await tx.query(
        `INSERT INTO zalo_inbound_events
        (oa_id,event_id,conversation_id,customer_id,occurred_at,payload_json,received_at)
        VALUES ($1,$2,$3,$4,$5,$6,now())
        ON CONFLICT (oa_id,event_id) DO NOTHING`,
        [event.oa_id,event.event_id,event.conversation_id,event.customer_id,
          event.occurred_at,JSON.stringify(event)]);
      if (written.rowCount === 0) return "duplicate";
      if (written.rowCount !== 1) throw new Error("EVENT_INSERT_UNCERTAIN");
      await tx.query(
        `INSERT INTO zalo_process_queue (oa_id,event_id,status,created_at)
        VALUES ($1,$2,'QUEUED',now())
        ON CONFLICT (oa_id,event_id) DO NOTHING`,
        [event.oa_id,event.event_id]);
      // Transaction runner MUST commit only after both statements succeed.
      return "inserted";
    });
  }
}
