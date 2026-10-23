import {DomainError,newId} from './model.js';
import type {PgStore,SqlConnection} from '../storage/database.js';

export type IntakeEventRole='CONTEXT'|'CODE'|'SOURCE'|'SETTINGS';
export interface IncomingQueueBatchInput {
 queue_batch_id:string;lease_token:string;purpose:'PILOT'|'ORDER';boundary?:'CONTINUE'|'NEW';
 event_ids?:readonly string[];
 selection?:{code_event_id?:string;source_event_id?:string;settings_event_ids?:readonly string[]};
}
export interface CloseIncomingQueueBatchInput {
 intake_batch_id:string;queue_batch_id:string;lease_token:string;reason:'ABANDONED'|'NEEDS_HUMAN';
}
export interface IncomingQueueBatchSnapshot {
 schema:'ai1.oa_intake_batch.v1';status:'OPEN'|'BOUND'|'CLOSED'|'EXPIRED'|'NEEDS_HUMAN';
 readiness:'WAITING_FOR_FILE'|'WAITING_FOR_SETTINGS'|'WAITING_FOR_CODE'|'READY';intake_batch_id:string;queue_batch_id:string;
 shop_id:string;oa_id:string;customer_id:string;conversation_id:string;purpose:'PILOT'|'ORDER';
 opened_at:string;expires_at:string;order_id:string|null;revision:number|null;
 events:{event_id:string;kind:'text'|'image'|'file';role:IntakeEventRole;received_at:string}[];
}
type QueueEvent={event_id:string;oa_id:string;customer_id:string;conversation_id:string;
 kind:string;source_text:string|null;received_at:Date;queue_batch_id:string};
type QueueLease={id:string;oa_id:string;event_count:number;status:string;lease_token:string|null;
 lease_until:Date|null;events:QueueEvent[]};
type IntakeRow={id:string;shop_id:string;oa_id:string;customer_id:string;conversation_id:string;purpose:'PILOT'|'ORDER';
 status:IncomingQueueBatchSnapshot['status'];opened_at:Date;expires_at:Date;order_id:string|null;revision:number|null;
 new_order_requested?:boolean};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PG_BIGINT_MAX=9223372036854775807n;
function invalid():never{throw new DomainError('INCOMING_BATCH_INVALID','Incoming queue batch request is invalid',422);}
function plain(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value);}
function exact(value:Record<string,unknown>,keys:string[]):boolean{return Object.keys(value).sort().join(',')===keys.sort().join(',');}
function idList(value:unknown,max=500):string[]{
 if(!Array.isArray(value)||value.length<1||value.length>max||value.some(x=>typeof x!=='string'||!x||x.length>256||x!==x.trim()))invalid();
 const values=value as string[];if(new Set(values).size!==values.length)throw new DomainError('INCOMING_EVENT_SELECTOR_DUPLICATE','Duplicate event selector',422);
 return values;
}
export function validateIncomingQueueBatchInput(value:unknown):IncomingQueueBatchInput{
 if(!plain(value)||Object.keys(value).some(key=>!['queue_batch_id','lease_token','purpose','boundary','event_ids','selection'].includes(key)))invalid();
 if(typeof value.queue_batch_id!=='string'||!/^\d{1,19}$/.test(value.queue_batch_id)||BigInt(value.queue_batch_id)<1n||BigInt(value.queue_batch_id)>PG_BIGINT_MAX||
    typeof value.lease_token!=='string'||!UUID.test(value.lease_token)||
    (value.purpose!=='PILOT'&&value.purpose!=='ORDER')||
    (value.boundary!==undefined&&value.boundary!=='CONTINUE'&&value.boundary!=='NEW'))invalid();
 if(value.event_ids!==undefined)idList(value.event_ids);
 if(value.selection!==undefined){
  if(!plain(value.selection)||Object.keys(value.selection).some(key=>!['code_event_id','source_event_id','settings_event_ids'].includes(key)))invalid();
  for(const key of ['code_event_id','source_event_id'])if(value.selection[key]!==undefined&&
    (typeof value.selection[key]!=='string'||!value.selection[key]||value.selection[key].length>256||value.selection[key]!==value.selection[key].trim()))invalid();
  if(value.selection.settings_event_ids!==undefined)idList(value.selection.settings_event_ids,100);
 }
 return value as unknown as IncomingQueueBatchInput;
}
export function validateApplyIncomingBatchScope(value:unknown):{queue_batch_id:string;lease_token:string;intake_batch_id:string}{
 if(!plain(value)||typeof value.queue_batch_id!=='string'||!/^\d{1,19}$/.test(value.queue_batch_id)||BigInt(value.queue_batch_id)<1n||BigInt(value.queue_batch_id)>PG_BIGINT_MAX||
    typeof value.lease_token!=='string'||!UUID.test(value.lease_token)||
    typeof value.intake_batch_id!=='string'||!UUID.test(value.intake_batch_id))invalid();
 return value as {queue_batch_id:string;lease_token:string;intake_batch_id:string};
}
function dbError(code:string,message:string,status=409):DomainError{return new DomainError(code,message,status);}
async function requireSchema(db:SqlConnection):Promise<void>{
 const rows=await db.query<{zalo_batches:string|null;batch_items:string|null;events:string|null;intake:string|null;bindings:string|null;oa_registry:string|null;batch_oa:boolean;new_order_requested:boolean}>(
  "SELECT to_regclass('public.zalo_batches')::text AS zalo_batches,"+
  "to_regclass('public.zalo_batch_items')::text AS batch_items,"+
  "to_regclass('public.zalo_inbound_events')::text AS events,"+
  "to_regclass('public.core_oa_intake_batches')::text AS intake,"+
  "to_regclass('public.core_oa_intake_event_bindings')::text AS bindings,"+
  "to_regclass('public.core_shop_zalo_oa_registry')::text AS oa_registry,"+
  "EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='zalo_batches' AND column_name='oa_id') AS batch_oa,"+
  "EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='core_oa_intake_batches' AND column_name='new_order_requested') AS new_order_requested");
 const row=rows.rows[0];
 if(!row?.zalo_batches||!row.batch_items||!row.events||!row.intake||!row.bindings||!row.oa_registry||!row.batch_oa||!row.new_order_requested)
  throw new DomainError('INCOMING_BATCH_SCHEMA_REQUIRED','Zalo migrations 001/002 and Core migrations 015/016 are required',503,true);
}
export async function lockIncomingQueueBatch(db:SqlConnection,batchId:string,leaseToken:string,expectedOa?:string):Promise<QueueLease>{
 await requireSchema(db);
 const batch=(await db.query<{id:string;oa_id:string;event_count:number;status:string;lease_token:string|null;lease_until:Date|null}>(
  'SELECT id::text,oa_id,event_count,status,lease_token::text,lease_until FROM zalo_batches WHERE id=$1 FOR UPDATE',[batchId])).rows[0];
 if(!batch)throw dbError('INCOMING_BATCH_NOT_FOUND','Durable queue batch not found',404);
 const clock=(await db.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0]?.now;
 if(batch.status!=='LEASED'||batch.lease_token!==leaseToken||!batch.lease_until||!clock||
    new Date(batch.lease_until).getTime()<=new Date(clock).getTime())
  throw dbError('INCOMING_BATCH_LEASE_LOST','Durable queue batch lease is missing, expired, or replaced');
 if(expectedOa&&batch.oa_id!==expectedOa)throw dbError('INCOMING_OA_SCOPE_DENIED','Queue batch belongs to another OA',403);
 const events=(await db.query<QueueEvent>(
  'SELECT i.event_id,i.oa_id,e.customer_id,e.conversation_id,e.payload_json->>\'kind\' AS kind,'+
  "COALESCE(e.payload_json->>'text',e.payload_json->>'message_text') AS source_text,e.received_at,$2::text AS queue_batch_id "+
  'FROM zalo_batch_items i JOIN zalo_inbound_events e USING(oa_id,event_id) '+
  'WHERE i.batch_id=$1::bigint ORDER BY e.received_at,e.event_id FOR SHARE OF e',[batchId,batchId])).rows;
 if(events.length!==Number(batch.event_count)||events.length<1||events.some(e=>e.oa_id!==batch.oa_id||
    !['text','image','file'].includes(e.kind)))
  throw dbError('INCOMING_BATCH_MEMBERSHIP_INVALID','Durable queue membership is incomplete or inconsistent');
 const customer=events[0]?.customer_id,conversation=events[0]?.conversation_id;
 if(!customer||!conversation||events.some(e=>e.customer_id!==customer||e.conversation_id!==conversation))
  throw dbError('INCOMING_BATCH_SCOPE_MISMATCH','Queue events do not share one verified customer and conversation',403);
 return {...batch,events};
}
export function selectIncomingQueueEvents(batch:QueueLease,selectors?:readonly string[]):QueueEvent[]{
 if(selectors===undefined)return batch.events;
 const available=new Map(batch.events.map(event=>[event.event_id,event]));
 const selected=idList(selectors);
 if(selected.some(id=>!available.has(id)))throw dbError('INCOMING_EVENT_MEMBERSHIP_DENIED','Event selector is not a member of the leased queue batch',403);
 return selected.map(id=>available.get(id)! ).sort((a,b)=>new Date(a.received_at).getTime()-new Date(b.received_at).getTime()||a.event_id.localeCompare(b.event_id));
}
async function activeIntake(db:SqlConnection,shop:string,oa:string,customer:string,conversation:string):Promise<IntakeRow|undefined>{
 return (await db.query<IntakeRow>(
  'SELECT id,shop_id,oa_id,customer_id,conversation_id,purpose,status,opened_at,expires_at,order_id,revision,new_order_requested '+
  'FROM core_oa_intake_batches WHERE shop_id=$1 AND oa_id=$2 AND customer_id=$3 AND conversation_id=$4 '+
  "AND status IN ('OPEN','BOUND') FOR UPDATE",[shop,oa,customer,conversation])).rows[0];
}
async function createIntake(db:SqlConnection,shop:string,oa:string,customer:string,conversation:string,
 purpose:'PILOT'|'ORDER',receivedAt:Date,newOrderRequested:boolean):Promise<IntakeRow>{
 const id=newId();
 const row=(await db.query<IntakeRow>(
  'INSERT INTO core_oa_intake_batches(id,shop_id,oa_id,customer_id,conversation_id,purpose,status,opened_at,expires_at,closed_at,new_order_requested) '+
  "VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $7::timestamptz+interval '30 minutes'<=clock_timestamp() THEN 'EXPIRED' ELSE 'OPEN' END,"+
  "$7,$7::timestamptz+interval '30 minutes',CASE WHEN $7::timestamptz+interval '30 minutes'<=clock_timestamp() THEN clock_timestamp() ELSE NULL END,$8) "+
  'RETURNING id,shop_id,oa_id,customer_id,conversation_id,purpose,status,opened_at,expires_at,order_id,revision,new_order_requested',
  [id,shop,oa,customer,conversation,purpose,receivedAt,newOrderRequested])).rows[0];
 if(!row)throw dbError('INCOMING_BATCH_CREATE_FAILED','Could not create durable intake batch',500);
 return row;
}
async function replayNewBoundary(db:SqlConnection,queue:QueueLease,shop:string,purpose:'PILOT'|'ORDER',
 customer:string,conversation:string):Promise<IncomingQueueBatchSnapshot|undefined>{
 const rows=(await db.query<IntakeRow&{event_id:string;queue_batch_id:string;received_at:Date;event_kind:string}>(
  'SELECT i.id,i.shop_id,i.oa_id,i.customer_id,i.conversation_id,i.purpose,i.status,i.opened_at,i.expires_at,'+
  'i.order_id,i.revision,i.new_order_requested,b.event_id,b.queue_batch_id::text,b.received_at,b.event_kind '+
  'FROM core_oa_intake_event_bindings b JOIN core_oa_intake_batches i ON i.id=b.intake_batch_id '+
  'WHERE b.oa_id=$1 AND b.event_id=ANY($2::text[]) ORDER BY b.event_id',[queue.oa_id,queue.events.map(event=>event.event_id)])).rows;
 if(rows.length===0)return undefined;
 const byId=new Map(rows.map(row=>[row.event_id,row]));
 const intakeId=rows[0]?.id;
 const matches=rows.length===queue.events.length&&!!intakeId&&rows.every(row=>row.id===intakeId&&
  row.new_order_requested===true&&row.shop_id===shop&&row.oa_id===queue.oa_id&&row.customer_id===customer&&
  row.conversation_id===conversation&&row.purpose===purpose)&&queue.events.every(event=>{
   const row=byId.get(event.event_id);
   return !!row&&row.queue_batch_id===event.queue_batch_id&&row.event_kind===event.kind&&
    new Date(row.received_at).getTime()===new Date(event.received_at).getTime();
  });
 if(!matches)throw dbError('INCOMING_EVENT_ALREADY_BOUND','Event is permanently bound to another intake lifecycle');
 return snapshot(db,rows[0]!,queue.id);
}
async function bindEvents(db:SqlConnection,batch:IntakeRow,events:QueueEvent[]):Promise<void>{
 for(const event of events){
  const prior=(await db.query<{intake_batch_id:string;queue_batch_id:string;received_at:Date;event_kind:string}>(
   'SELECT intake_batch_id,queue_batch_id::text,received_at,event_kind FROM core_oa_intake_event_bindings WHERE oa_id=$1 AND event_id=$2 FOR UPDATE',
   [event.oa_id,event.event_id])).rows[0];
  if(prior){
   if(prior.intake_batch_id!==batch.id||prior.queue_batch_id!==event.queue_batch_id||
      new Date(prior.received_at).getTime()!==new Date(event.received_at).getTime()||prior.event_kind!==event.kind)
    throw dbError('INCOMING_EVENT_ALREADY_BOUND','Event is permanently bound to another intake lifecycle');
   continue;
  }
  if(batch.status==='CLOSED'||batch.status==='NEEDS_HUMAN')
   throw dbError('INCOMING_BATCH_CLOSED','Cannot add events to a closed intake batch');
  if(new Date(event.received_at).getTime()<new Date(batch.opened_at).getTime()||
     new Date(event.received_at).getTime()>=new Date(batch.expires_at).getTime())
   throw dbError('INCOMING_BATCH_EVENT_OUTSIDE_WINDOW','Event DB received_at is outside the active intake window');
  const inserted=await db.query(
   'INSERT INTO core_oa_intake_event_bindings(oa_id,event_id,intake_batch_id,queue_batch_id,received_at,event_kind,role) '+
   "VALUES($1,$2,$3,$4,$5,$6,'CONTEXT') ON CONFLICT(oa_id,event_id) DO NOTHING",
   [event.oa_id,event.event_id,batch.id,event.queue_batch_id,event.received_at,event.kind]);
  if(inserted.rowCount!==1)throw dbError('INCOMING_EVENT_BINDING_RACE','Event binding changed during intake');
 }
}
async function setRole(db:SqlConnection,batch:IntakeRow,role:IntakeEventRole,eventId:string|undefined,
 allowedKind:'text'|'file'|'any'):Promise<void>{
 if(eventId===undefined)return;
 const row=(await db.query<{event_kind:string;role:IntakeEventRole}>(
  'SELECT event_kind,role FROM core_oa_intake_event_bindings WHERE intake_batch_id=$1 AND oa_id=$2 AND event_id=$3 FOR UPDATE',
  [batch.id,batch.oa_id,eventId])).rows[0];
 if(!row||(allowedKind!=='any'&&row.event_kind!==allowedKind))
  throw dbError('INCOMING_EVENT_MEMBERSHIP_DENIED','Role selector is not a matching member of this intake batch',403);
 if(row.role!==role&&row.role!=='CONTEXT')
  throw dbError('INCOMING_EVENT_ROLE_CONFLICT','Event already has a different immutable intake role');
 if(role==='SOURCE'){
  const existing=(await db.query<{event_id:string}>(
   "SELECT event_id FROM core_oa_intake_event_bindings WHERE intake_batch_id=$1 AND role='SOURCE' AND event_id<>$2 LIMIT 1",
   [batch.id,eventId])).rows[0];
  if(existing)throw dbError('INCOMING_SOURCE_SELECTOR_CONFLICT','Intake batch already has another source event');
 }
 if(row.role==='CONTEXT')await db.query(
  'UPDATE core_oa_intake_event_bindings SET role=$4 WHERE intake_batch_id=$1 AND oa_id=$2 AND event_id=$3',
  [batch.id,batch.oa_id,eventId,role]);
}
async function snapshot(db:SqlConnection,batch:IntakeRow,queueBatchId:string):Promise<IncomingQueueBatchSnapshot>{
 const events=(await db.query<{event_id:string;event_kind:'text'|'image'|'file';role:IntakeEventRole;received_at:Date}>(
  'SELECT event_id,event_kind,role,received_at FROM core_oa_intake_event_bindings WHERE intake_batch_id=$1 '+
  'ORDER BY received_at,event_id',[batch.id])).rows;
 const hasSource=events.some(event=>event.role==='SOURCE'),hasSettings=events.some(event=>event.role==='SETTINGS');
 return {schema:'ai1.oa_intake_batch.v1',status:batch.status,
  // READY means Core has a sealed source and validated settings to bind to a
  // revision. Shop-code authorization remains a separate Core gate.
  readiness:!hasSource?'WAITING_FOR_FILE':!hasSettings?'WAITING_FOR_SETTINGS':'READY',intake_batch_id:batch.id,
  queue_batch_id:queueBatchId,shop_id:batch.shop_id,oa_id:batch.oa_id,customer_id:batch.customer_id,
  conversation_id:batch.conversation_id,purpose:batch.purpose,opened_at:new Date(batch.opened_at).toISOString(),
  expires_at:new Date(batch.expires_at).toISOString(),order_id:batch.order_id,revision:batch.revision,
  events:events.map(event=>({event_id:event.event_id,kind:event.event_kind,role:event.role,
   received_at:new Date(event.received_at).toISOString()}))};
}
export async function acceptIncomingQueueBatch(store:PgStore,value:unknown):Promise<IncomingQueueBatchSnapshot>{
 const input=validateIncomingQueueBatchInput(value);
 return store.tx(async db=>{
  await db.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
  const queue=await lockIncomingQueueBatch(db,input.queue_batch_id,input.lease_token);
  const shopRow=(await db.query<{shop_id:string}>(
   'SELECT shop_id FROM core_shop_zalo_oa_registry WHERE oa_id=$1 FOR SHARE',[queue.oa_id])).rows;
  if(shopRow.length!==1)throw dbError('INCOMING_OA_SCOPE_DENIED','OA is not uniquely bound to a shop',403);
  const shop=shopRow[0]!.shop_id;
  const selected=selectIncomingQueueEvents(queue,input.event_ids);
  if(selected.some(event=>event.oa_id!==queue.oa_id))throw dbError('INCOMING_OA_SCOPE_DENIED','Queue batch contains another OA',403);
  const selectedIds=new Set(selected.map(event=>event.event_id));
  const roleSelectors=[input.selection?.code_event_id,input.selection?.source_event_id,
   ...(input.selection?.settings_event_ids??[])].filter((id):id is string=>id!==undefined);
  if(roleSelectors.some(id=>!selectedIds.has(id)))
   throw dbError('INCOMING_EVENT_MEMBERSHIP_DENIED','Role selector must be selected from the leased queue batch',403);
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))',
   [`core-oa-intake:${shop}:${queue.oa_id}:${selected[0]!.customer_id}:${selected[0]!.conversation_id}`]);
  const now=(await db.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0]!.now;
  await db.query("UPDATE core_oa_intake_batches SET status='EXPIRED',closed_at=clock_timestamp(),updated_at=clock_timestamp() "+
   "WHERE shop_id=$1 AND oa_id=$2 AND customer_id=$3 AND conversation_id=$4 AND status IN ('OPEN','BOUND') AND expires_at<=clock_timestamp()",
   [shop,queue.oa_id,selected[0]!.customer_id,selected[0]!.conversation_id]);
  if(input.boundary==='NEW'){
   const replay=await replayNewBoundary(db,queue,shop,input.purpose,selected[0]!.customer_id,selected[0]!.conversation_id);
   if(replay)return replay;
  }
  let batch=await activeIntake(db,shop,queue.oa_id,selected[0]!.customer_id,selected[0]!.conversation_id);
  if(input.boundary==='NEW'&&batch){
   await db.query("UPDATE core_oa_intake_batches SET status='CLOSED',close_reason='NEW_INTAKE',closed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1",[batch.id]);
   batch=undefined;
  }
  if(batch&&batch.purpose!==input.purpose)throw dbError('INCOMING_BATCH_PURPOSE_CONFLICT','Active intake batch has another purpose');
  if(batch){
   const batchTimes=queue.events.map(event=>new Date(event.received_at).getTime());
   const opened=new Date(batch.opened_at).getTime(),expires=new Date(batch.expires_at).getTime();
   if(batchTimes.some(time=>time<opened))throw dbError('INCOMING_BATCH_EVENT_ORDER_INVALID','DB received_at precedes the open intake batch');
   const before=batchTimes.filter(time=>time<expires).length,after=batchTimes.length-before;
   if(before&&after)throw dbError('INCOMING_BATCH_WINDOW_SPLIT','Queue selectors span two intake lifecycles');
   if(after){
    await db.query("UPDATE core_oa_intake_batches SET status='EXPIRED',closed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1",[batch.id]);
    batch=undefined;
   }
  }
  if(!batch){
   const first=queue.events[0]!.received_at;
   batch=await createIntake(db,shop,queue.oa_id,queue.events[0]!.customer_id,queue.events[0]!.conversation_id,
    input.purpose,first,input.boundary==='NEW');
  }
  if(batch.status==='EXPIRED'){
   await bindEvents(db,batch,queue.events);
   return snapshot(db,batch,queue.id);
  }
  // Bind the full durable queue membership, even when the caller selects one
  // event for a role. Otherwise an unselected old code event could be replayed
  // into a later intake after its sibling was processed.
  await bindEvents(db,batch,queue.events);
  const selection=input.selection;
  await setRole(db,batch,'CODE',selection?.code_event_id,'text');
  await setRole(db,batch,'SOURCE',selection?.source_event_id,'file');
  for(const id of selection?.settings_event_ids??[])await setRole(db,batch,'SETTINGS',id,'text');
  const refreshed=(await db.query<IntakeRow>(
   'SELECT id,shop_id,oa_id,customer_id,conversation_id,purpose,status,opened_at,expires_at,order_id,revision '+
   'FROM core_oa_intake_batches WHERE id=$1',[batch.id])).rows[0]??batch;
  if(new Date(refreshed.expires_at).getTime()<=new Date(now).getTime()){
   const expired=(await db.query<IntakeRow>(
    "UPDATE core_oa_intake_batches SET status='EXPIRED',closed_at=clock_timestamp(),updated_at=clock_timestamp() "+
    'WHERE id=$1 RETURNING id,shop_id,oa_id,customer_id,conversation_id,purpose,status,opened_at,expires_at,order_id,revision',[batch.id])).rows[0];
   if(expired)return snapshot(db,expired,queue.id);
  }
  return snapshot(db,refreshed,queue.id);
 });
}
export async function bindIntakeBatchToRevision(db:SqlConnection,input:{intake_batch_id:string;shop_id:string;oa_id:string;
 customer_id:string;conversation_id:string;order_id:string;revision:number;purpose?:'PILOT'|'ORDER'}):Promise<void>{
 const batch=(await db.query<IntakeRow>(
  'SELECT id,shop_id,oa_id,customer_id,conversation_id,purpose,status,opened_at,expires_at,order_id,revision '+
  'FROM core_oa_intake_batches WHERE id=$1 FOR UPDATE',[input.intake_batch_id])).rows[0];
 if(!batch||batch.shop_id!==input.shop_id||batch.oa_id!==input.oa_id||batch.customer_id!==input.customer_id||
    batch.conversation_id!==input.conversation_id||(input.purpose&&batch.purpose!==input.purpose))
  throw dbError('INCOMING_BATCH_SCOPE_DENIED','Intake batch/customer/OA scope mismatch',403);
 const clock=(await db.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0]?.now;
 if(batch.status==='EXPIRED'||!clock||new Date(batch.expires_at).getTime()<=new Date(clock).getTime()){
  if(batch.status==='OPEN'||batch.status==='BOUND')await db.query(
   "UPDATE core_oa_intake_batches SET status='EXPIRED',closed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1",[batch.id]);
  throw dbError('INCOMING_BATCH_EXPIRED','Intake batch expired');
 }
 if(batch.status!=='OPEN'&&batch.status!=='BOUND')throw dbError('INCOMING_BATCH_CLOSED','Intake batch is closed');
 if(batch.order_id&&(batch.order_id!==input.order_id||batch.revision!==input.revision))
  throw dbError('INCOMING_BATCH_ORDER_CONFLICT','Intake batch is permanently bound to another order/revision');
 const result=await db.query(
  "UPDATE core_oa_intake_batches SET status='BOUND',order_id=$2,revision=$3,updated_at=clock_timestamp() "+
  "WHERE id=$1 AND status IN ('OPEN','BOUND') AND (order_id IS NULL OR (order_id=$2 AND revision=$3))",
  [batch.id,input.order_id,input.revision]);
 if(result.rowCount!==1)throw dbError('INCOMING_BATCH_ORDER_CONFLICT','Intake batch order/revision binding raced');
}
export async function verifyIntakeBatchEvents(db:SqlConnection,input:{intake_batch_id:string;queue_batch_id:string;
 shop_id:string;oa_id:string;customer_id:string;conversation_id:string;event_ids:readonly string[];purpose?:'PILOT'|'ORDER'}):Promise<void>{
 const found=await db.query<{event_id:string}>(
  'SELECT b.event_id FROM core_oa_intake_event_bindings b JOIN core_oa_intake_batches i ON i.id=b.intake_batch_id '+
  'WHERE b.intake_batch_id=$1 AND b.queue_batch_id=$2 AND b.oa_id=$3 AND i.shop_id=$4 AND i.oa_id=$3 '+
  'AND i.customer_id=$5 AND i.conversation_id=$6 AND ($8::text IS NULL OR i.purpose=$8) '+
  'AND b.event_id=ANY($7::text[]) FOR SHARE OF b,i',
  [input.intake_batch_id,input.queue_batch_id,input.oa_id,input.shop_id,input.customer_id,input.conversation_id,input.event_ids,input.purpose??null]);
 if(found.rows.length!==input.event_ids.length)throw dbError('INCOMING_EVENT_MEMBERSHIP_DENIED','Event selector does not belong to this intake batch',403);
}
export async function verifyIntakeEventRole(db:SqlConnection,input:{intake_batch_id:string;shop_id:string;oa_id:string;
 customer_id:string;conversation_id:string;event_id:string;role:'CODE'|'SOURCE';allowClosed?:boolean}):Promise<{
 status:IncomingQueueBatchSnapshot['status'];order_id:string|null;revision:number|null;received_at:Date
}>{
 const row=(await db.query<{shop_id:string;oa_id:string;customer_id:string;conversation_id:string;purpose:string;
  status:IncomingQueueBatchSnapshot['status'];order_id:string|null;revision:number|null;expires_at:Date;received_at:Date;role:string}>(
  'SELECT i.shop_id,i.oa_id,i.customer_id,i.conversation_id,i.purpose,i.status,i.order_id,i.revision,i.expires_at,'+
  'e.received_at,e.role FROM core_oa_intake_batches i JOIN core_oa_intake_event_bindings e ON e.intake_batch_id=i.id '+
  'WHERE i.id=$1 AND e.oa_id=$2 AND e.event_id=$3 FOR UPDATE OF i,e',
  [input.intake_batch_id,input.oa_id,input.event_id])).rows[0];
 if(!row||row.shop_id!==input.shop_id||row.oa_id!==input.oa_id||row.customer_id!==input.customer_id||
    row.conversation_id!==input.conversation_id||row.purpose!=='PILOT'||row.role!==input.role)
  throw dbError('PILOT_INTAKE_EVENT_MISMATCH','Pilot event is not selected in this intake batch',403);
 const now=(await db.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0]?.now;
 if(!now||new Date(row.expires_at).getTime()<=new Date(now).getTime()){
  if(row.status==='OPEN'||row.status==='BOUND')await db.query(
   "UPDATE core_oa_intake_batches SET status='EXPIRED',close_reason='TTL',closed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1",
   [input.intake_batch_id]);
  throw dbError('INCOMING_BATCH_EXPIRED','Pilot intake batch expired');
 }
 const allowed=row.status==='OPEN'||row.status==='BOUND'||(input.allowClosed&&row.status==='CLOSED');
 if(!allowed)throw dbError('INCOMING_BATCH_CLOSED','Pilot intake batch is closed');
 return {status:row.status,order_id:row.order_id,revision:row.revision,received_at:row.received_at};
}
export async function closeIncomingQueueBatch(store:PgStore,value:unknown):Promise<{status:'CLOSED'|'EXPIRED'|'NEEDS_HUMAN';intake_batch_id:string}>{
 if(!plain(value)||!exact(value,['intake_batch_id','queue_batch_id','lease_token','reason'])||
    typeof value.intake_batch_id!=='string'||!UUID.test(value.intake_batch_id)||
    typeof value.queue_batch_id!=='string'||!/^\d{1,19}$/.test(value.queue_batch_id)||BigInt(value.queue_batch_id)<1n||BigInt(value.queue_batch_id)>PG_BIGINT_MAX||
    typeof value.lease_token!=='string'||!UUID.test(value.lease_token)||
    (value.reason!=='ABANDONED'&&value.reason!=='NEEDS_HUMAN'))invalid();
 return store.tx(async db=>{
  await db.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
  const queue=await lockIncomingQueueBatch(db,value.queue_batch_id as string,value.lease_token as string);
  const batch=(await db.query<IntakeRow>(
   'SELECT id,shop_id,oa_id,customer_id,conversation_id,purpose,status,opened_at,expires_at,order_id,revision '+
   'FROM core_oa_intake_batches WHERE id=$1 FOR UPDATE',[value.intake_batch_id])).rows[0];
  if(!batch||batch.oa_id!==queue.oa_id)throw dbError('INCOMING_BATCH_NOT_FOUND','Intake batch not found',404);
  const member=(await db.query(
   'SELECT 1 FROM zalo_batch_items q JOIN core_oa_intake_event_bindings e USING(oa_id,event_id) '+
   'WHERE q.batch_id=$1 AND e.queue_batch_id=q.batch_id AND e.intake_batch_id=$2 LIMIT 1',[queue.id,batch.id])).rows[0];
  if(!member)throw dbError('INCOMING_BATCH_MEMBERSHIP_DENIED','Lease does not contain a member of this intake batch',403);
  if(batch.status==='EXPIRED'||batch.status==='NEEDS_HUMAN'||batch.status==='CLOSED')
   return {status:batch.status==='EXPIRED'?'EXPIRED':batch.status==='NEEDS_HUMAN'?'NEEDS_HUMAN':'CLOSED',intake_batch_id:batch.id};
  const next=value.reason==='NEEDS_HUMAN'?'NEEDS_HUMAN':'CLOSED';
  await db.query('UPDATE core_oa_intake_batches SET status=$2,close_reason=$3,closed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1',
   [batch.id,next,value.reason]);
  return {status:next,intake_batch_id:batch.id};
 });
}
export async function expireIncomingQueueBatches(store:PgStore,limit=100,shopId?:string):Promise<number>{
 if(!Number.isSafeInteger(limit)||limit<1||limit>1000||(shopId!==undefined&&(!shopId.trim()||shopId.length>128)))invalid();
 return store.tx(async db=>{
  const result=await db.query(
   "WITH expired AS (SELECT id FROM core_oa_intake_batches WHERE status IN ('OPEN','BOUND') AND expires_at<=clock_timestamp() "+
   'AND ($2::text IS NULL OR shop_id=$2) '+
   'ORDER BY expires_at,id LIMIT $1 FOR UPDATE SKIP LOCKED) '+
   "UPDATE core_oa_intake_batches b SET status='EXPIRED',close_reason='TTL',closed_at=clock_timestamp(),updated_at=clock_timestamp() "+
   'FROM expired e WHERE b.id=e.id',[limit,shopId??null]);
  return result.rowCount??0;
 });
}
