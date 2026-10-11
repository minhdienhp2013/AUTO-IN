import type {GatePort,GateSnapshot} from "../../conversation/gate.ts";
import type {Batch} from "../../conversation/batch.ts";
import type {AuthoritativeGateLock,PgTransactions,PgTx} from "./postgres-durable.ts";

/** AI1 CODE-201 owns core_conversation_controls and increments generation on
 * handover/return. AI2 reads it and takes a row lock, never modifies it.
 * The shop id MUST be injected from trusted OA/shop configuration by AI0.
 */
export class CoreConversationGate implements GatePort,AuthoritativeGateLock {
  private readonly db:PgTransactions;
  private readonly shop_id:string;
  private readonly oa_id:string|undefined;
  constructor(db:PgTransactions,shop_id:string,oa_id?:string) {
    if(!shop_id || shop_id.length>128)throw new Error("INVALID_TRUSTED_SHOP");
    this.db=db;this.shop_id=shop_id;this.oa_id=oa_id;
  }
  private async fetch(tx:PgTx,conversation_id:string,lock:boolean):
    Promise<{generation:number;mode:"AI"|"HUMAN"}|undefined> {
    if(!conversation_id||conversation_id.length>256)throw new Error("INVALID_CONVERSATION");
    const row=await tx.query<{generation:string;status:"AI"|"HUMAN"}>(
      `SELECT generation::text AS generation,status FROM core_conversation_controls
       WHERE shop_id=$1 AND conversation_id=$2 ${lock?"FOR UPDATE":""}`,
      [this.shop_id,conversation_id]);
    const current=row.rows[0];
    if(!current)return undefined; // Missing AI1 linked control always denies outbound.
    const generation=Number(current.generation);
    if(!Number.isSafeInteger(generation)||generation<0 ||
       !["AI","HUMAN"].includes(current.status))throw new Error("INVALID_CONTROL_ROW");
    return {generation,mode:current.status};
  }
  /** Initial conversation is not yet linked until AI1 first proposes a draft
   * or routes staff. Its transaction creates the control row with generation=0.
   * Return provisional generation ZERO ONLY after verifying the exact persisted
   * inbound event set belongs to this trusted OA, shop and conversation.
   * No control table writes here; AI1 remains sole owner of that mutation.
   * Final outbound always requires an actual control row and its PG row lock.
   */
  async read_verified_batch(batch:Batch):Promise<GateSnapshot>{
    if(!this.oa_id)throw new Error("TRUSTED_OA_REQUIRED");
    const first=batch.events[0];
    if(!first||batch.events.length>100||batch.events.some(e=>
      e.oa_id!==this.oa_id||e.customer_id!==first.customer_id||
      e.conversation_id!==first.conversation_id))throw new Error("INVALID_VERIFIED_BATCH");
    const ids=[...new Set(batch.events.map(e=>e.event_id))].sort();
    if(ids.length!==batch.events.length)throw new Error("DUPLICATE_BATCH_EVENT");
    return this.db.transaction(async tx=>{
      const current=await this.fetch(tx,first.conversation_id,false);
      if(current)return {conversation_id:first.conversation_id,...current};
      const shop=await tx.query(
        "SELECT shop_id FROM core_shop_settings WHERE shop_id=$1 FOR SHARE",[this.shop_id]);
      if(shop.rows.length!==1)throw new Error("UNVERIFIED_SHOP");
      const verified=await tx.query<{event_id:string;conversation_id:string;customer_id:string}>(
        `SELECT event_id,conversation_id,customer_id FROM zalo_inbound_events
         WHERE oa_id=$1 AND event_id=ANY($2::text[]) FOR SHARE`,[this.oa_id,ids]);
      if(verified.rows.length!==ids.length||verified.rows.some(e=>
        e.conversation_id!==first.conversation_id||e.customer_id!==first.customer_id))
        throw new Error("UNVERIFIED_BATCH_EVENTS");
      const other=await tx.query(
        `SELECT id FROM core_orders WHERE shop_id=$1 AND conversation_id=$2
          AND customer_id<>$3 LIMIT 1 FOR SHARE`,
        [this.shop_id,first.conversation_id,first.customer_id]);
      if(other.rows.length)throw new Error("VERIFIED_CUSTOMER_MISMATCH");
      return {conversation_id:first.conversation_id,generation:0,mode:"AI" as const};
    });
  }
  async read(conversation_id:string):Promise<GateSnapshot>{
    const current=await this.db.transaction(tx=>this.fetch(tx,conversation_id,false));
    if(!current)throw new Error("UNLINKED_CONVERSATION");
    return {conversation_id,generation:current.generation,mode:current.mode};
  }
  async lock_if_current(tx:PgTx,conversation_id:string,generation:number):Promise<boolean>{
    if(!Number.isSafeInteger(generation)||generation<0)return false;
    const current=await this.fetch(tx,conversation_id,true);
    return !!current&&current.mode==="AI"&&current.generation===generation;
  }
}
