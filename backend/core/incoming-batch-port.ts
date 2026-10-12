import {assertProcessor,canonical,dbSafeInteger,DomainError,newId,sha,type Principal} from './model.js';
import type {PgStore,SqlConnection} from '../storage/database.js';

export type IncomingChange='attachment'|'copies'|'paper'|'duplex'|'print_request';
export interface ApplyIncomingBatchInput {
 scope:{oa_id:string;customer_id:string;conversation_id:string};
 expected_generation:number;event_ids:string[];text:string;
 idempotency_key:string;intent:'append_or_create'|'explicit_separate';
 changes:IncomingChange[];
}
export type ApplyIncomingBatchResult=
 | {status:'created'|'existing';order_id:string;active_revision:number}
 | {status:'appended';order_id:string;active_revision:number;requires_reconfirmation:true}
 | {status:'stale_generation'|'needs_human'|'ambiguous'|'closed'};
type OrderMatch={id:string;active_revision:number;manual_lock:boolean;print_closed:boolean;
 approved:boolean;proposal_id:string|null;approved_at:Date|null};
type Inbound={event_id:string;customer_id:string;conversation_id:string;occurred_at:Date;received_at:Date;
 kind:string;source_text:string|null};
const changesAllowed=new Set<IncomingChange>(['attachment','copies','paper','duplex','print_request']);
function bounded(x:string,name:string,max:number){
 if(typeof x!=='string'||!x.trim()||x.length>max)
  throw new DomainError('INVALID_INCOMING_BATCH','Invalid '+name,422);
 return x;
}
const separateEvidence=/(?:đơn\s+(?:in\s+)?(?:mới|riêng|khác)|đơn\s+thứ\s+hai)/iu;
const negatedSeparate=/(?:không|đừng|chưa)\s+(?:cần\s+|muốn\s+)?(?:tạo|lập|mở|làm|tách)\s+(?:một\s+)?đơn\s+(?:in\s+)?(?:mới|riêng|khác)/iu;
function identifiers(input:ApplyIncomingBatchInput){
 const conv=bounded(input.scope.conversation_id,'conversation_id',256),
 customer=bounded(input.scope.customer_id,'customer_id',256);
 if(!Array.isArray(input.event_ids)||input.event_ids.length<1||input.event_ids.length>100)
  throw new DomainError('INVALID_INCOMING_EVENTS','Expected verified event IDs',422);
 const ids=input.event_ids.map(e=>bounded(e,'event_id',256)).sort();
 if(new Set(ids).size!==ids.length)throw new DomainError('DUPLICATE_INCOMING_EVENTS','Repeated event',422);
 if(!Array.isArray(input.changes)||input.changes.some(c=>!changesAllowed.has(c)))
  throw new DomainError('INVALID_INCOMING_CHANGES','Unsupported change',422);
 if(!Number.isSafeInteger(input.expected_generation)||input.expected_generation<0)
  throw new DomainError('INVALID_INCOMING_GENERATION','Invalid generation',422);
 if(input.intent!=='append_or_create'&&input.intent!=='explicit_separate')
  throw new DomainError('INVALID_INCOMING_INTENT','Ambiguous intent',422);
 return {conv,customer,ids,text:bounded(input.text,'text',4000),
  key:bounded(input.idempotency_key,'idempotency_key',128)};
}
/**
 * AI0 must inject authenticated PROCESSOR identity and server-owned OA/shop.
 * Ingestion, active-order lookup, generation CAS, append/create, and idempotency
 * all commit in ONE PgStore transaction. No customer/staff principal is minted.
 * AI2's scope is cross-checked against verified provider rows, never trusted.
 */
export function createIncomingBatchPort(options:{
 store:PgStore;trusted:{readonly shop_id:string;readonly oa_id:string};processor:Principal
}){
 const {store,trusted,processor}=options;
 if(!store?.tx||!trusted||typeof trusted.shop_id!=='string'||!trusted.shop_id.trim()||
    typeof trusted.oa_id!=='string'||!trusted.oa_id.trim())
  throw new DomainError('INCOMING_PORT_UNCONFIGURED','Server OA/shop mapping required',503);
 assertProcessor(processor);
 if(processor.shop_id!==trusted.shop_id||!processor.id)
  throw new DomainError('INCOMING_PROCESSOR_SCOPE_DENIED','Processor not bound to shop',403);
 const shop=bounded(trusted.shop_id,'shop_id',128),oa=bounded(trusted.oa_id,'oa_id',256);
 async function verified(db:SqlConnection,conv:string,customer:string,ids:string[]):Promise<Inbound[]>{
  const found=await db.query('SELECT shop_id FROM core_shop_settings WHERE shop_id=$1 FOR SHARE',[shop]);
  if(found.rows.length!==1)throw new DomainError('INCOMING_SHOP_NOT_FOUND','Shop absent',403);
  const events=await db.query<Inbound>(
   "SELECT event_id,customer_id,conversation_id,occurred_at,received_at,"+
   "payload_json->>'kind' AS kind,COALESCE(payload_json->>'text',payload_json->>'message_text') AS source_text "+
   "FROM zalo_inbound_events WHERE oa_id=$1 AND event_id=ANY($2::text[]) FOR SHARE",[oa,ids]);
  if(events.rows.length!==ids.length||
     events.rows.some(e=>e.customer_id!==customer||e.conversation_id!==conv||
      !['text','image','file'].includes(e.kind)))
   throw new DomainError('INCOMING_EVENT_SCOPE_DENIED','Event/OA/customer/chat mismatch',403);
  return events.rows;
 }
 async function matchingOrders(db:SqlConnection,conv:string,customer:string,lock:boolean):Promise<OrderMatch[]>{
  const sql="SELECT o.id,o.active_revision,o.manual_lock,o.print_closed,"+
   "EXISTS(SELECT 1 FROM core_approvals a WHERE a.order_id=o.id) AS approved,"+
   "(SELECT MAX(a.created_at) FROM core_approvals a WHERE a.order_id=o.id) AS approved_at,"+
   "p.order_id AS proposal_id FROM core_orders o "+
   "LEFT JOIN core_ai_draft_proposals p ON p.order_id=o.id AND p.shop_id=o.shop_id AND p.oa_id=$2 "+
   "AND p.customer_id=o.customer_id AND p.conversation_id=o.conversation_id "+
   "WHERE o.shop_id=$1 AND o.customer_id=$3 AND o.conversation_id=$4 "+
   "ORDER BY o.id"+(lock?" FOR UPDATE OF o":"");
  return (await db.query<OrderMatch>(sql,[shop,oa,customer,conv])).rows;
 }
 async function activeControl(db:SqlConnection,conv:string,expected:number):Promise<boolean>{
  const res=await db.query<{generation:string|number;status:string}>(
   'SELECT generation,status FROM core_conversation_controls WHERE shop_id=$1 AND conversation_id=$2 FOR UPDATE',[shop,conv]);
  if(res.rows.length===0){
   if(expected!==0)return false;
   await db.query('INSERT INTO core_conversation_controls(shop_id,conversation_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[shop,conv]);
  }
  const item=res.rows[0]??(await db.query<{generation:string|number;status:string}>(
   'SELECT generation,status FROM core_conversation_controls WHERE shop_id=$1 AND conversation_id=$2 FOR UPDATE',[shop,conv])).rows[0];
  return !!item&&item.status==='AI'&&dbSafeInteger(item.generation,'generation')===expected;
 }
 async function pendingFor(db:SqlConnection,orderId:string,rev:number,conv:string,customer:string){
  return db.query<{event_id:string}>(
   "SELECT e.event_id FROM zalo_inbound_events e "+
   "JOIN core_ai_draft_proposals p ON p.oa_id=e.oa_id AND p.customer_id=e.customer_id "+
   " AND p.conversation_id=e.conversation_id AND p.order_id=$1 AND p.shop_id=$2 "+
   "JOIN core_revisions first_rev ON first_rev.order_id=p.order_id AND first_rev.revision=1 "+
   "WHERE e.payload_json->>'kind' IN ('text','image','file') "+
   "AND e.customer_id=$3 AND e.conversation_id=$4 "+
   "AND NOT COALESCE((first_rev.request_data->'event_ids') ? e.event_id,false) "+
   "AND NOT EXISTS(SELECT 1 FROM core_order_inbound_reviews j JOIN core_revisions r "+
   " ON r.order_id=j.order_id AND r.revision=j.revision "+
   " WHERE j.shop_id=$2 AND j.oa_id=e.oa_id AND j.event_id=e.event_id AND j.order_id=$1 "+
   " AND j.revision<=$5 AND COALESCE((r.request_data->'event_ids') ? e.event_id,false)) "+
   "ORDER BY e.received_at,e.event_id LIMIT 101",[orderId,shop,customer,conv,rev]);
 }
 async function apply_incoming_batch(input:ApplyIncomingBatchInput):Promise<ApplyIncomingBatchResult>{
  if(!input?.scope||input.scope.oa_id!==oa)
   throw new DomainError('INCOMING_OA_SCOPE_DENIED','Untrusted OA',403);
  const {conv,customer,ids,key,text}=identifiers(input);
  const fingerprint=sha(canonical({conversation_id:conv,event_ids:ids}));
  const contentHash=sha(canonical({conversation_id:conv,customer_id:customer,text,expected_generation:input.expected_generation}));
  return store.tx(async db=>{
   // The AI0 inbound INSERT trigger locks the relevant order row. We use the
   // same row order, then generation row, then revisions/journals. No pre-read
   // in another transaction can authorize an append.
   const events=await verified(db,conv,customer,ids);
   const matches=await matchingOrders(db,conv,customer,true);
   if(matches.some(x=>x.proposal_id===null))return {status:'ambiguous'};
   if(!await activeControl(db,conv,input.expected_generation))
    return {status:'stale_generation'};
   const oldProposal=await db.query<{order_id:string;content_hash:string;event_fingerprint:string}>(
    'SELECT order_id,content_hash,event_fingerprint FROM core_ai_draft_proposals WHERE shop_id=$1 AND oa_id=$2 AND (event_fingerprint=$3 OR idempotency_key=$4) FOR UPDATE',
    [shop,oa,fingerprint,key]);
   if(oldProposal.rows.length){
    const row=oldProposal.rows[0];
    if(oldProposal.rows.length!==1||!row||row.event_fingerprint!==fingerprint||row.content_hash!==contentHash)
     throw new DomainError('INCOMING_IDEMPOTENCY_CONFLICT','Conflicting proposal replay',409);
    const order=matches.find(x=>x.id===row.order_id);
    if(!order)return {status:'closed'};
    return {status:'existing',order_id:row.order_id,active_revision:order.active_revision};
   }
   const supplements=await db.query<{order_id:string;event_fingerprint:string;idempotency_key:string;revision:number}>(
    'SELECT order_id,event_fingerprint,idempotency_key,revision FROM core_order_supplement_batches WHERE shop_id=$1 AND oa_id=$2 AND (event_fingerprint=$3 OR idempotency_key=$4) FOR UPDATE',
    [shop,oa,fingerprint,key]);
   if(supplements.rows.length){
    const old=supplements.rows[0];
    if(supplements.rows.length!==1||!old||old.event_fingerprint!==fingerprint)
     throw new DomainError('INCOMING_IDEMPOTENCY_CONFLICT','Conflicting supplement replay',409);
    return {status:'existing',order_id:old.order_id,active_revision:old.revision};
   }
   const open=matches.filter(x=>!x.approved&&!x.print_closed&&!x.manual_lock);
   if(input.intent==='append_or_create'&&open.length>1)return {status:'ambiguous'};
   const closed=matches.filter(x=>x.approved||x.print_closed||x.manual_lock);
   // A delayed provider message received BEFORE staff approval belongs to the
   // old order, never to a newly fabricated post-approval order.
   if(input.intent==='append_or_create'&&open.length===0&&closed.length){
    const latest=closed.map(x=>x.approved_at).filter((v):v is Date=>v!==null);
    if(latest.length===0)return {status:'closed'};
    const threshold=Math.max(...latest.map(x=>new Date(x).getTime()));
    if(events.some(e=>new Date(e.received_at).getTime()<=threshold||
       new Date(e.occurred_at).getTime()<=threshold))return {status:'closed'};
   }
   if(input.intent==='explicit_separate'){
    const source=events.filter(e=>e.kind==='text'&&typeof e.source_text==='string')
      .map(e=>e.source_text??'').join(' ');
    if(!separateEvidence.test(source)||negatedSeparate.test(source))
     return {status:'needs_human'}; // classification alone isn't customer proof
   }
   if(input.intent==='append_or_create'&&open.length===1){
    const target=open[0];
    if(!target)return {status:'ambiguous'};
    const used=await db.query(
     'SELECT 1 FROM core_order_inbound_reviews WHERE oa_id=$1 AND event_id=ANY($2::text[]) LIMIT 1',
     [oa,ids]);
    if(used.rows.length)throw new DomainError('INCOMING_EVENT_ALREADY_USED','Event belongs to prior revision',409);
    const rev=(await db.query<{request_data:unknown}>(
     'SELECT request_data FROM core_revisions WHERE order_id=$1 AND revision=$2',
     [target.id,target.active_revision])).rows[0];
    if(!rev?.request_data||typeof rev.request_data!=='object'||Array.isArray(rev.request_data))
     return {status:'needs_human'};
    const data=rev.request_data as Record<string,unknown>;
    if(!Array.isArray(data.event_ids)||data.event_ids.some(e=>typeof e!=='string')||
       ids.some(e=>data.event_ids?.includes(e)))return {status:'needs_human'};
    if(!Number.isSafeInteger(target.active_revision+1))throw new DomainError('REVISION_OVERFLOW','Revision exhausted',409);
    const revision=target.active_revision+1;
    const nextData={...data,event_ids:[...data.event_ids,...ids],
      incoming_batches:[...(Array.isArray(data.incoming_batches)?data.incoming_batches:[]),
       {event_ids:ids,changes:input.changes,source:'verified_inbound'}]};
    const hash=sha(canonical(nextData));
    await db.query('INSERT INTO core_revisions(order_id,revision,request_hash,request_data,plan) VALUES($1,$2,$3,$4::jsonb,NULL)',
     [target.id,revision,hash,JSON.stringify(nextData)]);
    await db.query('UPDATE core_orders SET active_revision=$2,updated_at=now() WHERE id=$1',[target.id,revision]);
    await db.query('INSERT INTO core_order_supplement_batches(order_id,shop_id,oa_id,event_fingerprint,idempotency_key,revision,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7)',
     [target.id,shop,oa,fingerprint,key,revision,hash]);
    for(const e of ids)await db.query(
     'INSERT INTO core_order_inbound_reviews(shop_id,oa_id,event_id,order_id,revision,reviewed_by) VALUES($1,$2,$3,$4,$5,$6)',
     [shop,oa,e,target.id,revision,processor.id]);
    await db.query('INSERT INTO core_audit(id,shop_id,actor_id,action,order_id,details) VALUES($1,$2,$3,$4,$5,$6::jsonb)',
     [newId(),shop,processor.id,'order.incoming_batch_appended',target.id,JSON.stringify({revision,event_count:ids.length})]);
    return {status:'appended',order_id:target.id,active_revision:revision,requires_reconfirmation:true};
   }
   // When there is no open order, or customer *explicitly* requested a
   // separate one, create exactly ONE draft under the conversation lock.
   if(input.intent==='append_or_create'&&open.length!==0)return {status:'ambiguous'};
   const orderId=newId();
   const data={source:'zalo_ai_suggestion',conversation_id:conv,event_ids:ids,
     text,incoming_batches:[{event_ids:ids,changes:input.changes,source:'verified_inbound'}]};
   const hash=sha(canonical(data));
   await db.query('INSERT INTO core_orders(id,shop_id,customer_id,conversation_id) VALUES($1,$2,$3,$4)',
    [orderId,shop,customer,conv]);
   await db.query('INSERT INTO core_revisions(order_id,revision,request_hash,request_data) VALUES($1,1,$2,$3::jsonb)',
    [orderId,hash,JSON.stringify(data)]);
   await db.query('INSERT INTO core_ai_draft_proposals(shop_id,oa_id,conversation_id,customer_id,event_fingerprint,idempotency_key,content_hash,order_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    [shop,oa,conv,customer,fingerprint,key,contentHash,orderId]);
   await db.query('INSERT INTO core_audit(id,shop_id,actor_id,action,order_id,details) VALUES($1,$2,$3,$4,$5,$6::jsonb)',
    [newId(),shop,processor.id,'order.incoming_batch_created',orderId,JSON.stringify({event_count:ids.length})]);
   return {status:'created',order_id:orderId,active_revision:1};
  });
 }
 async function pending_updates(input:{order_id:string}):Promise<{
  order_id:string;revision:number;request_hash:string;status:'PENDING'|'CLEAR';
  unresolved_count:number;items:{event_id:string;kind:string;received_at:Date}[]
 }>{
  const id=bounded(input.order_id,'order_id',100);
  return store.tx(async db=>{
   const orders=await db.query<{id:string;customer_id:string;conversation_id:string|null;active_revision:number}>(
    'SELECT id,customer_id,conversation_id,active_revision FROM core_orders WHERE id=$1 AND shop_id=$2 FOR SHARE',
    [id,shop]);
   const order=orders.rows[0];
   if(!order?.conversation_id)throw new DomainError('PENDING_ORDER_NOT_FOUND','Unlinked order',404);
   const p=await db.query('SELECT 1 FROM core_ai_draft_proposals WHERE order_id=$1 AND shop_id=$2 AND oa_id=$3 AND customer_id=$4 AND conversation_id=$5',
    [id,shop,oa,order.customer_id,order.conversation_id]);
   if(!p.rows.length)throw new DomainError('PENDING_ORDER_SCOPE_DENIED','No verified OA binding',403);
   const r=await db.query<{request_hash:string;plan:unknown}>(
    'SELECT request_hash,plan FROM core_revisions WHERE order_id=$1 AND revision=$2',[id,order.active_revision]);
   const revision=r.rows[0];
   if(!revision)throw new DomainError('PENDING_REVISION_NOT_FOUND','Missing revision',500);
   const pending=await pendingFor(db,id,order.active_revision,order.conversation_id,order.customer_id);
   const entries=await db.query<{event_id:string;kind:string;received_at:Date}>(
    "SELECT e.event_id,e.payload_json->>'kind' AS kind,e.received_at FROM zalo_inbound_events e "+
    "JOIN core_ai_draft_proposals p ON p.oa_id=e.oa_id AND p.customer_id=e.customer_id AND p.conversation_id=e.conversation_id "+
    "WHERE p.order_id=$1 AND p.shop_id=$2 AND e.event_id=ANY($3::text[]) ORDER BY e.received_at,e.event_id",
    [id,shop,pending.rows.map(z=>z.event_id)]);
   const total=entries.rows.length;
   return {order_id:id,revision:order.active_revision,request_hash:revision.request_hash,
    status:total>0||revision.plan===null?'PENDING' as const:'CLEAR' as const,
    unresolved_count:total,items:entries.rows};
  });
 }
 return {apply_incoming_batch,pending_updates};
}
