import {createHash} from 'node:crypto';
import {assertProcessor,canonical,dbSafeInteger,DomainError,newId,sha,type Principal} from './model.js';
import type {PgStore,SqlConnection} from '../storage/database.js';
import {bindIntakeBatchToRevision,lockIncomingQueueBatch,selectIncomingQueueEvents,
 validateApplyIncomingBatchScope,verifyIntakeBatchEvents} from './oa-intake-batches.js';

export type IncomingChange='attachment'|'copies'|'paper'|'duplex'|'print_request';
export interface IncomingPilotSettings {
 readonly copies:number;readonly duplex:boolean;readonly paper:'A4';readonly color:'black_white';
}
/** A server-only port. Core resolves the durable registry row first, then asks
 * this adapter to read that exact private artifact; request DTOs never carry a path. */
export interface IncomingSealedSourceReader {
 read_sealed(input:{readonly oa_id:string;readonly provider_event_id:string;readonly artifact_ref:string}):Promise<Uint8Array|null>;
}
export interface ApplyIncomingBatchInput {
 scope:{oa_id:string;customer_id:string;conversation_id:string};
 queue_batch_id:string;lease_token:string;intake_batch_id:string;purpose:'PILOT'|'ORDER';
 expected_generation:number;event_ids:string[];text:string;
 idempotency_key:string;intent:'append_or_create'|'explicit_separate';
 changes:IncomingChange[];
 /** Required for PILOT. It is validated against Core policy and durable SETTINGS membership. */
 pilot_settings?:IncomingPilotSettings;
}
export type ApplyIncomingBatchResult=
 | {status:'created'|'existing';order_id:string;active_revision:number}
 | {status:'appended';order_id:string;active_revision:number;requires_reconfirmation:true}
 | {status:'stale_generation'|'needs_human'|'ambiguous'|'closed'};
type OrderMatch={id:string;active_revision:number;manual_lock:boolean;print_closed:boolean;
 approved:boolean;proposal_id:string|null;approved_at:Date|null};
type Inbound={event_id:string;customer_id:string;conversation_id:string;occurred_at:Date;received_at:Date;
 kind:string;source_text:string|null};
type IntakeBinding={event_id:string;queue_batch_id:string;received_at:Date;event_kind:string;role:string;
 customer_id:string;conversation_id:string;kind:string};
type PilotSourceRow={shop_id:string;oa_id:string;event_id:string;customer_id:string;conversation_id:string;
 format:string;artifact_ref:string;sha256:string;size_bytes:string|number};
const changesAllowed=new Set<IncomingChange>(['attachment','copies','paper','duplex','print_request']);
const sourceRef=/^doc-[a-f0-9]{32}\/source-000-([a-f0-9]{64})\.(pdf|docx)$/;
const maxPilotSourceBytes=25*1024*1024;
const privateSourceFailure=()=>new DomainError('INCOMING_SOURCE_NOT_VERIFIED','Sealed source is missing or does not match its verified event',409);
function settingsValue(value:unknown):IncomingPilotSettings{
 if(!value||typeof value!=='object'||Array.isArray(value)||
    Object.keys(value).sort().join(',')!=='color,copies,duplex,paper')
  throw new DomainError('INVALID_INCOMING_PILOT_SETTINGS','Pilot print settings are invalid',422);
 const setting=value as Record<string,unknown>;
 if(!Number.isSafeInteger(setting.copies)||Number(setting.copies)<1||Number(setting.copies)>99||
    typeof setting.duplex!=='boolean'||setting.paper!=='A4'||setting.color!=='black_white')
  throw new DomainError('INVALID_INCOMING_PILOT_SETTINGS','Pilot print settings are outside the supported policy',422);
 return {copies:Number(setting.copies),duplex:setting.duplex,paper:'A4',color:'black_white'};
}
function byteSha256(bytes:Uint8Array):string{return createHash('sha256').update(bytes).digest('hex');}
function validPilotBytes(format:string,bytes:Uint8Array):boolean{
 if(format==='PDF')return bytes.byteLength>=5&&bytes[0]===0x25&&bytes[1]===0x50&&bytes[2]===0x44&&bytes[3]===0x46&&bytes[4]===0x2d;
 return format==='DOCX'&&bytes.byteLength>=4&&bytes[0]===0x50&&bytes[1]===0x4b&&bytes[2]===0x03&&bytes[3]===0x04;
}
function pilotRequestData(source:PilotSourceRow,settings:IncomingPilotSettings,settingsEventIds:string[],
 batchEventIds:string[],baseData:Record<string,unknown>,changes:IncomingChange[],newOrderRequested=false){
 const match=sourceRef.exec(source.artifact_ref);
 if(!match||match[1]!==source.sha256||match[2]!==(source.format==='PDF'?'pdf':'docx'))throw privateSourceFailure();
 const previousIds=baseData.event_ids===undefined?[]:baseData.event_ids;
 const previousBatches=baseData.incoming_batches===undefined?[]:baseData.incoming_batches;
 if(!Array.isArray(previousIds)||previousIds.some(id=>typeof id!=='string')||
    !Array.isArray(previousBatches)||
    (baseData.documents!==undefined&&(!Array.isArray(baseData.documents)||baseData.documents.length!==0))||
    baseData.sealed_source!==undefined||baseData.pilot_settings!==undefined)
  throw new DomainError('INCOMING_SOURCE_REVISION_CONFLICT','Current order already has a different document/source binding',409);
 if(batchEventIds.some(id=>previousIds.includes(id)))
  throw new DomainError('INCOMING_EVENT_ALREADY_USED','Pilot intake reuses an event already recorded on the order',409);
 const allEventIds=[...previousIds,...batchEventIds];
 if(new Set(allEventIds).size!==allEventIds.length||settingsEventIds.some(id=>!batchEventIds.includes(id))||
    !batchEventIds.includes(source.event_id))throw privateSourceFailure();
 const safeSettings={copies:settings.copies,duplex:settings.duplex,paper:settings.paper,color:settings.color};
 return {...baseData,event_ids:allEventIds,
  incoming_batches:[...previousBatches,{event_ids:batchEventIds,changes,source:'verified_inbound',
   ...(newOrderRequested?{order_intent:'NEW'}:{})}],
  documents:[{artifact_name:source.artifact_ref,copies:settings.copies,duplex:settings.duplex,paper:'A4'}],
  sealed_source:{format:source.format,sha256:source.sha256,size_bytes:dbSafeInteger(source.size_bytes,'pilot.source_size_bytes'),
   provider_event_id:source.event_id},pilot_settings:safeSettings,
  pilot_settings_sha256:sha(canonical(safeSettings)),settings_event_ids:settingsEventIds};
}
function bounded(x:string,name:string,max:number){
 if(typeof x!=='string'||!x.trim()||x.length>max)
  throw new DomainError('INVALID_INCOMING_BATCH','Invalid '+name,422);
 return x;
}
const separateEvidence=/(?:đơn\s+(?:in\s+)?(?:mới|riêng|khác)|đơn\s+thứ\s+hai)/iu;
const negatedSeparate=/(?:không|đừng|chưa)\s+(?:cần\s+|muốn\s+)?(?:tạo|lập|mở|làm|tách)\s+(?:một\s+)?đơn\s+(?:in\s+)?(?:mới|riêng|khác)/iu;
function identifiers(input:ApplyIncomingBatchInput){
 const allowed=new Set(['scope','queue_batch_id','lease_token','intake_batch_id','purpose','expected_generation',
  'event_ids','text','idempotency_key','intent','changes','pilot_settings']);
 if(!input||typeof input!=='object'||Object.keys(input).some(key=>!allowed.has(key)))
  throw new DomainError('INVALID_INCOMING_BATCH','Unsupported incoming batch field',422);
 const conv=bounded(input.scope.conversation_id,'conversation_id',256),
 customer=bounded(input.scope.customer_id,'customer_id',256);
 const batch=validateApplyIncomingBatchScope(input);
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
 if(input.purpose!=='PILOT'&&input.purpose!=='ORDER')
  throw new DomainError('INVALID_INCOMING_BATCH','Invalid purpose',422);
 const pilotSettings=input.pilot_settings===undefined?undefined:settingsValue(input.pilot_settings);
 if((input.purpose==='PILOT'&&!pilotSettings)||(input.purpose==='ORDER'&&pilotSettings))
  throw new DomainError('INVALID_INCOMING_PILOT_SETTINGS','Pilot settings are required only for PILOT batches',422);
 return {conv,customer,ids,batch,purpose:input.purpose,text:bounded(input.text,'text',4000),
  key:bounded(input.idempotency_key,'idempotency_key',128),pilotSettings};
}
/**
 * AI0 must inject authenticated PROCESSOR identity and server-owned OA/shop.
 * Ingestion, active-order lookup, generation CAS, append/create, and idempotency
 * all commit in ONE PgStore transaction. No customer/staff principal is minted.
 * AI2's scope is cross-checked against verified provider rows, never trusted.
 */
export function createIncomingBatchPort(options:{
 store:PgStore;trusted:{readonly shop_id:string;readonly oa_id:string};processor:Principal;
 sealed_source_reader?:IncomingSealedSourceReader
}){
 const {store,trusted,processor,sealed_source_reader:sealedSourceReader}=options;
 if(!store?.tx||!trusted||typeof trusted.shop_id!=='string'||!trusted.shop_id.trim()||
    typeof trusted.oa_id!=='string'||!trusted.oa_id.trim())
  throw new DomainError('INCOMING_PORT_UNCONFIGURED','Server OA/shop mapping required',503);
 assertProcessor(processor);
 if(processor.shop_id!==trusted.shop_id||!processor.id)
  throw new DomainError('INCOMING_PROCESSOR_SCOPE_DENIED','Processor not bound to shop',403);
 const shop=bounded(trusted.shop_id,'shop_id',128),oa=bounded(trusted.oa_id,'oa_id',256);
 async function verified(db:SqlConnection,conv:string,customer:string,ids:string[],batch:{queue_batch_id:string;lease_token:string;intake_batch_id:string},purpose:'PILOT'|'ORDER'):Promise<Inbound[]>{
  const found=await db.query('SELECT shop_id FROM core_shop_settings WHERE shop_id=$1 FOR SHARE',[shop]);
  if(found.rows.length!==1)throw new DomainError('INCOMING_SHOP_NOT_FOUND','Shop absent',403);
  const registry=await db.query<{shop_id:string}>('SELECT shop_id FROM core_shop_zalo_oa_registry WHERE shop_id=$1 AND oa_id=$2 FOR SHARE',[shop,oa]);
  if(registry.rows.length!==1)throw new DomainError('INCOMING_OA_SCOPE_DENIED','OA is not bound to the trusted shop',403);
  const queue=await lockIncomingQueueBatch(db,batch.queue_batch_id,batch.lease_token,oa);
  const selected=selectIncomingQueueEvents(queue,ids);
  if(selected.length!==ids.length||selected.some(e=>e.customer_id!==customer||e.conversation_id!==conv))
   throw new DomainError('INCOMING_EVENT_SCOPE_DENIED','Event/OA/customer/chat mismatch',403);
  await verifyIntakeBatchEvents(db,{intake_batch_id:batch.intake_batch_id,queue_batch_id:batch.queue_batch_id,
   shop_id:shop,oa_id:oa,customer_id:customer,conversation_id:conv,event_ids:ids,purpose});
  return selected.map(event=>({event_id:event.event_id,customer_id:event.customer_id,conversation_id:event.conversation_id,
   occurred_at:event.received_at,received_at:event.received_at,kind:event.kind,source_text:event.source_text}));
 }
 async function pilotIntakeBindings(db:SqlConnection,input:ApplyIncomingBatchInput,customer:string,conversation:string):Promise<{
  bindings:IntakeBinding[];new_order_requested:boolean;opened_at:Date
 }>{
  const batch=(await db.query<{id:string;shop_id:string;oa_id:string;customer_id:string;conversation_id:string;
   purpose:string;status:string;opened_at:Date;expires_at:Date;order_id:string|null;revision:number|null;new_order_requested:boolean}>(
   'SELECT id,shop_id,oa_id,customer_id,conversation_id,purpose,status,opened_at,expires_at,order_id,revision,new_order_requested '+
   'FROM core_oa_intake_batches WHERE id=$1 FOR UPDATE',[input.intake_batch_id])).rows[0];
  if(!batch||batch.shop_id!==shop||batch.oa_id!==oa||batch.customer_id!==customer||
     batch.conversation_id!==conversation||batch.purpose!=='PILOT')
   throw new DomainError('INCOMING_BATCH_SCOPE_DENIED','Pilot intake scope mismatch',403);
  const clock=(await db.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0]?.now;
  if((batch.status!=='OPEN'&&batch.status!=='BOUND')||!clock||new Date(batch.expires_at).getTime()<=new Date(clock).getTime())
   throw new DomainError('INCOMING_BATCH_EXPIRED','Pilot intake batch is closed or expired',409);
  if((batch.order_id===null)!==(batch.revision===null))
   throw new DomainError('INCOMING_BATCH_ORDER_CONFLICT','Pilot intake has incomplete revision binding',409);
  if(batch.order_id){
   const current=(await db.query<{active_revision:number}>('SELECT active_revision FROM core_orders WHERE id=$1 AND shop_id=$2 FOR SHARE',
    [batch.order_id,shop])).rows[0];
   if(!current||current.active_revision!==batch.revision)
    throw new DomainError('INCOMING_REVISION_CHANGED','Pilot intake is bound to a stale order revision',409);
  }
  const bindings=(await db.query<IntakeBinding&{event_received_at:Date}>(
   'SELECT b.event_id,b.queue_batch_id::text,b.received_at,b.event_kind,b.role,e.customer_id,e.conversation_id,e.received_at AS event_received_at,'+
   "e.payload_json->>'kind' AS kind FROM core_oa_intake_event_bindings b "+
   'JOIN zalo_inbound_events e ON e.oa_id=b.oa_id AND e.event_id=b.event_id '+
   'JOIN zalo_batch_items i ON i.batch_id=b.queue_batch_id AND i.oa_id=b.oa_id AND i.event_id=b.event_id '+
   'JOIN zalo_batches q ON q.id=b.queue_batch_id AND q.oa_id=b.oa_id '+
   'WHERE b.intake_batch_id=$1 AND b.oa_id=$2 ORDER BY b.received_at,b.event_id FOR SHARE OF e',
   [input.intake_batch_id,oa])).rows;
  const count=(await db.query<{count:string}>(
   'SELECT count(*)::text AS count FROM core_oa_intake_event_bindings WHERE intake_batch_id=$1 AND oa_id=$2',
   [input.intake_batch_id,oa])).rows[0]?.count;
  if(!count||Number(count)!==bindings.length||bindings.length<1||bindings.some(row=>
     row.customer_id!==customer||row.conversation_id!==conversation||row.kind!==row.event_kind||
     new Date(row.received_at).getTime()!==new Date(row.event_received_at).getTime()||
     !['text','image','file'].includes(row.kind)||!['CONTEXT','CODE','SOURCE','SETTINGS'].includes(row.role)))
   throw new DomainError('INCOMING_EVENT_MEMBERSHIP_DENIED','Pilot intake membership is incomplete or changed',403);
  return {bindings,new_order_requested:batch.new_order_requested,opened_at:batch.opened_at};
 }
 async function readPilotSource(db:SqlConnection,bindings:IntakeBinding[],customer:string,conversation:string):Promise<PilotSourceRow>{
  if(!sealedSourceReader||typeof sealedSourceReader.read_sealed!=='function')
   throw new DomainError('INCOMING_SOURCE_NOT_CONFIGURED','Private sealed-source reader is required for PILOT',503);
  const sources=bindings.filter(row=>row.role==='SOURCE');
  if(sources.length!==1||sources[0]?.kind!=='file')
   throw new DomainError('INCOMING_PILOT_SOURCE_NOT_READY','Pilot intake requires exactly one bound file event',409);
  const sourceEvent=sources[0]!;
  const table=(await db.query<{sources:string|null}>(
   "SELECT to_regclass('public.ai0_pilot_private_sources')::text AS sources")).rows[0]?.sources;
  if(!table)throw new DomainError('INCOMING_SOURCE_NOT_CONFIGURED','Private source registry is missing',503);
  const rows=(await db.query<PilotSourceRow>(
   'SELECT shop_id,oa_id,event_id,customer_id,conversation_id,format,artifact_ref,btrim(sha256) AS sha256,size_bytes '+
   'FROM ai0_pilot_private_sources WHERE shop_id=$1 AND oa_id=$2 AND event_id=$3 FOR SHARE',
   [shop,oa,sourceEvent.event_id])).rows;
  const row=rows[0];
  if(rows.length!==1||!row||row.shop_id!==shop||row.oa_id!==oa||row.event_id!==sourceEvent.event_id||
     row.customer_id!==customer||row.conversation_id!==conversation||
     (row.format!=='DOCX'&&row.format!=='PDF'))throw privateSourceFailure();
  const size=dbSafeInteger(row.size_bytes,'pilot.source_size_bytes'),match=sourceRef.exec(row.artifact_ref);
  if(size<1||size>maxPilotSourceBytes||!match||match[1]!==row.sha256||
     match[2] !== (row.format==='PDF'?'pdf':'docx'))throw privateSourceFailure();
  let bytes:Uint8Array|null;
  try{bytes=await sealedSourceReader.read_sealed({oa_id:oa,provider_event_id:row.event_id,artifact_ref:row.artifact_ref});}
  catch{throw new DomainError('INCOMING_SOURCE_UNAVAILABLE','Could not read the sealed private source',503,true);}
  if(!(bytes instanceof Uint8Array)||bytes.byteLength!==size||byteSha256(bytes)!==row.sha256||!validPilotBytes(row.format,bytes))
   throw privateSourceFailure();
  return {...row,size_bytes:size};
 }
 async function recheckPilotFence(db:SqlConnection,input:ApplyIncomingBatchInput,customer:string,conversation:string,
  generation:number,orders:OrderMatch[],newOrderRequested:boolean,source?:PilotSourceRow):Promise<void>{
  const queue=(await db.query<{status:string;lease_token:string|null;lease_until:Date|null;now:Date}>(
   'SELECT status,lease_token::text,lease_until,clock_timestamp() AS now FROM zalo_batches WHERE id=$1',[input.queue_batch_id])).rows[0];
  if(!queue||queue.status!=='LEASED'||queue.lease_token!==input.lease_token||!queue.lease_until||
     new Date(queue.lease_until).getTime()<=new Date(queue.now).getTime())
   throw new DomainError('INCOMING_BATCH_LEASE_LOST','Queue lease expired or changed during source read',409);
  const intake=(await db.query<{status:string;expires_at:Date;order_id:string|null;revision:number|null;new_order_requested:boolean}>(
   'SELECT status,expires_at,order_id::text,revision,new_order_requested FROM core_oa_intake_batches WHERE id=$1 AND shop_id=$2 AND oa_id=$3 '+
   'AND customer_id=$4 AND conversation_id=$5 FOR UPDATE',
   [input.intake_batch_id,shop,oa,customer,conversation])).rows[0];
  if(!intake||!['OPEN','BOUND'].includes(intake.status)||new Date(intake.expires_at).getTime()<=new Date(queue.now).getTime())
   throw new DomainError('INCOMING_BATCH_EXPIRED','Pilot intake expired during source read',409);
  if(intake.new_order_requested!==newOrderRequested)
   throw new DomainError('INCOMING_REVISION_CHANGED','Persisted intake order intent changed during private source read',409);
  if(intake.order_id){
   if(intake.revision===null)throw new DomainError('INCOMING_BATCH_ORDER_CONFLICT','Pilot intake revision binding is incomplete',409);
   const order=(await db.query<{active_revision:number}>('SELECT active_revision FROM core_orders WHERE id=$1 AND shop_id=$2 FOR SHARE',
    [intake.order_id,shop])).rows[0];
   if(!order||order.active_revision!==intake.revision)
    throw new DomainError('INCOMING_REVISION_CHANGED','Pilot intake revision changed during private source read',409);
  }
  if(source){
   const current=(await db.query<PilotSourceRow>(
    'SELECT shop_id,oa_id,event_id,customer_id,conversation_id,format,artifact_ref,btrim(sha256) AS sha256,size_bytes '+
    'FROM ai0_pilot_private_sources WHERE shop_id=$1 AND oa_id=$2 AND event_id=$3 FOR SHARE',
    [shop,oa,source.event_id])).rows[0];
   if(!current||current.shop_id!==source.shop_id||current.oa_id!==source.oa_id||current.event_id!==source.event_id||
      current.customer_id!==source.customer_id||current.conversation_id!==source.conversation_id||
      current.format!==source.format||current.artifact_ref!==source.artifact_ref||current.sha256!==source.sha256||
      dbSafeInteger(current.size_bytes,'pilot.source_size_bytes')!==dbSafeInteger(source.size_bytes,'pilot.source_size_bytes'))
    throw privateSourceFailure();
  }
  const latest=await matchingOrders(db,conversation,customer,true);
  if(latest.length!==orders.length||latest.some((row,index)=>row.id!==orders[index]?.id||
     row.active_revision!==orders[index]?.active_revision))
   throw new DomainError('INCOMING_REVISION_CHANGED','Order/revision changed during private source read',409);
  if(!await activeControl(db,conversation,generation))
   throw new DomainError('INCOMING_GENERATION_CHANGED','Conversation generation changed during private source read',409);
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
   " AND j.revision<=$5) "+
   "ORDER BY e.received_at,e.event_id LIMIT 101",[orderId,shop,customer,conv,rev]);
 }
 async function apply_incoming_batch(input:ApplyIncomingBatchInput):Promise<ApplyIncomingBatchResult>{
  if(!input?.scope||input.scope.oa_id!==oa)
   throw new DomainError('INCOMING_OA_SCOPE_DENIED','Untrusted OA',403);
  const {conv,customer,ids,key,text,batch,purpose,pilotSettings}=identifiers(input);
  return store.tx(async db=>{
   // The post-I/O source, lease, revision and generation fences must observe
   // the latest committed state even when the pool has a stricter default.
   await db.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
   // The AI0 inbound INSERT trigger locks the relevant order row. We use the
   // same row order, then generation row, then revisions/journals. No pre-read
   // in another transaction can authorize an append.
   const events=await verified(db,conv,customer,ids,batch,purpose);
   // Lock candidate orders first (approval and verified-confirmation lock these rows first).
   // Re-read under the generation lock: another legacy worker may have created an
   // order while we were acquiring it. No unlocked candidate list is authoritative.
   await matchingOrders(db,conv,customer,true);
   if(!await activeControl(db,conv,input.expected_generation))
    return {status:'stale_generation'};
   const matches=await matchingOrders(db,conv,customer,true);
   if(matches.some(x=>x.proposal_id===null))return {status:'ambiguous'};
   let fingerprint=sha(canonical({conversation_id:conv,event_ids:ids}));
   let contentHash=sha(canonical({conversation_id:conv,customer_id:customer,text,expected_generation:input.expected_generation}));
   let pilotSource:PilotSourceRow|undefined;
   let pilotSettingsEventIds:string[]=[];
   let pilotEventIds:string[]=[];
   let newOrderRequested=false;
   let newOrderRequestedAt:Date|undefined;
   if(purpose==='PILOT'){
    const intake=await pilotIntakeBindings(db,input,customer,conv);
    const intakeBindings=intake.bindings;
    newOrderRequested=intake.new_order_requested;
    newOrderRequestedAt=intake.opened_at;
    const settingsBindings=intakeBindings.filter(row=>row.role==='SETTINGS');
    if(settingsBindings.length===0||settingsBindings.some(row=>row.kind!=='text'))
     throw new DomainError('INCOMING_PILOT_SETTINGS_NOT_READY','Pilot intake requires bound text settings events',409);
    pilotSettingsEventIds=settingsBindings.map(row=>row.event_id);
    pilotEventIds=intakeBindings.map(row=>row.event_id);
    pilotSource=await readPilotSource(db,intakeBindings,customer,conv);
    // Recheck the queue lease and the locked order/revision/generation after
    // private file I/O. No source bytes escape this transaction boundary.
    await recheckPilotFence(db,input,customer,conv,input.expected_generation,matches,newOrderRequested,pilotSource);
    fingerprint=sha(canonical({conversation_id:conv,intake_batch_id:batch.intake_batch_id,event_ids:pilotEventIds}));
    contentHash=sha(canonical({schema:'ai1.pilot_incoming_revision.v1',conversation_id:conv,
     customer_id:customer,expected_generation:input.expected_generation,
     intent:newOrderRequested?'NEW':input.intent,
     changes:input.changes,
     source:{provider_event_id:pilotSource.event_id,format:pilotSource.format,sha256:pilotSource.sha256,
      size_bytes:pilotSource.size_bytes},settings:pilotSettings,settings_event_ids:pilotSettingsEventIds}));
   }else{
    const intake=(await db.query<{new_order_requested:boolean;status:string;opened_at:Date;expires_at:Date}>(
     'SELECT new_order_requested,status,opened_at,expires_at FROM core_oa_intake_batches WHERE id=$1 AND shop_id=$2 AND oa_id=$3 '+
     'AND customer_id=$4 AND conversation_id=$5 AND purpose=$6 FOR UPDATE',
     [batch.intake_batch_id,shop,oa,customer,conv,purpose])).rows[0];
    if(!intake)throw new DomainError('INCOMING_BATCH_SCOPE_DENIED','Incoming intake scope mismatch',403);
    const now=(await db.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0]?.now;
    if(!now||!['OPEN','BOUND'].includes(intake.status)||new Date(intake.expires_at).getTime()<=new Date(now).getTime())
     throw new DomainError('INCOMING_BATCH_EXPIRED','Incoming intake is closed or expired',409);
    newOrderRequested=intake.new_order_requested;
    newOrderRequestedAt=intake.opened_at;
    contentHash=sha(canonical({conversation_id:conv,customer_id:customer,text,expected_generation:input.expected_generation,
     intent:newOrderRequested?'NEW':input.intent}));
   }
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
   if(!newOrderRequested&&input.intent==='append_or_create'&&open.length>1)return {status:'ambiguous'};
   const closed=matches.filter(x=>x.approved||x.print_closed||x.manual_lock);
   // A delayed provider message received BEFORE staff approval belongs to the
   // old order, never to a newly fabricated post-approval order.
   if(open.length===0&&closed.length&&(input.intent==='append_or_create'||newOrderRequested)){
    const latest=closed.map(x=>x.approved_at).filter((v):v is Date=>v!==null);
    if(latest.length===0)return {status:'closed'};
    const threshold=Math.max(...latest.map(x=>new Date(x).getTime()));
    const delayed=newOrderRequested&&newOrderRequestedAt
     ?new Date(newOrderRequestedAt).getTime()<=threshold
     :events.some(e=>new Date(e.received_at).getTime()<=threshold||new Date(e.occurred_at).getTime()<=threshold);
    if(delayed)return {status:'closed'};
   }
   if(!newOrderRequested&&input.intent==='explicit_separate'){
    const source=events.filter(e=>e.kind==='text'&&typeof e.source_text==='string')
      .map(e=>e.source_text??'').join(' ');
    if(!separateEvidence.test(source)||negatedSeparate.test(source))
     return {status:'needs_human'}; // classification alone isn't customer proof
   }
   if(!newOrderRequested&&input.intent==='append_or_create'&&open.length===1){
    const target=open[0];
    if(!target)return {status:'ambiguous'};
    const eventIdsForRevision=purpose==='PILOT'?pilotEventIds:ids;
    const used=await db.query(
     'SELECT 1 FROM core_order_inbound_reviews WHERE oa_id=$1 AND event_id=ANY($2::text[]) LIMIT 1',
     [oa,eventIdsForRevision]);
    if(used.rows.length)throw new DomainError('INCOMING_EVENT_ALREADY_USED','Event belongs to prior revision',409);
    const rev=(await db.query<{request_data:unknown}>(
     'SELECT request_data FROM core_revisions WHERE order_id=$1 AND revision=$2',
     [target.id,target.active_revision])).rows[0];
    if(!rev?.request_data||typeof rev.request_data!=='object'||Array.isArray(rev.request_data))
     return {status:'needs_human'};
    const data=rev.request_data as Record<string,unknown>;
    const previousIds=data.event_ids;
    if(!Array.isArray(previousIds)||previousIds.some(e=>typeof e!=='string')||
       eventIdsForRevision.some(e=>previousIds.includes(e)))return {status:'needs_human'};
    if(!Number.isSafeInteger(target.active_revision+1))throw new DomainError('REVISION_OVERFLOW','Revision exhausted',409);
    const revision=target.active_revision+1;
    const nextData=purpose==='PILOT'
     ?pilotRequestData(pilotSource!,pilotSettings!,pilotSettingsEventIds,pilotEventIds,data,input.changes)
     :{...data,event_ids:[...previousIds,...eventIdsForRevision],
       incoming_batches:[...(Array.isArray(data.incoming_batches)?data.incoming_batches:[]),
        {event_ids:eventIdsForRevision,changes:input.changes,source:'verified_inbound'}]};
    const hash=sha(canonical(nextData));
    await db.query('INSERT INTO core_revisions(order_id,revision,request_hash,request_data,plan) VALUES($1,$2,$3,$4::jsonb,NULL)',
     [target.id,revision,hash,JSON.stringify(nextData)]);
    await db.query('UPDATE core_orders SET active_revision=$2,updated_at=now() WHERE id=$1',[target.id,revision]);
    await bindIntakeBatchToRevision(db,{intake_batch_id:batch.intake_batch_id,shop_id:shop,oa_id:oa,
     customer_id:customer,conversation_id:conv,order_id:target.id,revision,purpose});
    await db.query('INSERT INTO core_order_supplement_batches(order_id,shop_id,oa_id,event_fingerprint,idempotency_key,revision,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7)',
     [target.id,shop,oa,fingerprint,key,revision,hash]);
    for(const e of eventIdsForRevision)await db.query(
     'INSERT INTO core_order_inbound_reviews(shop_id,oa_id,event_id,order_id,revision,reviewed_by) VALUES($1,$2,$3,$4,$5,$6)',
     [shop,oa,e,target.id,revision,processor.id]);
    await db.query('INSERT INTO core_audit(id,shop_id,actor_id,action,order_id,details) VALUES($1,$2,$3,$4,$5,$6::jsonb)',
     [newId(),shop,processor.id,'order.incoming_batch_appended',target.id,JSON.stringify({revision,event_count:eventIdsForRevision.length})]);
    return {status:'appended',order_id:target.id,active_revision:revision,requires_reconfirmation:true};
   }
   // When there is no open order, or customer *explicitly* requested a
   // separate one, create exactly ONE draft under the conversation lock.
   if(!newOrderRequested&&input.intent==='append_or_create'&&open.length!==0)return {status:'ambiguous'};
   const orderId=newId();
   const data=purpose==='PILOT'
    ?pilotRequestData(pilotSource!,pilotSettings!,pilotSettingsEventIds,pilotEventIds,
      {source:'zalo_ai_suggestion',conversation_id:conv,text:'[PILOT_SOURCE_AND_SETTINGS_BOUND]'},input.changes,newOrderRequested)
    :{source:'zalo_ai_suggestion',conversation_id:conv,event_ids:ids,
      text,incoming_batches:[{event_ids:ids,changes:input.changes,source:'verified_inbound',
       ...(newOrderRequested?{order_intent:'NEW'}:{})}]};
   const hash=sha(canonical(data));
   await db.query('INSERT INTO core_orders(id,shop_id,customer_id,conversation_id) VALUES($1,$2,$3,$4)',
    [orderId,shop,customer,conv]);
   await db.query('INSERT INTO core_revisions(order_id,revision,request_hash,request_data) VALUES($1,1,$2,$3::jsonb)',
    [orderId,hash,JSON.stringify(data)]);
   await bindIntakeBatchToRevision(db,{intake_batch_id:batch.intake_batch_id,shop_id:shop,oa_id:oa,
    customer_id:customer,conversation_id:conv,order_id:orderId,revision:1,purpose});
   await db.query('INSERT INTO core_ai_draft_proposals(shop_id,oa_id,conversation_id,customer_id,event_fingerprint,idempotency_key,content_hash,order_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    [shop,oa,conv,customer,fingerprint,key,contentHash,orderId]);
   const eventIdsForRevision=purpose==='PILOT'?pilotEventIds:ids;
   for(const eventId of eventIdsForRevision)await db.query(
    'INSERT INTO core_order_inbound_reviews(shop_id,oa_id,event_id,order_id,revision,reviewed_by) VALUES($1,$2,$3,$4,$5,$6)',
    [shop,oa,eventId,orderId,1,processor.id]);
   await db.query('INSERT INTO core_audit(id,shop_id,actor_id,action,order_id,details) VALUES($1,$2,$3,$4,$5,$6::jsonb)',
    [newId(),shop,processor.id,'order.incoming_batch_created',orderId,JSON.stringify({event_count:eventIdsForRevision.length})]);
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
