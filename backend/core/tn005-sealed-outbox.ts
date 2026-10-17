import {randomBytes,createHash} from 'node:crypto';
import {DomainError,dbSafeInteger,canonical,sha} from './model.js';
import type {PgStore,SqlConnection} from '../storage/database.js';
import {formatBoundFirstPageQuestion} from '../conversation/first-page-question.js';

/** Only AI0's server-side sealed-file verifier can satisfy this required Port.
 * A boolean in AI2 intent, request JSON, or client metadata is NOT evidence.
 * Verification MUST hash actual sealed bytes/manifest for this bound event.
 */
export type VerifiedSourcePort=(bound:Readonly<SealedSourceBinding>)=>Promise<boolean>;
export interface SealedSourceBinding {
 readonly shop_id:string; readonly oa_id:string; readonly event_id:string;
 readonly order_id:string; readonly revision:number; readonly request_hash:string;
 readonly source_sha256:string; readonly artifact_ref:string;
}
export interface Tn005EnqueueRequest {
 readonly outbound_id:string; readonly idempotency_key:string;
 readonly order_id:string; readonly revision:number; readonly generation:number;
 readonly request_hash:string; readonly source_sha256:string; readonly text:string;
}
export interface Tn005Lease {outbound_id:string; token:string}
export interface FakeOrApprovedSender {
 send_text(conversation_id:string,text:string):Promise<void>;
}
type Row={shop_id:string;oa_id:string;order_id:string;revision:number;generation:string;
 request_hash:string;source_sha256:string;outbound_id:string;status:string;
 conversation_id:string;customer_id:string;event_id:string;body_text:string;
 token_sha256:string|null};
type Source={shop_id:string;oa_id:string;order_id:string;active_revision:number;
 customer_id:string;conversation_id:string|null;event_id:string;
 request_hash:string;request_data:unknown;source_sha256:string;artifact_ref:string;
 advisory_request_hash:string;advisory_sha256:string;metadata:unknown;mode:string};
const digest=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v);
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(v);
const bounded=(v:unknown,max:number)=>typeof v==='string'&&v.length>0&&v.length<=max;
const denied=(code='TN005_STALE'):never=>{throw new DomainError(code,'TN005 evidence or conversation is no longer current',409);};
const hashToken=(v:string)=>createHash('sha256').update(v).digest('hex');
/** AI0 owns real sender wiring; this AI1 Port never runs a provider itself. */
export function createTn005SealedOutbox(options:{
 readonly store:PgStore;readonly trusted:{shop_id:string;oa_id:string};
 readonly verify_sealed_source:VerifiedSourcePort;
}) {
 if(!options?.store?.tx||!bounded(options.trusted?.shop_id,128)||
    !bounded(options.trusted?.oa_id,256)||typeof options.verify_sealed_source!=='function')
  throw new DomainError('TN005_PORT_UNCONFIGURED','Trusted AI0 sealed source Port required',503);
 const {store,verify_sealed_source}=options;
 const shop=options.trusted.shop_id,oa=options.trusted.oa_id;
 const checkInput=(i:Tn005EnqueueRequest)=>{
  if(!i||!uuid(i.order_id)||!uuid(i.outbound_id)||!bounded(i.idempotency_key,128)||
     !Number.isSafeInteger(i.revision)||i.revision<1||
     !Number.isSafeInteger(i.generation)||i.generation<0||
     !digest(i.request_hash)||!digest(i.source_sha256)||
     !bounded(i.text,4000))throw new DomainError('TN005_INVALID_INPUT','Malformed suggested question',422);
 };
 async function source(db:SqlConnection,orderId:string):Promise<Source> {
  const result=await db.query<Source>(
   'SELECT o.shop_id,o.id::text AS order_id,o.active_revision,o.customer_id,o.conversation_id,'+
   'd.oa_id,d.event_id,r.request_hash,r.request_data,a.sha256 AS source_sha256,a.artifact_ref,'+
   'f.request_hash AS advisory_request_hash,f.artifact_sha256 AS advisory_sha256,f.metadata,s.mode '+
   'FROM core_orders o JOIN core_revisions r ON r.order_id=o.id AND r.revision=o.active_revision '+
   "JOIN ai0_inbound_artifact_drafts d ON d.order_id=o.id AND d.shop_id=o.shop_id AND d.status='CREATED' "+
   'JOIN ai0_inbound_document_artifacts a ON a.shop_id=d.shop_id AND a.oa_id=d.oa_id AND a.event_id=d.event_id '+
   'JOIN ai0_first_page_suggestions f ON f.shop_id=o.shop_id AND f.order_id=o.id AND f.revision=r.revision '+
   'JOIN core_shop_settings s ON s.shop_id=o.shop_id '+
   'WHERE o.shop_id=$1 AND o.id=$2::uuid AND d.oa_id=$3 '+
   'FOR UPDATE OF o FOR SHARE OF d,a,f,r',[shop,orderId,oa]);
  if(result.rows.length!==1||!result.rows[0])return denied();
  return result.rows[0];
 }
 async function current(db:SqlConnection,orderId:string,revision:number,
  generation:number,requestHash:string,sourceSha:string,text?:string):Promise<{src:Source;text:string}> {
  // Lock order first (same order as Core.revise), then AI1 generation; never invert.
  const src=await source(db,orderId);
  if(src.mode!=='simulation'||!src.conversation_id||
     src.active_revision!==revision||src.request_hash!==requestHash||
     src.source_sha256!==sourceSha||src.advisory_request_hash!==requestHash||
     src.advisory_sha256!==sourceSha||!digest(requestHash)||!digest(sourceSha))
   return denied();
  const ctrl=(await db.query<{status:string;generation:string}>(
   'SELECT status,generation::text AS generation FROM core_conversation_controls '+
   'WHERE shop_id=$1 AND conversation_id=$2 FOR UPDATE',[shop,src.conversation_id])).rows[0];
  if(!ctrl||ctrl.status!=='AI'||dbSafeInteger(ctrl.generation,'tn005.generation')!==generation)return denied('TN005_HANDOVER');
  const documents=(src.request_data as {documents?:unknown})?.documents;
  if(!Array.isArray(documents)||documents.length!==1||
     (documents[0] as {artifact_name?:unknown})?.artifact_name!==src.artifact_ref)return denied();
  const binding:SealedSourceBinding={shop_id:shop,oa_id:oa,event_id:src.event_id,
   order_id:orderId,revision,request_hash:requestHash,source_sha256:sourceSha,
   artifact_ref:src.artifact_ref};
  // Never use a provided 'verified' flag: AI0 verifier recomputes sealed source proof.
  if(await verify_sealed_source(Object.freeze(binding))!==true)return denied('TN005_SOURCE_UNVERIFIED');
  const formatted=formatBoundFirstPageQuestion(
   {shop_id:shop,order_id:orderId,revision,oa_id:oa,customer_id:src.customer_id,
    conversation_id:src.conversation_id},
   {current:{shop_id:shop,order_id:orderId,active_revision:revision,
     oa_id:oa,customer_id:src.customer_id,conversation_id:src.conversation_id,
     request_hash:requestHash,source_sha256:sourceSha,sealed_source_verified:true},
    advisory:{shop_id:shop,order_id:orderId,revision,request_hash:requestHash,
     artifact_sha256:sourceSha,metadata:src.metadata}});
  if(!formatted.used_suggestion||(text!==undefined&&formatted.text!==text))return denied('TN005_TEXT_UNVERIFIED');
  return {src,text:formatted.text};
 }
 async function enqueue(i:Tn005EnqueueRequest):Promise<{status:'queued';outbound_id:string}> {
  checkInput(i);
  return store.tx(async db=>{
   const checked=await current(db,i.order_id,i.revision,i.generation,i.request_hash,i.source_sha256,i.text);
   const existing=(await db.query<Row>(
    'SELECT * FROM core_tn005_suggested_outbox WHERE outbound_id=$1 FOR UPDATE',[i.outbound_id])).rows[0];
   if(existing) {
    if(existing.shop_id!==shop||existing.oa_id!==oa||existing.order_id!==i.order_id||
       existing.revision!==i.revision||dbSafeInteger(existing.generation,'tn005.generation')!==i.generation||
       existing.request_hash!==i.request_hash||existing.source_sha256!==i.source_sha256||
       existing.body_text!==checked.text||existing.idempotency_key!==i.idempotency_key)
      return denied('TN005_IDEMPOTENCY_CONFLICT');
    // Only same current evidence can replay. Never transition RESERVED/SENT/UNKNOWN back to QUEUED.
    return {status:'queued',outbound_id:i.outbound_id};
   }
   await db.query(
    'INSERT INTO core_tn005_suggested_outbox(outbound_id,shop_id,oa_id,order_id,revision,'+
    'generation,request_hash,source_sha256,event_id,conversation_id,customer_id,body_text,idempotency_key) '+
    'VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
    [i.outbound_id,shop,oa,i.order_id,i.revision,i.generation,i.request_hash,
     i.source_sha256,checked.src.event_id,checked.src.conversation_id,
     checked.src.customer_id,checked.text,i.idempotency_key]);
   return {status:'queued',outbound_id:i.outbound_id};
  });
 }
 async function inspect(db:SqlConnection,outboundId:string):Promise<Row|null>{
  const peek=(await db.query<{order_id:string}>(
   'SELECT order_id::text AS order_id FROM core_tn005_suggested_outbox '+
   'WHERE outbound_id=$1 AND shop_id=$2 AND oa_id=$3',[outboundId,shop,oa])).rows[0];
  if(!peek)return null;
  // source() locks Core order before we lock control and outbox.
  const src=await source(db,peek.order_id);
  const row=(await db.query<Row>(
   'SELECT * FROM core_tn005_suggested_outbox WHERE outbound_id=$1 AND shop_id=$2 AND oa_id=$3 FOR UPDATE',
   [outboundId,shop,oa])).rows[0];
  if(!row||row.order_id!==src.order_id)return null;
  return row;
 }
 async function verifyRow(db:SqlConnection,row:Row):Promise<boolean>{
  try {
   const found=await current(db,row.order_id,row.revision,
    dbSafeInteger(row.generation,'tn005.generation'),row.request_hash,row.source_sha256,row.body_text);
   return found.src.conversation_id===row.conversation_id&&
    found.src.customer_id===row.customer_id&&found.src.event_id===row.event_id;
  }catch(e) {
   if(e instanceof DomainError&&e.status===409)return false;
   throw e; // DB or AI0 verifier errors fail closed; never send
  }
 }
 async function reserve(outboundId:string):Promise<Tn005Lease|null>{
  if(!uuid(outboundId))throw new DomainError('TN005_INVALID_INPUT','Invalid outbound ID',422);
  return store.tx(async db=>{
   const row=await inspect(db,outboundId);
   if(!row||row.status!=='QUEUED')return null;
   if(!await verifyRow(db,row)) {
    await db.query("UPDATE core_tn005_suggested_outbox SET status='CANCELLED',finished_at=now() WHERE outbound_id=$1",[outboundId]);
    return null;
   }
   const token=randomBytes(32).toString('base64url');
   await db.query("UPDATE core_tn005_suggested_outbox SET status='RESERVED',token_sha256=$2,reserved_at=now() WHERE outbound_id=$1",
    [outboundId,hashToken(token)]);
   return {outbound_id:outboundId,token};
  });
 }
 async function deliverReserved(lease:Tn005Lease,sender:FakeOrApprovedSender):Promise<'sent'|'blocked'|'unknown'> {
  if(!lease||!uuid(lease.outbound_id)||!bounded(lease.token,256)||typeof sender?.send_text!=='function')
   throw new DomainError('TN005_INVALID_SEND','Untrusted delivery boundary',422);
  const outboundId=lease.outbound_id;
  const prepared=await store.tx(async db=>{
   const row=await inspect(db,outboundId);
   if(!row||row.status!=='RESERVED'||row.token_sha256!==hashToken(lease.token))
    return null;
   // Fresh, authoritative checks immediately at provider-I/O boundary.
   if(!await verifyRow(db,row)){
    await db.query("UPDATE core_tn005_suggested_outbox SET status='CANCELLED',finished_at=now(),token_sha256=NULL WHERE outbound_id=$1",[outboundId]);
    return null;
   }
   const changed=await db.query("UPDATE core_tn005_suggested_outbox SET status='SENDING',token_sha256=NULL WHERE outbound_id=$1 AND status='RESERVED'",[outboundId]);
   if(changed.rowCount!==1)return denied();
   return {conversation_id:row.conversation_id,text:row.body_text};
  });
  if(!prepared)return 'blocked';
  // SENDING is already committed: process crash/ambiguous ACK must be reconciled as UNKNOWN, never replayed.
  let status:'SENT'|'UNKNOWN'='SENT';
  try{await sender.send_text(prepared.conversation_id,prepared.text);}catch{status='UNKNOWN';}
  await store.tx(async db=>{
   const changed=await db.query(
    'UPDATE core_tn005_suggested_outbox SET status=$2,finished_at=now() '+
    "WHERE outbound_id=$1 AND shop_id=$3 AND oa_id=$4 AND status='SENDING'",
    [outboundId,status,shop,oa]);
   if(changed.rowCount!==1)throw new DomainError('TN005_DELIVERY_UNCERTAIN','Reconciliation required',409);
  });
  return status==='SENT'?'sent':'unknown';
 }
 async function reconcileUnknown(outboundId:string):Promise<boolean>{
  if(!uuid(outboundId))throw new DomainError('TN005_INVALID_INPUT','Invalid outbound ID',422);
  return store.tx(async db=>{
   const updated=await db.query(
    "UPDATE core_tn005_suggested_outbox SET status='UNKNOWN',finished_at=now(),token_sha256=NULL "+
    "WHERE outbound_id=$1 AND shop_id=$2 AND oa_id=$3 AND status IN ('SENDING','RESERVED')",
    [outboundId,shop,oa]);
   return updated.rowCount===1;
  });
 }
 return Object.freeze({enqueue,reserve,deliverReserved,reconcileUnknown});
}
