import type {GatePort,GateSnapshot} from "../../conversation/gate.ts";
import type {AuthoritativeGateLock,PgTransactions,PgTx} from "./postgres-durable.ts";

/** AI1 CODE-201 owns core_conversation_controls and increments generation on
 * handover/return. AI2 reads it and takes a row lock, never modifies it.
 * The shop id MUST be injected from trusted OA/shop configuration by AI0.
 */
export class CoreConversationGate implements GatePort,AuthoritativeGateLock {
  private readonly db:PgTransactions;
  private readonly shop_id:string;
  constructor(db:PgTransactions,shop_id:string) {
    if(!shop_id || shop_id.length>128)throw new Error("INVALID_TRUSTED_SHOP");
    this.db=db;this.shop_id=shop_id;
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
