import {createHmac, timingSafeEqual} from 'node:crypto';
import {canonical, DomainError, sha} from './model.js';
import {checkedPdfReviewSnapshot, type PdfReviewSourceScope, type TrustedPdfReviewSourceReader} from './pdf-review-source.js';
import {checkedWordReviewSnapshot, type TrustedWordReviewSourceReader, type WordReviewSourceScope} from './word-review-source.js';
import type {SqlConnection} from '../storage/database.js';

export type PilotSourceFormat='DOCX'|'PDF';
export interface PilotWordPdfCandidate {
 readonly shop_id:string;readonly oa_id:string;readonly customer_id:string;readonly conversation_id:string;
 readonly order_id:string;readonly revision:number;readonly request_hash:string;
 readonly source:{readonly format:PilotSourceFormat;readonly artifact_ref:string;readonly sha256:string;
  readonly size_bytes:number;readonly provider_event_id:string};
 readonly settings:{readonly copies:number;readonly duplex:boolean;readonly paper:'A4';readonly color:'black_white'};
 readonly settings_sha256:string;readonly printer_id:string;
}
export interface PilotCodeSubmission {
 readonly schema:'ai0.pilot_code_submission.v1';readonly shop_id:string;readonly oa_id:string;
 readonly customer_id:string;readonly conversation_id:string;readonly order_id:string;readonly revision:number;
 readonly provider_event_id:string;readonly code:string;readonly idempotency_key:string;
}
export interface PilotShopCodeDisplay {
 readonly schema:'ai0.pilot_shop_code_display.v1';readonly shop_id:string;readonly code:string;
 readonly expires_at:string;readonly server_time:string;
}
export interface PilotPrintAuthorization {
 readonly schema:'ai0.pilot_print_authorization.v1';readonly shop_id:string;readonly oa_id:string;
 readonly customer_id:string;readonly order_id:string;readonly revision:number;readonly request_hash:string;
 readonly source_sha256:string;readonly settings_sha256:string;readonly evidence_sha256:string;
 readonly printer_id:string;readonly code_window_id:string;readonly provider_event_id:string;
 readonly authorized_at:string;readonly job_id:string;
}
export type PilotPrintMode='simulation'|'controlled_test'|'production';
/** Pilot-only ticket. The legacy approval field is intentionally absent. */
export interface PilotAgentJob {
 readonly job_id:string;readonly order_id:string;readonly revision:number;readonly request_hash:string;
 readonly printer_id:string;readonly lease_token:string;readonly lease_seconds:number;readonly mode:PilotPrintMode;
}
export interface PilotAgentWorkEnvelope {
 readonly job:PilotAgentJob;readonly candidate:PilotWordPdfCandidate;readonly authorization:PilotPrintAuthorization;
}
export interface PilotAgentClaimResponse {
 readonly schema:'ai0.pilot_agent_claim.v1';readonly work:PilotAgentWorkEnvelope|null;
}
export interface PilotAgentGateRequest {
 readonly expected_revision:number;readonly lease_token:string;readonly request_hash:string;
 readonly source_sha256:string;readonly settings_sha256:string;readonly evidence_sha256:string;readonly printer_id:string;
}
export interface PilotAgentGateReceipt {
 readonly schema:'ai0.pilot_agent_gate_receipt.v1';readonly state:'AUTHORIZED'|'SENDING';
 readonly job_id:string;readonly order_id:string;readonly revision:number;readonly request_hash:string;
 readonly source_sha256:string;readonly settings_sha256:string;readonly evidence_sha256:string;readonly printer_id:string;
}
export type PilotAgentReportState='SIMULATED_DONE'|'SENT_UNVERIFIED'|'UNKNOWN';
export interface PilotAgentReport {
 readonly schema:'ai0.pilot_agent_report.v1';readonly lease_token:string;readonly idempotency_key:string;
 readonly state:PilotAgentReportState;readonly evidence:Readonly<Record<string,string|number|boolean|null>>;
}
export type PilotReadiness='WAITING_FOR_FILE'|'WAITING_FOR_SETTINGS'|'WAITING_FOR_CODE'|'NEEDS_HUMAN'|
 'AUTHORIZED'|'SENDING'|'SIMULATED_DONE'|'SENT_UNVERIFIED'|'UNKNOWN'|'VERIFIED_DONE';
export type PilotResult=
 | {status:'WAITING_FOR_FILE'|'WAITING_FOR_CODE';reason:string}
 | {status:'WAITING_FOR_SETTINGS'|'NEEDS_HUMAN';reason:string}
 | {status:'AUTHORIZED'|'SENDING'|'SIMULATED_DONE'|'SENT_UNVERIFIED'|'UNKNOWN'|'VERIFIED_DONE';
    authorization:PilotPrintAuthorization;job_state:string};

export interface PilotSourceSnapshot {
 schema:'ai0.pilot_private_source.v1';format:PilotSourceFormat;shop_id:string;order_id:string;
 revision:number;request_hash:string;request_data:unknown;provider_event_id:string;
 source:{artifact_ref:string;sha256:string;size_bytes:number};
 manifest:{ref:string;sha256:string};
 private_bytes:{source:Uint8Array;manifest:Uint8Array};
}

const CODE_ALPHABET='0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const MAX_CODE_ATTEMPTS_CUSTOMER=5;
const MAX_CODE_ATTEMPTS_SHOP=50;
function digestCode(key:Uint8Array,shopId:string,windowId:string,code:string):Buffer{
 return createHmac('sha256',key).update('ai1.pilot.shop-code.verify.v1\0').update(shopId).update('\0')
  .update(windowId).update('\0').update(code,'ascii').digest();
}
export function derivePilotShopCode(key:Uint8Array,shopId:string,windowId:string):string{
 const bytes=createHmac('sha256',key).update('ai1.pilot.shop-code.issue.v1\0').update(shopId).update('\0')
  .update(windowId).digest();
 const value=bytes.readBigUInt64BE(0)>>14n;
 let code='';
 for(let index=9;index>=0;index--)code+=CODE_ALPHABET[Number((value>>BigInt(index*5))&31n)];
 return code;
}
export function pilotCodeHash(key:Uint8Array,shopId:string,windowId:string,code:string):Buffer{
 return digestCode(key,shopId,windowId,code);
}
export function safeEqualPilotCodeHash(actual:Uint8Array,expected:Uint8Array):boolean{
 return actual.byteLength===expected.byteLength&&timingSafeEqual(Buffer.from(actual),Buffer.from(expected));
}
export function pilotRequestHmac(key:Uint8Array,value:unknown):string{
 return createHmac('sha256',key).update('ai1.pilot.submission.v1\0').update(canonical(value)).digest('hex');
}
export function pilotCoreIdempotencyKey(key:Uint8Array,value:Pick<PilotCodeSubmission,'shop_id'|'oa_id'|'provider_event_id'>):string{
 const scope={schema:'ai1.pilot.code_submission_idempotency.v1',shop_id:value.shop_id,oa_id:value.oa_id,
  provider_event_id:value.provider_event_id};
 return `core-pilot:${createHmac('sha256',key).update(canonical(scope)).digest('hex')}`;
}
export function pilotEvidenceHash(value:unknown):string{
 return sha(canonical({schema:'ai0.pilot_print_evidence.v1',value}));
}
export function validPilotCode(value:unknown):value is string{
 return typeof value==='string'&&/^[0-9A-HJKMNP-TV-Z]{10}$/.test(value.toUpperCase());
}
export function canonicalPilotCode(value:string):string{return value.toUpperCase();}
export function pilotLimits(){return {per_customer:MAX_CODE_ATTEMPTS_CUSTOMER,per_shop:MAX_CODE_ATTEMPTS_SHOP};}

function deny():never{throw new DomainError('PILOT_SOURCE_NOT_VERIFIED','Nguồn pilot không khớp đơn hiện hành',409);}
function boundedId(value:unknown,max=256):value is string{
 return typeof value==='string'&&value.length>0&&value.length<=max&&value===value.trim()&&!/[\u0000-\u0020]/.test(value);
}
function isObject(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value);}
function plainObjectKeys(value:Record<string,unknown>):string{return Object.keys(value).sort().join(',');}
function sourceFormatFromRequest(data:unknown):PilotSourceFormat{
 if(!isObject(data)||plainObjectKeys(data)!=='documents'||!Array.isArray(data.documents)||data.documents.length!==1)deny();
 const document=data.documents[0];if(!isObject(document)||typeof document.artifact_name!=='string')deny();
 const name=document.artifact_name.toLowerCase();
 if(name.endsWith('.docx'))return 'DOCX';if(name.endsWith('.pdf'))return 'PDF';deny();
}
function checkedSettings(data:unknown,format:PilotSourceFormat,sourceRef:string,candidate:unknown){
 if(!isObject(data)||!Array.isArray(data.documents)||data.documents.length!==1)deny();
 const doc=data.documents[0];if(!isObject(doc))deny();
 if(plainObjectKeys(doc)!=='artifact_name,copies,duplex,paper')deny();
 if(typeof doc.artifact_name!=='string'||!Number.isSafeInteger(doc.copies)||Number(doc.copies)<1||Number(doc.copies)>99||
    typeof doc.duplex!=='boolean'||doc.paper!=='A4')deny();
 const name=doc.artifact_name;
 if(format==='PDF'&&name!==sourceRef)deny();
 if(format==='DOCX'&&name!==sourceRef&&name!==sourceRef.split('/').pop())deny();
 const settings={copies:Number(doc.copies),duplex:doc.duplex,paper:'A4' as const,color:'black_white' as const};
 if(candidate!==undefined&&(!isObject(candidate)||plainObjectKeys(candidate)!=='color,copies,duplex,paper'||
    candidate.color!=='black_white'||candidate.copies!==doc.copies||candidate.duplex!==doc.duplex||candidate.paper!=='A4'))deny();
 return settings;
}
export function validatePilotCandidateShape(value:unknown):PilotWordPdfCandidate{
 if(!isObject(value)||plainObjectKeys(value)!=='conversation_id,customer_id,oa_id,order_id,printer_id,request_hash,revision,settings,settings_sha256,shop_id,source')deny();
 const source=value.source,settings=value.settings;
 if(!isObject(source)||plainObjectKeys(source)!=='artifact_ref,format,provider_event_id,sha256,size_bytes'||
    !isObject(settings)||plainObjectKeys(settings)!=='color,copies,duplex,paper')deny();
 if(!boundedId(value.shop_id,128)||!boundedId(value.oa_id)||!boundedId(value.customer_id)||
    !boundedId(value.conversation_id)||!boundedId(value.order_id,128)||!boundedId(value.printer_id,128)||
    !Number.isSafeInteger(value.revision)||Number(value.revision)<1||typeof value.request_hash!=='string'||
    !/^[0-9a-f]{64}$/.test(value.request_hash)||typeof value.settings_sha256!=='string'||
    !/^[0-9a-f]{64}$/.test(value.settings_sha256)||
    (source.format!=='DOCX'&&source.format!=='PDF')||!boundedId(source.artifact_ref,512)||
    typeof source.sha256!=='string'||!/^[0-9a-f]{64}$/.test(source.sha256)||
    !Number.isSafeInteger(source.size_bytes)||Number(source.size_bytes)<1||Number(source.size_bytes)>25*1024*1024||
    !boundedId(source.provider_event_id)||!Number.isSafeInteger(settings.copies)||Number(settings.copies)<1||
    Number(settings.copies)>99||typeof settings.duplex!=='boolean'||settings.paper!=='A4'||settings.color!=='black_white')deny();
 return value as unknown as PilotWordPdfCandidate;
}
export function validatePilotSubmissionShape(value:unknown):PilotCodeSubmission{
 if(!isObject(value)||plainObjectKeys(value)!=='code,conversation_id,customer_id,idempotency_key,oa_id,order_id,provider_event_id,revision,schema,shop_id')deny();
 if(value.schema!=='ai0.pilot_code_submission.v1'||!boundedId(value.shop_id,128)||!boundedId(value.oa_id)||
    !boundedId(value.customer_id)||!boundedId(value.conversation_id)||!boundedId(value.order_id,128)||
    !Number.isSafeInteger(value.revision)||Number(value.revision)<1||!boundedId(value.provider_event_id)||
    !boundedId(value.idempotency_key,128)||typeof value.code!=='string'||value.code.length>32)deny();
 return value as unknown as PilotCodeSubmission;
}

export function validatePilotClaimRequest(value:unknown):{printer_id:string;idempotency_key:string}{
 if(!isObject(value)||plainObjectKeys(value)!=='idempotency_key,printer_id'||
    !boundedId(value.printer_id,128)||!boundedId(value.idempotency_key,128))
  throw new DomainError('INVALID_INPUT','Pilot claim request không hợp lệ',422);
 return value as {printer_id:string;idempotency_key:string};
}
export function validatePilotGateRequest(value:unknown):PilotAgentGateRequest{
 if(!isObject(value)||plainObjectKeys(value)!=='evidence_sha256,expected_revision,lease_token,printer_id,request_hash,settings_sha256,source_sha256'||
    !Number.isSafeInteger(value.expected_revision)||Number(value.expected_revision)<1||
    !boundedId(value.lease_token,128)||!boundedId(value.printer_id,128)||
    typeof value.request_hash!=='string'||!/^[0-9a-f]{64}$/.test(value.request_hash)||
    typeof value.source_sha256!=='string'||!/^[0-9a-f]{64}$/.test(value.source_sha256)||
    typeof value.settings_sha256!=='string'||!/^[0-9a-f]{64}$/.test(value.settings_sha256)||
    typeof value.evidence_sha256!=='string'||!/^[0-9a-f]{64}$/.test(value.evidence_sha256))
  throw new DomainError('INVALID_INPUT','Pilot gate request không hợp lệ',422);
 return value as unknown as PilotAgentGateRequest;
}
const pilotReportEvidenceKeys=new Set(['driver_called','spooler_ack','reason_code']);
export function validatePilotAgentReport(value:unknown):PilotAgentReport{
 if(!isObject(value)||plainObjectKeys(value)!=='evidence,idempotency_key,lease_token,schema,state'||
    value.schema!=='ai0.pilot_agent_report.v1'||!boundedId(value.lease_token,128)||
    !boundedId(value.idempotency_key,128)||!['SIMULATED_DONE','SENT_UNVERIFIED','UNKNOWN'].includes(String(value.state))||
    !isObject(value.evidence)||Object.keys(value.evidence).some(key=>!pilotReportEvidenceKeys.has(key)))
  throw new DomainError('INVALID_INPUT','Pilot report không hợp lệ',422);
 const evidence=value.evidence as Record<string,unknown>;
 if(('driver_called'in evidence&&typeof evidence.driver_called!=='boolean')||
    ('spooler_ack'in evidence&&typeof evidence.spooler_ack!=='boolean')||
    ('reason_code'in evidence&&(typeof evidence.reason_code!=='string'||
      !/^[A-Z0-9_]{1,48}$/.test(evidence.reason_code))))
  throw new DomainError('INVALID_INPUT','Pilot report evidence không hợp lệ',422);
 return value as unknown as PilotAgentReport;
}

export async function readPilotSourceSnapshot(db:SqlConnection,readers:{word?:TrustedWordReviewSourceReader;pdf?:TrustedPdfReviewSourceReader},
 scope:{shop_id:string;order_id:string;active_revision:number;request_hash:string;request_data:unknown},expectedEventId:string,
 expectedFormat:PilotSourceFormat):Promise<PilotSourceSnapshot>{
 const format=sourceFormatFromRequest(scope.request_data);
 if(format!==expectedFormat||!boundedId(expectedEventId))deny();
 if(format==='DOCX'){
  if(!readers.word)throw new DomainError('WORD_SOURCE_NOT_CONFIGURED','Word source chưa được nối',503);
  const typedScope=scope as WordReviewSourceScope;
  const first=await readers.word.read_registered(db,Object.freeze({...typedScope}));
  const checked=checkedWordReviewSnapshot(typedScope,first);
  const second=await readers.word.read_registered(db,Object.freeze({...typedScope}));
  const again=checkedWordReviewSnapshot(typedScope,second);
  if(!first||!second||first.provider_event_id!==expectedEventId||second.provider_event_id!==expectedEventId||
     first.source.artifact_ref!==second.source.artifact_ref||first.manifest.ref!==second.manifest.ref||
     !Buffer.from(first.source.bytes).equals(Buffer.from(second.source.bytes))||
     !Buffer.from(first.manifest.bytes).equals(Buffer.from(second.manifest.bytes))||
     checked.source.sha256!==again.source.sha256||checked.manifest.sha256!==again.manifest.sha256)deny();
  checkedSettings(checked.request_data,format,checked.source.artifact_ref,undefined);
  return {schema:'ai0.pilot_private_source.v1',format,shop_id:checked.shop_id,order_id:checked.order_id,
   revision:checked.active_revision,request_hash:checked.request_hash,request_data:checked.request_data,
   provider_event_id:expectedEventId,source:checked.source,manifest:checked.manifest,private_bytes:checked.private_bytes};
 }
 if(!readers.pdf)throw new DomainError('PDF_SOURCE_NOT_CONFIGURED','PDF source chưa được nối',503);
 const typedScope=scope as PdfReviewSourceScope;
 const first=await readers.pdf.read_registered(db,Object.freeze({...typedScope}));
 const checked=checkedPdfReviewSnapshot(typedScope,first);
 const second=await readers.pdf.read_registered(db,Object.freeze({...typedScope}));
 const again=checkedPdfReviewSnapshot(typedScope,second);
 if(!first||!second||first.provider_event_id!==expectedEventId||second.provider_event_id!==expectedEventId||
    first.source.artifact_ref!==second.source.artifact_ref||first.manifest.ref!==second.manifest.ref||
    !Buffer.from(first.source.bytes).equals(Buffer.from(second.source.bytes))||
    !Buffer.from(first.manifest.bytes).equals(Buffer.from(second.manifest.bytes))||
    checked.source.sha256!==again.source.sha256||checked.manifest.sha256!==again.manifest.sha256)deny();
 const settings=checkedSettings(checked.request_data,format,checked.source.artifact_ref,undefined);
 return {schema:'ai0.pilot_private_source.v1',format,shop_id:checked.shop_id,order_id:checked.order_id,
  revision:checked.active_revision,request_hash:checked.request_hash,request_data:checked.request_data,
  provider_event_id:expectedEventId,source:checked.source,manifest:checked.manifest,private_bytes:checked.private_bytes};
}

export function validatePilotStoredSettings(data:unknown,format:PilotSourceFormat,sourceRef:string,candidate:unknown){
 return checkedSettings(data,format,sourceRef,candidate);
}
export function pilotSettingsHash(settings:unknown):string{return sha(canonical(settings));}
