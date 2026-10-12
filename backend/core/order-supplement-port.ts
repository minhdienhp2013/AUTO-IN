import { canonical, dbSafeInteger, DomainError, newId, sha, assertStaff, assertProcessor } from './model.js';
import type { Principal } from './model.js';
import type { PgStore, SqlConnection } from '../storage/database.js';

export interface TrustedSupplementScope { readonly shop_id:string; readonly oa_id:string; }
export interface AppendVerifiedEventsInput {
  order_id:string; conversation_id:string; customer_id:string;
  event_ids:readonly string[]; expected_revision:number;
  idempotency_key:string;
}
export type ApplyIncomingBatchResult =
 | {status:'appended'|'existing'|'created';order_id:string;revision:number;request_hash:string;requires_reconfirmation:true}
 | {status:'stale_generation'|'stale_revision'|'ambiguous'|'closed'|'needs_review';order_id?:string;current_revision?:number};
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
export interface TrustedSeparateIntent {
 (db:SqlConnection,scope:{shop_id:string;oa_id:string;customer_id:string;conversation_id:string;event_ids:readonly string[]}):Promise<boolean>;
}
export function createOrderSupplementPort(options:{store:PgStore;trusted:TrustedSupplementScope;
 processor?:Principal;verifyExplicitSeparate?:TrustedSeparateIntent}) {
 const {store,trusted}=options;
 if(!store?.tx||!trusted||typeof trusted.shop_id!=='string'||!trusted.shop_id.trim()||
    typeof trusted.oa_id!=='string'||!trusted.oa_id.trim())
   throw new DomainError('SUPPLEMENT_PORT_UNCONFIGURED','Requires server OA/shop mapping',503);
 const shopId=bounded(trusted.shop_id,'shop_id',128);
 const oaId=bounded(trusted.oa_id,'oa_id',256);
 async function append_verified_events(actor:Principal,input:AppendVerifiedEventsInput):Promise<AppendVerifiedEventsResult>{
   if(actor?.role==='processor')assertProcessor(actor);else assertStaff(actor);
   if(actor.shop_id!==shopId)throw new DomainError('SUPPLEMENT_SHOP_FORBIDDEN','Wrong actor shop',403);
   const id=bounded(input.order_id,'order_id',100),conv=bounded(input.conversation_id,'conversation_id',256);
   const customer=bounded(input.customer_id,'customer_id',256),ids=validEvents(input.event_ids);
   const key=bounded(input.idempotency_key,'idempotency_key',128);
   if(!Number.isSafeInteger(input.expected_revision)||input.expected_revision<1)
    throw new DomainError('INVALID_SUPPLEMENT_REVISION','Invalid revision',422);
   const fingerprint=sha(canonical({order_id:id,event_ids:ids}));
   return store.tx(db=>appendInside(db,actor,{id,conv,customer,ids,key,fingerprint,expected_revision:input.expected_revision}));
  }
  async function appendInside(db:SqlConnection,actor:Principal,values:{id:string;conv:string;customer:string;ids:string[];key:string;fingerprint:string;expected_revision:number}):Promise<AppendVerifiedEventsResult>{
   const {id,conv,customer,ids,key,fingerprint}=values;
   const input={expected_revision:values.expected_revision};
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
  }

  async function apply_incoming_batch(input:{
   conversation_id:string;customer_id:string;event_ids:readonly string[];text:string;
   idempotency_key:string;expected_generation:number;expected_revision?:number;
   intent:'append_or_create'|'explicit_separate'; materialized?:boolean;
  }):Promise<ApplyIncomingBatchResult>{
   // Trusted processor is injected by AI0 at factory time, not passed in by AI2.
   const actor=options.processor;
   if(!actor)throw new DomainError('VERIFIED_PROCESSOR_REQUIRED','Missing trusted processor',403);
   assertProcessor(actor);
   if(actor.shop_id!==shopId)throw new DomainError('SUPPLEMENT_SHOP_FORBIDDEN','Wrong tenant',403);
   const conv=bounded(input.conversation_id,'conversation_id',256);
   const customer=bounded(input.customer_id,'customer_id',256);
   const ids=validEvents(input.event_ids);
   const key=bounded(input.idempotency_key,'idempotency_key',128);
   const content=bounded(input.text,'text',4000);
   if(!Number.isSafeInteger(input.expected_generation)||input.expected_generation<0)
    throw new DomainError('INVALID_AI_GENERATION','Invalid generation',422);
   if(input.intent!=='append_or_create'&&input.intent!=='explicit_separate')
    throw new DomainError('UNVERIFIED_SEPARATE_INTENT','Unrecognized intent',422);
   if(input.expected_revision!==undefined&&(!Number.isSafeInteger(input.expected_revision)||input.expected_revision<1))
    throw new DomainError('INVALID_SUPPLEMENT_REVISION','Invalid revision',422);
   return store.tx<ApplyIncomingBatchResult>(async db=>{
    // One transaction; shared conversation advisory mutex serializes simultaneous
    // creation/selection by AI2 workers, then order row lock serializes staff approve.
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))',
     [JSON.stringify([shopId,oaId,customer,conv])]);
    const trustedEvents=await db.query<{event_id:string;customer_id:string;conversation_id:string;kind:string}>(
     "SELECT event_id,customer_id,conversation_id,payload_json->>'kind' AS kind FROM zalo_inbound_events WHERE oa_id=$1 AND event_id=ANY($2::text[]) FOR SHARE",
     [oaId,ids]);
    if(trustedEvents.rows.length!==ids.length||trustedEvents.rows.some(e=>e.customer_id!==customer||
       e.conversation_id!==conv||!['text','image','file'].includes(e.kind)))
     throw new DomainError('SUPPLEMENT_EVENTS_UNVERIFIED','Event scope/source mismatch',403);
    const binding=await db.query('SELECT 1 FROM core_shop_settings WHERE shop_id=$1 FOR SHARE',[shopId]);
    if(!binding.rows.length)throw new DomainError('SUPPLEMENT_SHOP_FORBIDDEN','Unknown shop',403);
    const list=await db.query<{id:string;active_revision:number;manual_lock:boolean;print_closed:boolean;approved:boolean}>(
     "SELECT o.id,o.active_revision,o.manual_lock,o.print_closed,EXISTS(SELECT 1 FROM core_approvals a WHERE a.order_id=o.id) AS approved "+
     "FROM core_orders o JOIN core_ai_draft_proposals p ON p.order_id=o.id AND p.shop_id=o.shop_id "+
     "WHERE p.shop_id=$1 AND p.oa_id=$2 AND p.customer_id=$3 AND p.conversation_id=$4 "+
     "ORDER BY o.created_at DESC,o.id DESC",[shopId,oaId,customer,conv]);
    const opens=list.rows.filter(o=>!o.approved&&!o.manual_lock&&!o.print_closed);
    // Resolve first, then lock order before conversation generation (same order as Core approve).
    const target=input.intent==='append_or_create'&&opens.length===1?opens[0]:null;
    if(target){
     const locked=await db.query<{active_revision:number;manual_lock:boolean;print_closed:boolean}>(
      'SELECT active_revision,manual_lock,print_closed FROM core_orders WHERE id=$1 FOR UPDATE',[target.id]);
     const actual=locked.rows[0];
     if(!actual||actual.manual_lock||actual.print_closed)return {status:'closed'};
     const checked=await db.query('SELECT 1 FROM core_approvals WHERE order_id=$1 LIMIT 1',[target.id]);
     if(checked.rows.length)return {status:'closed'};
     target.active_revision=actual.active_revision;
    }
    const control=await db.query<{status:string;generation:string|number}>(
     'SELECT status,generation FROM core_conversation_controls WHERE shop_id=$1 AND conversation_id=$2 FOR UPDATE',
     [shopId,conv]);
    const c=control.rows[0];
    if(!c||dbSafeInteger(c.generation,'generation')!==input.expected_generation||c.status!=='AI')
     return {status:'stale_generation'};
    if(input.intent==='append_or_create'&&opens.length>1)return {status:'ambiguous'};
    if(input.intent==='append_or_create'&&opens.length===0&&list.rows.some(o=>!o.approved&&
       (o.manual_lock||o.print_closed)))return {status:'closed'};
    if(input.intent==='explicit_separate'){
     // A classifier string from AI2 cannot prove the customer requested a separate order.
     // AI0 must supply evidence from a server-trusted source via a callback.
     if(!options.verifyExplicitSeparate)return {status:'needs_review'};
     if(!await options.verifyExplicitSeparate(db,{
       shop_id:shopId,oa_id:oaId,customer_id:customer,conversation_id:conv,event_ids:ids
     }))return {status:'needs_review'};
    }
    // Durable artifact provenance is mandatory for image/file; AI2's boolean alone is not proof.
    const media=trustedEvents.rows.filter(e=>e.kind==='image'||e.kind==='file');
    if(media.length){
     const relation=await db.query<{relation:string|null}>(
      "SELECT to_regclass('public.ai0_inbound_document_artifacts')::text AS relation");
     if(!relation.rows[0]?.relation)return {status:'needs_review',...(target?{order_id:target.id}:{})};
     const stored=await db.query<{event_id:string}>(
      'SELECT event_id FROM ai0_inbound_document_artifacts WHERE shop_id=$1 AND oa_id=$2 AND customer_id=$3 AND conversation_id=$4 AND event_id=ANY($5::text[])',
      [shopId,oaId,customer,conv,media.map(e=>e.event_id)]);
     if(stored.rows.length!==media.length)return {status:'needs_review',...(target?{order_id:target.id}:{})};
    }
    const selected=target;
    // Replays must be checked under the same row lock before revision CAS:
    // an append committed with lost ACK must return EXISTING, not STALE.
    if(selected){
     if(input.materialized!==true)return {status:'needs_review',order_id:selected.id};
     const fingerprint=sha(canonical({order_id:selected.id,event_ids:ids}));
     return appendInside(db,actor,{id:selected.id,conv,customer,ids,key,fingerprint,
       expected_revision:input.expected_revision??selected.active_revision});
    }
    // Explicit new order only after verified intent or no current open order.
    if(list.rows.length>0&&input.intent!=='explicit_separate')return {status:'closed'};
    const fingerprint=sha(canonical({conversation_id:conv,event_ids:ids}));
    const replay=await db.query<{order_id:string;event_fingerprint:string;content_hash:string}>(
     'SELECT order_id,event_fingerprint,content_hash FROM core_ai_draft_proposals WHERE shop_id=$1 AND oa_id=$2 AND (event_fingerprint=$3 OR idempotency_key=$4) FOR UPDATE',
     [shopId,oaId,fingerprint,key]);
    const contentHash=sha(canonical({conversation_id:conv,customer_id:customer,text:content,
      expected_generation:input.expected_generation}));
    if(replay.rows.length){
     if(replay.rows.length!==1||replay.rows[0]?.event_fingerprint!==fingerprint||
        replay.rows[0].content_hash!==contentHash)
      throw new DomainError('AI_DRAFT_IDEMPOTENCY_CONFLICT','Conflicting replay',409);
     const found=await db.query<{active_revision:number}>('SELECT active_revision FROM core_orders WHERE id=$1',[replay.rows[0].order_id]);
     const r=found.rows[0];
     if(!r)return {status:'needs_review'};
     const rev=await db.query<{request_hash:string}>('SELECT request_hash FROM core_revisions WHERE order_id=$1 AND revision=$2',
       [replay.rows[0].order_id,r.active_revision]);
     return {status:'existing',order_id:replay.rows[0].order_id,revision:r.active_revision,
      request_hash:rev.rows[0]?.request_hash??'',requires_reconfirmation:true};
    }
    if(input.materialized!==true)return {status:'needs_review'};
    const orderId=newId();
    const requestData={source:'zalo_ai_suggestion',conversation_id:conv,event_ids:ids,text:content};
    const hash=sha(canonical(requestData));
    await db.query('INSERT INTO core_orders(id,shop_id,customer_id,conversation_id) VALUES($1,$2,$3,$4)',
      [orderId,shopId,customer,conv]);
    await db.query('INSERT INTO core_revisions(order_id,revision,request_hash,request_data) VALUES($1,1,$2,$3::jsonb)',
      [orderId,hash,JSON.stringify(requestData)]);
    await db.query('INSERT INTO core_ai_draft_proposals(shop_id,oa_id,conversation_id,customer_id,event_fingerprint,idempotency_key,content_hash,order_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [shopId,oaId,conv,customer,fingerprint,key,contentHash,orderId]);
    return {status:'created',order_id:orderId,revision:1,request_hash:hash,requires_reconfirmation:true};
   });
  }
 return {append_verified_events,apply_incoming_batch};
}
