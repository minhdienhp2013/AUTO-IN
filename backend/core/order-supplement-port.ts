import { canonical, dbSafeInteger, DomainError, newId, sha, assertStaff, assertProcessor } from './model.js';
import type { Principal } from './model.js';
import type { PgStore, SqlConnection } from '../storage/database.js';

export interface TrustedSupplementScope { readonly shop_id:string; readonly oa_id:string; }
export interface AppendVerifiedEventsInput {
  order_id:string; conversation_id:string; customer_id:string;
  event_ids:readonly string[]; expected_revision:number;
  idempotency_key:string;
}
export type AppendVerifiedEventsResult =
 | {status:'appended'|'existing';order_id:string;revision:number;request_hash:string;requires_reconfirmation:true}
 | {status:'stale_revision';current_revision:number};

function bounded(value:string,field:string,max:number):string {
 if(typeof value!=='string'||!value.trim()||value.length>max)
  throw new DomainError('INVALID_INBOUND_SUPPLEMENT','Invalid '+field,422);
 return value;
}
function validEvents(input:readonly string[]):string[] {
 if(!Array.isArray(input)||input.length<1||input.length>100)
  throw new DomainError('INVALID_INBOUND_EVENTS','Expected 1-100 verified events',422);
 const ids=input.map(x=>bounded(x,'event_id',256));
 if(new Set(ids).size!==ids.length)throw new DomainError('DUPLICATE_INBOUND_EVENTS','Repeated event ID',422);
 return ids.sort();
}

/** AI0-only: server trusted OA/shop and an actual authenticated processor or staff actor.
 * Never creates orders, guesses intent, authenticates customers or approves/prints.
 * A verified file event is referenced by ID only, not by client-provided file URL.
 * New revision has plan NULL until processor verifies all current files.
 */
export function createOrderSupplementPort(options:{store:PgStore;trusted:TrustedSupplementScope}) {
 const {store,trusted}=options;
 if(!store?.tx||!trusted||typeof trusted.shop_id!=='string'||!trusted.shop_id.trim()||
    typeof trusted.oa_id!=='string'||!trusted.oa_id.trim())
   throw new DomainError('SUPPLEMENT_PORT_UNCONFIGURED','Requires server OA/shop mapping',503);
 const shopId=bounded(trusted.shop_id,'shop_id',128);
 const oaId=bounded(trusted.oa_id,'oa_id',256);
 return {
  async append_verified_events(actor:Principal,input:AppendVerifiedEventsInput):Promise<AppendVerifiedEventsResult>{
   if(actor?.role==='processor')assertProcessor(actor);else assertStaff(actor);
   if(actor.shop_id!==shopId)throw new DomainError('SUPPLEMENT_SHOP_FORBIDDEN','Wrong actor shop',403);
   const id=bounded(input.order_id,'order_id',100),conv=bounded(input.conversation_id,'conversation_id',256);
   const customer=bounded(input.customer_id,'customer_id',256),ids=validEvents(input.event_ids);
   const key=bounded(input.idempotency_key,'idempotency_key',128);
   if(!Number.isSafeInteger(input.expected_revision)||input.expected_revision<1)
    throw new DomainError('INVALID_SUPPLEMENT_REVISION','Invalid revision',422);
   const fingerprint=sha(canonical({order_id:id,event_ids:ids}));
   return store.tx(async db=>{
    // Lock the same row as staff approve; no update can race between approval and revision.
    const orders=await db.query<{id:string;shop_id:string;customer_id:string;conversation_id:string|null;
     active_revision:number;manual_lock:boolean;print_closed:boolean}>(
     'SELECT id,shop_id,customer_id,conversation_id,active_revision,manual_lock,print_closed FROM core_orders WHERE id=$1 FOR UPDATE',[id]);
    const order=orders.rows[0];
    if(!order||order.shop_id!==shopId||order.customer_id!==customer||order.conversation_id!==conv)
     throw new DomainError('SUPPLEMENT_ORDER_SCOPE_MISMATCH','Order/shop/customer/conversation mismatch',403);
    const binding=await db.query(
     'SELECT 1 FROM core_ai_draft_proposals WHERE order_id=$1 AND shop_id=$2 AND oa_id=$3 AND customer_id=$4 AND conversation_id=$5',
     [id,shopId,oaId,customer,conv]);
    if(binding.rows.length!==1)
     throw new DomainError('SUPPLEMENT_ORDER_NOT_LINKED','Order has no verified OA binding',403);
    const existing=await db.query<{revision:number;event_fingerprint:string;idempotency_key:string;request_hash:string}>(
     'SELECT revision,event_fingerprint,idempotency_key,request_hash FROM core_order_supplement_batches WHERE order_id=$1 AND (event_fingerprint=$2 OR idempotency_key=$3) FOR UPDATE',
     [id,fingerprint,key]);
    if(existing.rows.length) {
     const batch=existing.rows[0];
     if(existing.rows.length!==1||!batch||batch.event_fingerprint!==fingerprint)
      throw new DomainError('SUPPLEMENT_IDEMPOTENCY_CONFLICT','Idempotency key reused with different event set',409);
     return {status:'existing',order_id:id,revision:batch.revision,request_hash:batch.request_hash,
      requires_reconfirmation:true as const};
    }
    if(order.active_revision!==input.expected_revision)
     return {status:'stale_revision',current_revision:order.active_revision};
    const approved=await db.query(
     'SELECT 1 FROM core_approvals WHERE order_id=$1 LIMIT 1',[id]);
    const jobs=await db.query('SELECT 1 FROM core_print_jobs WHERE order_id=$1 LIMIT 1',[id]);
    if(approved.rows.length||jobs.rows.length||order.manual_lock||order.print_closed)
     throw new DomainError('ORDER_ALREADY_FINALIZED','Order already approved/locked; do not append',409);
    const events=await db.query<{event_id:string;customer_id:string;conversation_id:string;kind:string;received_at:Date}>(
     "SELECT event_id,customer_id,conversation_id,payload_json->>'kind' AS kind,received_at FROM zalo_inbound_events WHERE oa_id=$1 AND event_id=ANY($2::text[]) FOR SHARE",
     [oaId,ids]);
    if(events.rows.length!==ids.length||events.rows.some(e=>e.customer_id!==customer||e.conversation_id!==conv||
       !['text','image','file'].includes(e.kind)))
     throw new DomainError('SUPPLEMENT_EVENTS_UNVERIFIED','Unverified inbound event or unsupported kind',403);
    const clashes=await db.query<{event_id:string}>(
     'SELECT event_id FROM core_order_inbound_reviews WHERE oa_id=$1 AND event_id=ANY($2::text[]) LIMIT 1',[oaId,ids]);
    if(clashes.rows.length)
     throw new DomainError('SUPPLEMENT_EVENT_ALREADY_USED','An event is already included in another revision',409);
    const rev=await db.query<{revision:number;request_data:unknown}>(
     'SELECT revision,request_data FROM core_revisions WHERE order_id=$1 AND revision=$2',[id,order.active_revision]);
    const current=rev.rows[0];
    if(!current||!current.request_data||typeof current.request_data!=='object'||Array.isArray(current.request_data))
     throw new DomainError('SUPPLEMENT_NEEDS_HUMAN','Cannot safely preserve current order data',409);
    const data=current.request_data as Record<string,unknown>;
    const originalIds=Array.isArray(data.event_ids)?data.event_ids:[];
    if(originalIds.some(x=>typeof x!=='string'))
     throw new DomainError('SUPPLEMENT_NEEDS_HUMAN','Untrusted original event list',409);
    if(ids.some(e=>originalIds.includes(e)))throw new DomainError('SUPPLEMENT_EVENT_ALREADY_USED','Event already in order',409);
    const supplements=Array.isArray(data.supplements)?data.supplements:[];
    const nextData={...data,event_ids:[...originalIds,...ids],
     supplements:[...supplements,{event_ids:ids,source:'verified_zalo_inbound',kinds:events.rows.map(e=>e.kind)}]};
    const hash=sha(canonical(nextData));
    const revision=order.active_revision+1;
    if(!Number.isSafeInteger(revision))throw new DomainError('REVISION_OVERFLOW','Revision counter exhausted',409);
    await db.query(
     'INSERT INTO core_revisions(order_id,revision,request_hash,request_data,plan) VALUES($1,$2,$3,$4::jsonb,NULL)',
     [id,revision,hash,JSON.stringify(nextData)]);
    await db.query('UPDATE core_orders SET active_revision=$2,updated_at=now() WHERE id=$1',[id,revision]);
    await db.query(
     'INSERT INTO core_order_supplement_batches(order_id,shop_id,oa_id,event_fingerprint,idempotency_key,revision,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7)',
     [id,shopId,oaId,fingerprint,key,revision,hash]);
    for(const eventId of ids)await db.query(
     'INSERT INTO core_order_inbound_reviews(shop_id,oa_id,event_id,order_id,revision,reviewed_by) VALUES($1,$2,$3,$4,$5,$6)',
     [shopId,oaId,eventId,id,revision,actor.id]);
    await db.query(
     'INSERT INTO core_audit(id,shop_id,actor_id,action,order_id,details) VALUES($1,$2,$3,$4,$5,$6::jsonb)',
     [newId(),shopId,actor.id,'order.inbound_appended',id,JSON.stringify({revision,event_count:ids.length})]);
    return {status:'appended',order_id:id,revision,request_hash:hash,requires_reconfirmation:true as const};
   });
  }
 };
}
