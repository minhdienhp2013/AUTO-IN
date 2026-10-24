import {createHash} from "node:crypto";
import type {ApplyIncomingBatchInput,ApplyIncomingBatchResult} from "../core/incoming-batch-port.ts";
import type {IncomingQueueBatchInput,IncomingQueueBatchSnapshot,CloseIncomingQueueBatchInput} from "../core/oa-intake-batches.ts";
import type {LeasedBatch} from "../integrations/zalo/postgres-durable.ts";
import type {InboundEvent} from "../integrations/zalo/protocol.ts";
import type {PilotSourceCustodyPort,PilotVerifiedMediaPort,SealedPilotSource} from "./pilot-word-pdf-intake.ts";
import {extractPilotPrintIntent} from "./pilot-print-intent.ts";
import {classifyIncomingOrderBatch,classifyIncomingOrderBoundary} from "./order-batch-intent.ts";
import type {Batch} from "./batch.ts";

const permanentCoreErrors=new Set([
  "INCOMING_BATCH_CLOSED","INCOMING_BATCH_EXPIRED","INCOMING_BATCH_LEASE_LOST",
  "INCOMING_BATCH_MEMBERSHIP_INVALID","INCOMING_BATCH_ORDER_CONFLICT","INCOMING_BATCH_PURPOSE_CONFLICT",
  "INCOMING_BATCH_SCOPE_DENIED","INCOMING_BATCH_SCOPE_MISMATCH","INCOMING_BATCH_WINDOW_SPLIT",
  "INCOMING_EVENT_ALREADY_BOUND","INCOMING_EVENT_ORDER_INVALID","INCOMING_EVENT_ROLE_CONFLICT",
  "INCOMING_EVENT_ALREADY_USED","INCOMING_EVENT_MEMBERSHIP_DENIED","INCOMING_EVENT_SCOPE_DENIED",
  "INCOMING_REVISION_CHANGED","INCOMING_SOURCE_NOT_VERIFIED","INCOMING_PILOT_SOURCE_NOT_READY",
  "INCOMING_PILOT_SETTINGS_NOT_READY","INCOMING_SOURCE_SELECTOR_CONFLICT",
  "PILOT_SETTINGS_EVENTS_UNVERIFIED"
]);
const maxPilotSourceBytes=25*1024*1024;
const privateSourceRef=/^doc-[a-f0-9]{32}\/source-000-([a-f0-9]{64})\.(pdf|docx)$/;
const byteSha256=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");

function hasDocxDirectory(bytes:Uint8Array):boolean {
  const view=Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  const min=Math.max(0,view.length-22-0xffff);
  let end=-1;
  for(let offset=view.length-22;offset>=min;offset--){
    if(view.readUInt32LE(offset)===0x06054b50&&
       offset+22+view.readUInt16LE(offset+20)===view.length){end=offset;break;}
  }
  if(end<0||view.readUInt16LE(end+4)!==0||view.readUInt16LE(end+6)!==0||
     view.readUInt16LE(end+8)!==view.readUInt16LE(end+10))return false;
  const count=view.readUInt16LE(end+10),size=view.readUInt32LE(end+12),start=view.readUInt32LE(end+16);
  if(count<2||count>10_000||count===0xffff||size===0xffffffff||start===0xffffffff||
     start+size!==end)return false;
  let offset=start,contentTypes=0,documentXml=0;
  for(let index=0;index<count;index++){
    if(offset+46> end||view.readUInt32LE(offset)!==0x02014b50)return false;
    const flags=view.readUInt16LE(offset+8),nameLength=view.readUInt16LE(offset+28);
    const extraLength=view.readUInt16LE(offset+30),commentLength=view.readUInt16LE(offset+32);
    const localOffset=view.readUInt32LE(offset+42),recordEnd=offset+46+nameLength+extraLength+commentLength;
    if((flags&1)!==0||nameLength<1||recordEnd>end||localOffset+30>start||
       view.readUInt16LE(offset+34)!==0||view.readUInt32LE(localOffset)!==0x04034b50||
       view.readUInt16LE(localOffset+6)!==flags||view.readUInt16LE(localOffset+8)!==view.readUInt16LE(offset+10))return false;
    let name:string;
    try{name=new TextDecoder("utf-8",{fatal:true}).decode(view.subarray(offset+46,offset+46+nameLength));}
    catch{return false;}
    const localNameLength=view.readUInt16LE(localOffset+26),localExtraLength=view.readUInt16LE(localOffset+28);
    const localNameStart=localOffset+30,localNameEnd=localNameStart+localNameLength;
    if(localNameEnd+localExtraLength>start||localNameLength!==nameLength||
       !view.subarray(localNameStart,localNameEnd).equals(view.subarray(offset+46,offset+46+nameLength)))return false;
    if(name.startsWith("/")||name.includes("\\")||name.split("/").some(part=>part===".."||part==="."))return false;
    if(name==="[Content_Types].xml")contentTypes++;
    if(name==="word/document.xml")documentXml++;
    offset=recordEnd;
  }
  return offset===start+size&&contentTypes===1&&documentXml===1;
}

function sourceFormat(bytes:Uint8Array):"PDF"|"DOCX"|null {
  if(bytes.byteLength>=5&&bytes[0]===0x25&&bytes[1]===0x50&&bytes[2]===0x44&&
     bytes[3]===0x46&&bytes[4]===0x2d)return "PDF";
  // Require the OOXML content-type and document entries, not just a ZIP header.
  // Core/document processing must still validate the XML and document content.
  if(bytes.byteLength>=22&&bytes[0]===0x50&&bytes[1]===0x4b&&bytes[2]===0x03&&bytes[3]===0x04&&
     hasDocxDirectory(bytes))
    return "DOCX";
  return null;
}

export interface PilotPrivateSourceLookupPort {
  /** Server-only lookup by verified OA/event key; never accepts a caller path/ref. */
  find_sealed(input:{readonly oa_id:string;readonly provider_event_id:string}):Promise<SealedPilotSource|null>;
}
export interface PilotSourceCapturePort {
  /** Resolve existing private custody or seal bytes returned by a trusted media port. */
  ensure_sealed_source(input:{readonly oa_id:string;readonly customer_id:string;
    readonly conversation_id:string;readonly provider_event_id:string}):Promise<SealedPilotSource|null>;
}
export interface PilotSourceCaptureOptions {
  readonly media:PilotVerifiedMediaPort;
  readonly custody:PilotSourceCustodyPort;
  readonly lookup:PilotPrivateSourceLookupPort;
}

function validSealedSource(source:unknown,scope:{oa_id:string;customer_id:string;
  conversation_id:string;provider_event_id:string}):source is SealedPilotSource {
  if(!source||typeof source!=="object"||Array.isArray(source))return false;
  const value=source as Partial<SealedPilotSource>;
  if(value.schema!=="ai0.pilot_sealed_source.v1"||value.oa_id!==scope.oa_id||
     value.customer_id!==scope.customer_id||value.conversation_id!==scope.conversation_id||
     value.provider_event_id!==scope.provider_event_id||
     (value.format!=="PDF"&&value.format!=="DOCX")||
     typeof value.sha256!=="string"||!/^[a-f0-9]{64}$/.test(value.sha256)||
     !Number.isSafeInteger(value.size_bytes)||Number(value.size_bytes)<1||
     Number(value.size_bytes)>maxPilotSourceBytes||typeof value.artifact_ref!=="string")return false;
  const match=privateSourceRef.exec(value.artifact_ref);
  return !!match&&match[1]===value.sha256&&
    match[2]===(value.format==="PDF"?"pdf":"docx");
}

/**
 * Server-side capture bridge for the persistent Core batch adapter. It has no
 * HTTP/download implementation: media is resolved by OA + event ID through a
 * trusted injected port. Zalo URL/auth/expiry/redirect semantics remain a
 * separate provider blocker. A successful synthetic port is not live proof.
 */
export function createPilotSourceCaptureAdapter(options:PilotSourceCaptureOptions):PilotSourceCapturePort {
  if(!options?.media||typeof options.media.read_verified!=="function"||
     !options.custody||typeof options.custody.seal!=="function"||
     typeof options.custody.read_sealed!=="function"||
     !options.lookup||typeof options.lookup.find_sealed!=="function")
    throw new Error("PILOT_SOURCE_CAPTURE_PORTS_REQUIRED");
  return {async ensure_sealed_source(scope){
    if(!scope||!scope.oa_id||!scope.customer_id||!scope.conversation_id||
       !scope.provider_event_id)return null;
    const existing=await options.lookup.find_sealed({oa_id:scope.oa_id,
      provider_event_id:scope.provider_event_id});
    if(existing){
      if(!validSealedSource(existing,scope))return null;
      const priorBytes=await options.custody.read_sealed({oa_id:scope.oa_id,
        provider_event_id:scope.provider_event_id,artifact_ref:existing.artifact_ref});
      if(!(priorBytes instanceof Uint8Array)||priorBytes.byteLength!==existing.size_bytes||
         byteSha256(priorBytes)!==existing.sha256||sourceFormat(priorBytes)!==existing.format)return null;
      return existing;
    }
    const media=await options.media.read_verified({oa_id:scope.oa_id,
      provider_event_id:scope.provider_event_id});
    if(!media||media.oa_id!==scope.oa_id||media.customer_id!==scope.customer_id||
       media.conversation_id!==scope.conversation_id||
       media.provider_event_id!==scope.provider_event_id||
       !(media.bytes instanceof Uint8Array)||media.bytes.byteLength<1||
       media.bytes.byteLength>maxPilotSourceBytes)return null;
    const bytes=new Uint8Array(media.bytes);
    const format=sourceFormat(bytes);
    if(!format)return null;
    const sha256=byteSha256(bytes);
    const sealed=await options.custody.seal({oa_id:scope.oa_id,customer_id:scope.customer_id,
      conversation_id:scope.conversation_id,provider_event_id:scope.provider_event_id,
      format,bytes:new Uint8Array(bytes),sha256,size_bytes:bytes.byteLength});
    if(!validSealedSource(sealed,scope)||sealed.format!==format||
       sealed.sha256!==sha256||sealed.size_bytes!==bytes.byteLength)return null;
    const readback=await options.custody.read_sealed({oa_id:scope.oa_id,
      provider_event_id:scope.provider_event_id,artifact_ref:sealed.artifact_ref});
    if(!(readback instanceof Uint8Array)||readback.byteLength!==bytes.byteLength||
       byteSha256(readback)!==sha256||sourceFormat(readback)!==format)return null;
    return sealed;
  }};
}

export interface CorePilotSettingsReadInput {
  readonly intake_batch_id:string;
  readonly queue_batch_id:string;
  readonly lease_token:string;
  readonly oa_id:string;
  readonly customer_id:string;
  readonly conversation_id:string;
  /** IDs are copied only from Core's SETTINGS bindings in the accepted snapshot. */
  readonly event_ids:readonly string[];
}
export interface CorePilotSettingsEventReader {
  read_settings_events(input:CorePilotSettingsReadInput):Promise<readonly InboundEvent[]>;
}
export interface CorePilotIntakePort extends CorePilotSettingsEventReader {
  readonly trusted_shop_id:string;
  readonly trusted_oa_id:string;
  acceptIncomingQueueBatch(input:IncomingQueueBatchInput):Promise<IncomingQueueBatchSnapshot>;
  closeIncomingQueueBatch?(input:CloseIncomingQueueBatchInput):Promise<{status:string;intake_batch_id:string}>;
  /** The server composition must use Core's IncomingBatchPort configured with
   * a private-custody IncomingSealedSourceReader. AI2 never supplies source data. */
  apply_incoming_batch(input:ApplyIncomingBatchInput):Promise<ApplyIncomingBatchResult>;
  /** Optional until server composition has an approved, event-keyed media port.
   * Missing capture keeps a file lease held before Core can create an order. */
  readonly source_capture?:PilotSourceCapturePort;
}
export type CorePilotIntakeCalls=Pick<CorePilotIntakePort,
  "acceptIncomingQueueBatch"|"closeIncomingQueueBatch"|"apply_incoming_batch">;
export type CorePilotIntakeIntegration=CorePilotIntakeCalls&{
  readonly trusted_shop_id:string;readonly trusted_oa_id:string;
  readonly source_capture?:PilotSourceCapturePort;
};
export interface CorePilotIntakeOptions {
  readonly trusted_shop_id:string;
  readonly trusted_oa_id:string;
  readonly core:CorePilotIntakePort;
}
export interface CorePilotIntakeRunner {
  consume(batch:Batch,generation:number):Promise<"processed"|"held">;
}
function digest(value:unknown):string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function leaseIdentity(batch:Batch):batch is LeasedBatch {
  const value=batch as Batch&Partial<LeasedBatch>;
  return typeof value.batch_id==="string"&&/^\d{1,19}$/.test(value.batch_id)&&
    typeof value.lease_token==="string"&&value.lease_token.length>0&&
    Array.isArray(value.server_received_event_ids);
}
export function isLeasedCorePilotBatch(batch:Batch):batch is LeasedBatch {
  return leaseIdentity(batch);
}
function validLease(batch:LeasedBatch,trustedOa:string):string[]|null {
  const ids=batch.server_received_event_ids;
  if(!Array.isArray(ids)||ids.length<1||ids.length!==batch.events.length||
     ids.some(id=>typeof id!=="string"||!id||id.length>256)||new Set(ids).size!==ids.length||
     new Set(batch.events.map(event=>event.event_id)).size!==batch.events.length||
     ids.some(id=>!batch.events.some(event=>event.event_id===id))||
     batch.events.some(event=>event.oa_id!==trustedOa||!event.customer_id||!event.conversation_id))return null;
  const first=batch.events[0];
  if(!first||batch.events.some(event=>event.customer_id!==first.customer_id||
    event.conversation_id!==first.conversation_id))return null;
  return [...ids];
}
function labelledCode(event:InboundEvent):boolean {
  return event.kind==="text"&&typeof event.text==="string"&&
    /(?:^|[^\p{L}\p{N}])mã\s*(?:cửa\s*hàng|tạm)?\s*[:：-]/iu.test(event.text);
}
function hasSettingsEvidence(event:InboundEvent):boolean {
  if(event.kind!=="text"||typeof event.text!=="string")return false;
  if(/(?:số\s*bản\s*[:：-]?\s*\d{1,3}|\d{1,3}\s*bản|\bA[345]\b|(?:1|2|một|hai)\s*mặt|đen\s*trắng|trắng\s*đen|\bb\s*\/\s*w\b|(?:^|[^\p{L}\p{N}])màu(?=$|[^\p{L}\p{N}]))/iu.test(event.text))return true;
  const parsed=extractPilotPrintIntent([event]);
  if(!parsed)return false;
  return parsed.copies!==null||parsed.paper!==null||parsed.sides!==null||parsed.black_white||
    parsed.reasons.some(reason=>reason==="CONFLICTING_COPIES"||reason==="CONFLICTING_SIDES"||
      reason==="UNSUPPORTED_PRINT_OPTION");
}
export function isCorePilotIntakeBatch(batch:Batch):boolean {
  if(batch.events.some(event=>event.kind==="file"))return true;
  return batch.events.some(event=>labelledCode(event)||hasSettingsEvidence(event))||
    classifyIncomingOrderBoundary(batch)!=="CONTINUE";
}
function hardSettingsReasons(reasons:readonly string[]):boolean {
  return reasons.some(reason=>reason!=="MISSING_CODE"&&
    reason!=="MISSING_COPIES"&&reason!=="MISSING_PAPER"&&reason!=="MISSING_SIDES"&&
    reason!=="MISSING_BLACK_WHITE");
}
function isSettingsComplete(events:readonly InboundEvent[]):
  {kind:"complete";settings:{copies:number;duplex:boolean;paper:"A4";color:"black_white"}}|
  {kind:"waiting"}|{kind:"invalid"} {
  const parsed=extractPilotPrintIntent(events);
  if(!parsed)return {kind:"invalid"};
  if(hardSettingsReasons(parsed.reasons))return {kind:"invalid"};
  const copyValues=events.flatMap(event=>typeof event.text==="string"
    ?[...event.text.matchAll(/(?:số\s*bản\s*[:：-]?\s*(\d{1,3})|(?:in\s+)?(\d{1,3})\s*bản)(?=$|[^\p{L}\p{N}])/giu)]
      .map(match=>Number(match[1]??match[2])):[]);
  if(copyValues.some(value=>value<1||value>99))return {kind:"invalid"};
  if(parsed.copies===null||parsed.paper!=="A4"||parsed.sides===null||!parsed.black_white)
    return {kind:"waiting"};
  return {kind:"complete",settings:{copies:parsed.copies,duplex:parsed.sides===2,
    paper:"A4",color:"black_white"}};
}
function validSnapshot(value:IncomingQueueBatchSnapshot,batch:LeasedBatch,ids:string[],
  shop:string,oa:string):boolean {
  const first=batch.events[0];
  return !!first&&!!value&&typeof value==="object"&&Array.isArray(value.events)&&
    value.schema==="ai1.oa_intake_batch.v1"&&
    value.queue_batch_id===batch.batch_id&&value.shop_id===shop&&value.oa_id===oa&&
    value.customer_id===first.customer_id&&value.conversation_id===first.conversation_id&&
    value.purpose==="PILOT"&&typeof value.intake_batch_id==="string"&&
    ["WAITING_FOR_FILE","WAITING_FOR_SETTINGS","WAITING_FOR_CODE","READY"].includes(value.readiness)&&
    value.events.every(event=>event&&typeof event.event_id==="string"&&
      ["text","image","file"].includes(event.kind)&&
      ["CONTEXT","CODE","SOURCE","SETTINGS"].includes(event.role))&&
    new Set(value.events.map(event=>event.event_id)).size===value.events.length&&
    ids.every(id=>value.events.some(event=>event.event_id===id));
}
function expectedCodeEvents(events:readonly IncomingQueueBatchSnapshot["events"][number][]) {
  return events.filter(event=>event.role==="CODE");
}
function resultWasCommitted(result:ApplyIncomingBatchResult):boolean {
  if(result.status==="created"||result.status==="existing")
    return typeof result.order_id==="string"&&result.order_id.length>0&&
      Number.isSafeInteger(result.active_revision)&&result.active_revision>=1;
  if(result.status==="appended")
    return typeof result.order_id==="string"&&result.order_id.length>0&&
      Number.isSafeInteger(result.active_revision)&&result.active_revision>=1&&
      result.requires_reconfirmation===true;
  return false;
}
function errorCode(error:unknown):string|null {
  if(!error||typeof error!=="object")return null;
  const value=error as {code?:unknown;message?:unknown};
  if(typeof value.code==="string")return value.code;
  return typeof value.message==="string"&&/^[A-Z][A-Z0-9_]{1,63}$/.test(value.message)
    ?value.message:null;
}

/**
 * Bridges one claim_due lease to Core's durable intake lifecycle. It only uses
 * IDs and ordering returned with that lease, and re-reads SETTINGS events by
 * Core's immutable intake role. Media bytes, URL, path, artifact ref and hash
 * never cross this adapter boundary.
 */
export function createCorePilotIntakeAdapter(options:CorePilotIntakeOptions) {
  const shop=options.trusted_shop_id,oa=options.trusted_oa_id,core=options.core;
  if(!shop||shop.length>128||!oa||oa.length>256||!core||
     typeof core.acceptIncomingQueueBatch!=="function"||
     typeof core.apply_incoming_batch!=="function"||
     typeof core.read_settings_events!=="function")throw new Error("CORE_PILOT_INTAKE_PORTS_REQUIRED");

  return {
    async consume(batch:Batch,generation:number):Promise<"processed"|"held"> {
      if(!isCorePilotIntakeBatch(batch))return "processed";
      if(!isLeasedCorePilotBatch(batch)||!Number.isSafeInteger(generation)||generation<0)return "held";
      const lease=batch as LeasedBatch,ids=validLease(lease,oa),first=lease.events[0];
      if(!ids||!first)return "held";
      const ordered=ids.map(id=>lease.events.find(event=>event.event_id===id)!);
      const textEvents=ordered.filter(event=>event.kind==="text");
      const parsedCurrent=extractPilotPrintIntent(textEvents);
      if(textEvents.some(labelledCode)&&parsedCurrent?.reasons.includes("CONFLICTING_CODE"))return "held";
      if(textEvents.some(labelledCode)&&parsedCurrent?.reasons.includes("INVALID_CODE_FORMAT"))return "held";
      const currentCodeId=parsedCurrent?.code_event_id??undefined;
      const sourceEvents=ordered.filter(event=>event.kind==="file");
      const images=ordered.filter(event=>event.kind==="image");
      if(sourceEvents.length>1||images.length>0)return "held";
      const sourceEventId=sourceEvents[0]?.event_id;
      const settingsEventIds=textEvents.filter(event=>event.event_id!==currentCodeId&&
        !labelledCode(event)&&hasSettingsEvidence(event)).map(event=>event.event_id);
      const incoming=classifyIncomingOrderBatch({ ...lease,events:ordered });
      const boundary=classifyIncomingOrderBoundary({ ...lease,events:ordered });
      if(boundary==="AMBIGUOUS"||incoming.reason==="CONFLICTING_INTENTS"||
         incoming.reason==="AMBIGUOUS_ORDER_BOUNDARY")return "held";
      const selection:NonNullable<IncomingQueueBatchInput["selection"]>={
        ...(currentCodeId?{code_event_id:currentCodeId}:{}),
        ...(sourceEventId?{source_event_id:sourceEventId}:{}),
        ...(settingsEventIds.length?{settings_event_ids:settingsEventIds}: {})
      };
      const acceptInput:IncomingQueueBatchInput={
        queue_batch_id:lease.batch_id,lease_token:lease.lease_token,purpose:"PILOT",
        event_ids:ids,
        boundary:boundary==="NEW"?"NEW":"CONTINUE",
        selection
      };
      let snapshot:IncomingQueueBatchSnapshot;
      try { snapshot=await core.acceptIncomingQueueBatch(acceptInput); }
      catch(error) {
        if(permanentCoreErrors.has(errorCode(error)??""))return "held";
        throw error;
      }
      if(!validSnapshot(snapshot,lease,ids,shop,oa)||
         (snapshot.status!=="OPEN"&&snapshot.status!=="BOUND"))return "held";
      if(expectedCodeEvents(snapshot.events).length>1||
         snapshot.events.filter(event=>event.role==="SOURCE").length>1)return "held";
      const settingsBindings=snapshot.events.filter(event=>event.role==="SETTINGS");
      const sourceBindings=snapshot.events.filter(event=>event.role==="SOURCE");
      if(settingsBindings.some(event=>event.kind!=="text")||
         sourceBindings.some(event=>event.kind!=="file"))return "held";
      const closeForColor=async():Promise<"processed"|"held">=>{
        if(!core.closeIncomingQueueBatch)return "held";
        try{
          const closed=await core.closeIncomingQueueBatch({intake_batch_id:snapshot.intake_batch_id,
            queue_batch_id:lease.batch_id,lease_token:lease.lease_token,reason:"COLOR_PRINT"});
          return closed.status==="NEEDS_HUMAN"&&closed.intake_batch_id===snapshot.intake_batch_id
            ?"processed":"held";
        }catch{return "held";}
      };
      // A labelled code can share a text event with the customer's color choice.
      // Its event is CODE, not SETTINGS, so inspect the verified current lease too.
      if(parsedCurrent?.color_requested)return closeForColor();
      const settingsIds=settingsBindings.map(event=>event.event_id);
      let settingsEvents:readonly InboundEvent[]=[];
      if(settingsIds.length){
        try { settingsEvents=await core.read_settings_events({
            intake_batch_id:snapshot.intake_batch_id,queue_batch_id:lease.batch_id,
            lease_token:lease.lease_token,oa_id:snapshot.oa_id,customer_id:snapshot.customer_id,
            conversation_id:snapshot.conversation_id,event_ids:settingsIds
          });
        }catch(error){
          if(permanentCoreErrors.has(errorCode(error)??""))return "held";
          throw error;
        }
        if(!Array.isArray(settingsEvents)||settingsEvents.length!==settingsIds.length||
           new Set(settingsEvents.map(event=>event.event_id)).size!==settingsEvents.length||
           settingsEvents.some(event=>!settingsIds.includes(event.event_id)||event.oa_id!==oa||
             event.customer_id!==snapshot.customer_id||event.conversation_id!==snapshot.conversation_id||
             event.kind!=="text"||typeof event.text!=="string"))return "held";
        if(extractPilotPrintIntent(settingsEvents)?.color_requested)return closeForColor();
      }
      if(sourceBindings.length===1){
        const sourceEventId=sourceBindings[0]!.event_id;
        // SOURCE may have arrived in an earlier lease. Its only selector is
        // the persisted Core role returned for this intake, never a caller ID.
        if(!core.source_capture)return "held";
        try{
          const sealed=await core.source_capture.ensure_sealed_source({oa_id:snapshot.oa_id,
            customer_id:snapshot.customer_id,conversation_id:snapshot.conversation_id,
            provider_event_id:sourceEventId});
          if(!validSealedSource(sealed,{oa_id:snapshot.oa_id,customer_id:snapshot.customer_id,
            conversation_id:snapshot.conversation_id,provider_event_id:sourceEventId}))return "held";
        }catch{
          // Media transport and provider retry semantics are not verified. Keep
          // this durable lease held; never turn an unknown result into success.
          return "held";
        }
        // A waiting batch has no later apply call to re-check the current lease.
        // Re-accept the same server lease after I/O before completing it.
        if(snapshot.readiness!=="READY"){
          try{
            const checked=await core.acceptIncomingQueueBatch(acceptInput);
            const roleSignature=(value:IncomingQueueBatchSnapshot)=>JSON.stringify(
              value.events.map(event=>[event.event_id,event.kind,event.role]).sort((a,b)=>
                String(a[0]).localeCompare(String(b[0]))));
            if(!validSnapshot(checked,lease,ids,shop,oa)||
               checked.intake_batch_id!==snapshot.intake_batch_id||
               checked.readiness!==snapshot.readiness||
               roleSignature(checked)!==roleSignature(snapshot)||
               (checked.status!=="OPEN"&&checked.status!=="BOUND"))return "held";
          }catch(error){
            if(permanentCoreErrors.has(errorCode(error)??""))return "held";
            return "held";
          }
        }
      }
      if(snapshot.readiness==="WAITING_FOR_FILE"||snapshot.readiness==="WAITING_FOR_SETTINGS"||
         snapshot.readiness==="WAITING_FOR_CODE")return "processed";
      if(snapshot.readiness!=="READY")return "held";
      if(settingsBindings.length<1||settingsBindings.some(event=>event.kind!=="text")||
         sourceBindings.length!==1||sourceBindings[0]?.kind!=="file")return "held";
      const settings=isSettingsComplete(settingsEvents);
      if(settings.kind==="invalid")return "held";
      if(settings.kind==="waiting")return "processed";
      const request:ApplyIncomingBatchInput={
        scope:{oa_id:snapshot.oa_id,customer_id:snapshot.customer_id,
          conversation_id:snapshot.conversation_id},
        queue_batch_id:lease.batch_id,lease_token:lease.lease_token,
        intake_batch_id:snapshot.intake_batch_id,purpose:"PILOT",
        expected_generation:generation,event_ids:ids,
        // Core creates the revision exclusively from the sealed source and parsed settings.
        text:"[PILOT_SOURCE_AND_SETTINGS_BOUND]",
        idempotency_key:"zalo-pilot:"+digest([oa,snapshot.customer_id,snapshot.conversation_id,
          snapshot.intake_batch_id,ids]),
        intent:incoming.intent==="explicit_separate"?"explicit_separate":"append_or_create",
        changes:["attachment","copies","paper","duplex","print_request"],
        pilot_settings:settings.settings
      };
      let result:ApplyIncomingBatchResult;
      try { result=await core.apply_incoming_batch(request); }
      catch(error) {
        if(permanentCoreErrors.has(errorCode(error)??""))return "held";
        throw error;
      }
      return result&&typeof result==="object"&&resultWasCommitted(result)?"processed":"held";
    }
  };
}
