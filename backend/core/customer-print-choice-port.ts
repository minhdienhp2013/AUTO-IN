import {canonical,DomainError,newId,sha,assertProcessor,type Principal} from './model.js';
import type {PgStore,SqlConnection} from '../storage/database.js';
import {parsePrintSetting,PRINT_SETTING_PARSER_VERSION,type PrintSetting} from './order-supplement-port.js';
import type {SealedSourceBinding,VerifiedSourcePort} from './tn005-sealed-outbox.js';

export const CUSTOMER_PRINT_CHOICES_SCHEMA='core.customer_print_choices.v1';
export type CustomerPrintChoiceField='copies'|'paper_size'|'duplex';
export type CustomerPrintChoiceValue=number|'A3'|'A4'|'A5'|boolean;
export type CustomerPrintChoiceValueRecord=Readonly<{
 value:CustomerPrintChoiceValue;origin:'customer';event_id:string;parser_version:string;
}>;
type ChoiceInput={readonly order_id:string;readonly expected_revision:number;
 readonly expected_request_hash:string;readonly expected_source_sha256:string;
 readonly event_ids:readonly string[];readonly idempotency_key:string};
type ChoiceRow={field:CustomerPrintChoiceField;value:unknown;origin:string;event_id:string;
 event_revision:number;parser_version:string;shop_id:string;oa_id:string;customer_id:string;
 conversation_id:string;request_hash:string;source_sha256:string;source_event_id:string};
type EventRow={event_id:string;customer_id:string;conversation_id:string;kind:string;
 persisted_text:string|null;received_at:Date};
type CurrentRow={order_id:string;shop_id:string;customer_id:string;conversation_id:string;
 active_revision:number;manual_lock:boolean;print_closed:boolean;request_hash:string;request_data:unknown;
 source_event_id:string;source_settings_sha256:string;source_completed_at:Date;
 artifact_ref:string;source_sha256:string;manifest_sha256:string;proposal_fingerprint:string;source_customer:string;
 source_conversation:string;artifact_customer:string;artifact_conversation:string;
 source_kind:string;source_payload:unknown;first_request_data:unknown;
 adopted_request_data:unknown;mode:string};
type BatchRow={shop_id:string;oa_id:string;customer_id:string;conversation_id:string;
 event_fingerprint:string;idempotency_key:string;expected_revision:number;expected_request_hash:string;
 expected_source_sha256:string;revision:number;request_hash:string;source_sha256:string;
 source_event_id:string;fields:string[]};
const digest=/^[a-f0-9]{64}$/;
const uuid=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const sourceRef=/^doc-[A-Za-z0-9_-]{6,64}\/source-000-([a-f0-9]{64})\.(pdf|png|jpg|jpeg|tif|tiff|webp|bmp|doc|docx|xls|xlsx|csv|zip)$/;
const fields:readonly CustomerPrintChoiceField[]=['copies','paper_size','duplex'];
const rejected=(code:string,status=409):never=>{
 throw new DomainError(code,'Customer print-choice evidence is stale, ambiguous, or unverified',status);
};
const isRecord=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
const bounded=(v:unknown,max:number)=>typeof v==='string'&&v.trim().length>0&&v.length<=max;
const fieldOf=(setting:PrintSetting):CustomerPrintChoiceField=>Object.keys(setting)[0] as CustomerPrintChoiceField;
const valueOf=(setting:PrintSetting):CustomerPrintChoiceValue=>Object.values(setting)[0] as CustomerPrintChoiceValue;
function validInput(value:unknown):ChoiceInput {
 if(!isRecord(value)||Object.keys(value).sort().join(',')!==
   'event_ids,expected_request_hash,expected_revision,expected_source_sha256,idempotency_key,order_id')
  return rejected('CUSTOMER_PRINT_CHOICE_INVALID_INPUT',422);
 const input=value as unknown as ChoiceInput;
 if(!uuid.test(input.order_id)||!Number.isSafeInteger(input.expected_revision)||input.expected_revision<2||
    typeof input.expected_request_hash!=='string'||!digest.test(input.expected_request_hash)||
    typeof input.expected_source_sha256!=='string'||!digest.test(input.expected_source_sha256)||
    !bounded(input.idempotency_key,128)||!Array.isArray(input.event_ids)||
    input.event_ids.length<1||input.event_ids.length>fields.length)
  return rejected('CUSTOMER_PRINT_CHOICE_INVALID_INPUT',422);
 const ids=input.event_ids.map(id=>{
  if(!bounded(id,256))return rejected('CUSTOMER_PRINT_CHOICE_INVALID_EVENT',422);
  return id;
 });
 if(new Set(ids).size!==ids.length)return rejected('CUSTOMER_PRINT_CHOICE_DUPLICATE_EVENT',422);
 return {...input,event_ids:[...ids].sort()};
}
function parsedChoiceFields(requestData:unknown):Record<string,unknown>|null {
 if(!isRecord(requestData))return null;
 const section=requestData.customer_print_choices;
 if(section===undefined)return null;
 if(!isRecord(section)||section.schema_version!==CUSTOMER_PRINT_CHOICES_SCHEMA||!isRecord(section.fields))
  return rejected('CUSTOMER_PRINT_CHOICE_EVIDENCE_TAMPERED');
 return section.fields;
}
function validateCurrentEvidence(rows:ChoiceRow[],data:unknown,scope:{shop:string;oa:string;customer:string;
 conversation:string;order:string;revision:number;requestHash:string;sourceHash:string;sourceEvent:string}) {
 const embedded=parsedChoiceFields(data);
 if(rows.length===0){
  if(embedded!==null)return rejected('CUSTOMER_PRINT_CHOICE_EVIDENCE_TAMPERED');
  return new Map<CustomerPrintChoiceField,CustomerPrintChoiceValueRecord>();
 }
 if(!embedded)return rejected('CUSTOMER_PRINT_CHOICE_EVIDENCE_TAMPERED');
 const result=new Map<CustomerPrintChoiceField,CustomerPrintChoiceValueRecord>();
 for(const row of rows){
  if(!fields.includes(row.field)||row.origin!=='customer'||row.parser_version!==PRINT_SETTING_PARSER_VERSION||
     row.shop_id!==scope.shop||row.oa_id!==scope.oa||row.customer_id!==scope.customer||
     row.conversation_id!==scope.conversation||row.request_hash!==scope.requestHash||
     row.source_sha256!==scope.sourceHash||row.source_event_id!==scope.sourceEvent||
     result.has(row.field)||!bounded(row.event_id,256)||!Number.isSafeInteger(row.event_revision)||
     row.event_revision<1)return rejected('CUSTOMER_PRINT_CHOICE_EVIDENCE_TAMPERED');
  const record={value:row.value as CustomerPrintChoiceValue,origin:'customer' as const,
   event_id:row.event_id,parser_version:row.parser_version};
  if(!same(embedded[row.field],record))return rejected('CUSTOMER_PRINT_CHOICE_EVIDENCE_TAMPERED');
  result.set(row.field,record);
 }
 if(Object.keys(embedded).sort().join(',')!==[...result.keys()].sort().join(','))
  return rejected('CUSTOMER_PRINT_CHOICE_EVIDENCE_TAMPERED');
 return result;
}

/**
 * Core-owned customer print-choice evidence boundary. Callers provide only
 * trusted selectors, a CAS binding and persisted inbound event IDs. Text and
 * normalized values are always reloaded and parsed inside the transaction.
 */
export function createCustomerPrintChoicePort(options:{store:PgStore;
 trusted:Readonly<{shop_id:string;oa_id:string}>;processor:Principal;
 verify_sealed_source:VerifiedSourcePort}) {
 if(!options?.store?.tx||!bounded(options.trusted?.shop_id,128)||!bounded(options.trusted?.oa_id,256)||
    !options.processor||typeof options.verify_sealed_source!=='function')
  throw new DomainError('CUSTOMER_PRINT_CHOICE_PORT_UNCONFIGURED','Trusted Core and sealed-source proof required',503);
 assertProcessor(options.processor);
 const shop=options.trusted.shop_id,oa=options.trusted.oa_id,processor=options.processor;
 if(processor.shop_id!==shop||!processor.id)
  throw new DomainError('CUSTOMER_PRINT_CHOICE_PROCESSOR_SCOPE','Processor is not bound to shop',403);
 const {store,verify_sealed_source}=options;

 async function currentSource(db:SqlConnection,input:ChoiceInput):Promise<CurrentRow>{
  const result=await db.query<CurrentRow>(
   'SELECT o.id::text AS order_id,o.shop_id,o.customer_id,o.conversation_id,o.active_revision,'+
   'o.manual_lock,o.print_closed,r.request_hash,r.request_data,'+
   'd.event_id AS source_event_id,d.settings_sha256 AS source_settings_sha256,d.completed_at AS source_completed_at,'+
   'a.artifact_ref,a.sha256 AS source_sha256,a.manifest_sha256,p.event_fingerprint AS proposal_fingerprint,'+
   'a.customer_id AS artifact_customer,a.conversation_id AS artifact_conversation,'+
   'se.customer_id AS source_customer,se.conversation_id AS source_conversation,'+
   "se.payload_json->>'kind' AS source_kind,se.payload_json AS source_payload,"+
   'initial_rev.request_data AS first_request_data,adopted.request_data AS adopted_request_data,s.mode '+
   'FROM core_orders o '+
   'JOIN core_revisions r ON r.order_id=o.id AND r.revision=o.active_revision '+
   'JOIN core_revisions initial_rev ON initial_rev.order_id=o.id AND initial_rev.revision=1 '+
   'JOIN core_revisions adopted ON adopted.order_id=o.id AND adopted.revision=2 '+
   'JOIN core_ai_draft_proposals p ON p.order_id=o.id AND p.shop_id=o.shop_id AND p.oa_id=$2 '+
   ' AND p.customer_id=o.customer_id AND p.conversation_id=o.conversation_id '+
   "JOIN ai0_inbound_artifact_drafts d ON d.order_id=o.id AND d.shop_id=o.shop_id AND d.oa_id=$2 AND d.status='CREATED' "+
   'JOIN ai0_inbound_document_artifacts a ON a.shop_id=d.shop_id AND a.oa_id=d.oa_id AND a.event_id=d.event_id '+
   'JOIN zalo_inbound_events se ON se.oa_id=a.oa_id AND se.event_id=a.event_id '+
   "JOIN core_shop_settings s ON s.shop_id=o.shop_id AND s.mode='simulation' "+
   'WHERE o.id=$1::uuid AND o.shop_id=$3 AND d.oa_id=$2 FOR UPDATE OF o FOR SHARE OF r,initial_rev,adopted,p,d,a,se',
   [input.order_id,oa,shop]);
  if(result.rows.length!==1||!result.rows[0])return rejected('CUSTOMER_PRINT_CHOICE_SOURCE_NOT_ADOPTED',403);
  return result.rows[0];
 }

 async function apply(inputValue:unknown):Promise<{
  status:'appended'|'existing';order_id:string;revision:number;request_hash:string;
  requires_reconfirmation:true;fields:readonly CustomerPrintChoiceField[];
 }>{
  const input=validInput(inputValue),fingerprint=sha(canonical({order_id:input.order_id,event_ids:input.event_ids}));
  return store.tx(async db=>{
   const locked=await db.query<{id:string;shop_id:string;active_revision:number}>(
    'SELECT id::text AS id,shop_id,active_revision FROM core_orders WHERE id=$1::uuid AND shop_id=$2 FOR UPDATE',
    [input.order_id,shop]);
   const order=locked.rows[0];
   if(!order)return rejected('CUSTOMER_PRINT_CHOICE_ORDER_SCOPE',403);
   const replay=await db.query<BatchRow>(
    'SELECT shop_id,oa_id,customer_id,conversation_id,event_fingerprint,idempotency_key,'+
    'expected_revision,expected_request_hash,expected_source_sha256,revision,request_hash,source_sha256,'+
    'source_event_id,fields FROM core_order_customer_print_choice_batches WHERE order_id=$1::uuid AND '+
    '(event_fingerprint=$2 OR idempotency_key=$3) FOR UPDATE',[input.order_id,fingerprint,input.idempotency_key]);
   if(replay.rows.length){
    const old=replay.rows[0];
    if(replay.rows.length!==1||!old||old.shop_id!==shop||old.oa_id!==oa||
       old.event_fingerprint!==fingerprint||old.expected_revision!==input.expected_revision||
       old.expected_request_hash!==input.expected_request_hash||
       old.expected_source_sha256!==input.expected_source_sha256)
     return rejected('CUSTOMER_PRINT_CHOICE_IDEMPOTENCY_CONFLICT');
    return {status:'existing',order_id:input.order_id,revision:old.revision,
     request_hash:old.request_hash,requires_reconfirmation:true,fields:old.fields as CustomerPrintChoiceField[]};
   }
   if(order.active_revision!==input.expected_revision)
    return rejected('CUSTOMER_PRINT_CHOICE_STALE_REVISION');
   const current=await currentSource(db,input);
   if(current.active_revision!==input.expected_revision||current.request_hash!==input.expected_request_hash||
      !digest.test(current.request_hash)||!digest.test(current.source_sha256)||
      current.source_sha256!==input.expected_source_sha256||
      sha(canonical(current.request_data))!==current.request_hash)
    return rejected('CUSTOMER_PRINT_CHOICE_STALE_BINDING');
   if(current.manual_lock||current.print_closed)return rejected('CUSTOMER_PRINT_CHOICE_ORDER_CLOSED');
   const approved=await db.query('SELECT 1 FROM core_approvals WHERE order_id=$1::uuid LIMIT 1',[input.order_id]);
   const jobs=await db.query('SELECT 1 FROM core_print_jobs WHERE order_id=$1::uuid LIMIT 1',[input.order_id]);
   if(approved.rows.length||jobs.rows.length)return rejected('CUSTOMER_PRINT_CHOICE_ORDER_FINALIZED');

   const firstData=current.first_request_data as {event_ids?:unknown};
   if(!Array.isArray(firstData?.event_ids)||firstData.event_ids.some(id=>typeof id!=='string'))
    return rejected('CUSTOMER_PRINT_CHOICE_SOURCE_PROVENANCE');
   const initialIds=firstData.event_ids as string[];
   const adoptedData=current.adopted_request_data;
   const adoptedDocuments=isRecord(adoptedData)&&Array.isArray(adoptedData.documents)?adoptedData.documents:null;
   const currentData=current.request_data;
   const documents=isRecord(currentData)&&Array.isArray(currentData.documents)?currentData.documents:null;
   const sourcePayload=isRecord(current.source_payload)?current.source_payload:null;
   if(current.source_customer!==current.customer_id||current.source_conversation!==current.conversation_id||
      current.artifact_customer!==current.customer_id||current.artifact_conversation!==current.conversation_id||
      !['file','image'].includes(current.source_kind)||
      sourcePayload?.customer_id!==current.customer_id||sourcePayload?.conversation_id!==current.conversation_id||
      current.proposal_fingerprint!==sha(canonical({conversation_id:current.conversation_id,event_ids:[...initialIds].sort()}))||
      !digest.test(current.manifest_sha256)||!bounded(current.artifact_ref,512)||
      sourceRef.exec(current.artifact_ref)?.[1]!==current.source_sha256||
      !adoptedDocuments||adoptedDocuments.length!==1||
      !isRecord(adoptedDocuments[0])||adoptedDocuments[0].artifact_name!==current.artifact_ref||
      !documents||documents.length!==1||!isRecord(documents[0])||documents[0].artifact_name!==current.artifact_ref||
      !initialIds.includes(current.source_event_id))
    return rejected('CUSTOMER_PRINT_CHOICE_SOURCE_PROVENANCE');
   const adoptionHash=sha(canonical({request_data:adoptedData,customer_id:current.customer_id,
    conversation_id:current.conversation_id,sha256:current.source_sha256}));
   if(current.source_settings_sha256!==adoptionHash)
    return rejected('CUSTOMER_PRINT_CHOICE_ADOPTION_TAMPERED');
   const sourceBinding:SealedSourceBinding={shop_id:shop,oa_id:oa,event_id:current.source_event_id,
    order_id:input.order_id,revision:input.expected_revision,request_hash:current.request_hash,
    source_sha256:current.source_sha256,artifact_ref:current.artifact_ref};
   let sourceVerified=false;
   try {sourceVerified=await verify_sealed_source(Object.freeze(sourceBinding))===true;}
   catch {sourceVerified=false;}
   if(!sourceVerified)return rejected('CUSTOMER_PRINT_CHOICE_SOURCE_UNVERIFIED');

   const oldEvidence=await db.query<ChoiceRow>(
    'SELECT field,value,origin,event_id,event_revision,parser_version,shop_id,oa_id,customer_id,'+
    'conversation_id,request_hash,source_sha256,source_event_id FROM core_order_customer_print_choice_evidence '+
    'WHERE order_id=$1::uuid AND revision=$2 ORDER BY field FOR SHARE',
    [input.order_id,input.expected_revision]);
   validateCurrentEvidence(oldEvidence.rows,current.request_data,{shop,oa,customer:current.customer_id,
    conversation:current.conversation_id,order:input.order_id,revision:input.expected_revision,
    requestHash:current.request_hash,sourceHash:current.source_sha256,sourceEvent:current.source_event_id});
   const incoming=await db.query<EventRow>(
    "SELECT event_id,customer_id,conversation_id,payload_json->>'kind' AS kind,"+
    "COALESCE(payload_json->>'text',payload_json->>'message_text') AS persisted_text,received_at "+
    'FROM zalo_inbound_events WHERE oa_id=$1 AND event_id=ANY($2::text[]) FOR SHARE',[oa,input.event_ids]);
   if(incoming.rows.length!==input.event_ids.length||incoming.rows.some(event=>
      event.customer_id!==current.customer_id||event.conversation_id!==current.conversation_id||
      event.kind!=='text'||!event.persisted_text||new Date(event.received_at).getTime()<=new Date(current.source_completed_at).getTime()||
      initialIds.includes(event.event_id)||event.event_id===current.source_event_id))
    return rejected('CUSTOMER_PRINT_CHOICE_EVENT_SCOPE',403);
   const used=await db.query('SELECT 1 FROM core_order_inbound_reviews WHERE oa_id=$1 AND event_id=ANY($2::text[]) LIMIT 1',
    [oa,input.event_ids]);
   if(used.rows.length)return rejected('CUSTOMER_PRINT_CHOICE_EVENT_ALREADY_USED');

   const parsed=new Map<CustomerPrintChoiceField,{value:CustomerPrintChoiceValue;event_id:string}>();
   for(const event of incoming.rows){
    const reading=parsePrintSetting(event.persisted_text??'');
    if(reading.kind!=='recognized')return rejected('CUSTOMER_PRINT_CHOICE_NEEDS_REVIEW');
    const field=fieldOf(reading.change),value=valueOf(reading.change);
    if(parsed.has(field))return rejected('CUSTOMER_PRINT_CHOICE_CONTRADICTORY');
    parsed.set(field,{value,event_id:event.event_id});
   }
   if(parsed.size!==input.event_ids.length||parsed.size===0)
    return rejected('CUSTOMER_PRINT_CHOICE_NEEDS_REVIEW');

   // Evidence is valid only for the revision it was captured against. A new
   // capture creates a new set; older field values remain historical evidence
   // on the old revision and are never silently copied forward.
   const nextChoices=new Map<CustomerPrintChoiceField,CustomerPrintChoiceValueRecord>();
   for(const [field,entry] of parsed)
    nextChoices.set(field,{value:entry.value,origin:'customer',event_id:entry.event_id,
     parser_version:PRINT_SETTING_PARSER_VERSION});
   const nextFields:Record<string,CustomerPrintChoiceValueRecord>={};
   for(const field of fields){const choice=nextChoices.get(field);if(choice)nextFields[field]=choice;}
   const nextData={...(currentData as Record<string,unknown>),customer_print_choices:{
    schema_version:CUSTOMER_PRINT_CHOICES_SCHEMA,fields:nextFields}};
   const nextHash=sha(canonical(nextData)),nextRevision=input.expected_revision+1;
   if(!Number.isSafeInteger(nextRevision))return rejected('CUSTOMER_PRINT_CHOICE_REVISION_OVERFLOW');
   await db.query('INSERT INTO core_revisions(order_id,revision,request_hash,request_data,plan) VALUES($1,$2,$3,$4::jsonb,NULL)',
    [input.order_id,nextRevision,nextHash,JSON.stringify(nextData)]);
   await db.query('UPDATE core_orders SET active_revision=$2,updated_at=now() WHERE id=$1::uuid',
    [input.order_id,nextRevision]);
   const eventRevisionById=new Map(oldEvidence.rows.map(row=>[row.event_id,row.event_revision]));
   for(const event of incoming.rows)eventRevisionById.set(event.event_id,nextRevision);
   await db.query(
    'INSERT INTO core_order_customer_print_choice_batches(order_id,shop_id,oa_id,customer_id,conversation_id,'+
    'event_fingerprint,idempotency_key,expected_revision,expected_request_hash,expected_source_sha256,'+
    'revision,request_hash,source_sha256,source_event_id,fields) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)',
    [input.order_id,shop,oa,current.customer_id,current.conversation_id,fingerprint,input.idempotency_key,
     input.expected_revision,input.expected_request_hash,input.expected_source_sha256,nextRevision,nextHash,
     current.source_sha256,current.source_event_id,[...parsed.keys()].sort()]);
   for(const event of incoming.rows)await db.query(
    'INSERT INTO core_order_inbound_reviews(shop_id,oa_id,event_id,order_id,revision,reviewed_by) VALUES($1,$2,$3,$4,$5,$6)',
    [shop,oa,event.event_id,input.order_id,nextRevision,processor.id]);
   for(const [field,choice] of nextChoices){
    const eventRevision=eventRevisionById.get(choice.event_id);
    if(!eventRevision)return rejected('CUSTOMER_PRINT_CHOICE_EVIDENCE_TAMPERED');
    await db.query(
     'INSERT INTO core_order_customer_print_choice_evidence(shop_id,oa_id,customer_id,conversation_id,'+
     'order_id,revision,source_event_id,source_sha256,request_hash,field,value,origin,event_id,event_revision,parser_version) '+
     'VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,\'customer\',$12,$13,$14)',
     [shop,oa,current.customer_id,current.conversation_id,input.order_id,nextRevision,current.source_event_id,
      current.source_sha256,nextHash,field,JSON.stringify(choice.value),choice.event_id,eventRevision,
      choice.parser_version]);
   }
   await db.query('INSERT INTO core_audit(id,shop_id,actor_id,action,order_id,details) VALUES($1,$2,$3,$4,$5,$6::jsonb)',
    [newId(),shop,processor.id,'order.customer_print_choices_appended',input.order_id,
     JSON.stringify({revision:nextRevision,fields:[...parsed.keys()].sort(),event_count:incoming.rows.length})]);
   return {status:'appended',order_id:input.order_id,revision:nextRevision,request_hash:nextHash,
    requires_reconfirmation:true as const,fields:[...parsed.keys()].sort()};
  });
 }
 return Object.freeze({apply});
}
