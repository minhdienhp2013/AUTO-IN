import {createHash} from "node:crypto";
import type {
  PilotCodeSubmission,PilotReadiness,PilotSourceFormat,PilotWordPdfCandidate
} from "../../contracts/pilot-word-pdf.ts";
import type {InboundEvent} from "../integrations/zalo/protocol.ts";
import {extractPilotPrintIntent,type PilotPrintIntent} from "./pilot-print-intent.ts";

const MAX_SOURCE_BYTES=25*1024*1024;
const codeOnlyReasons=new Set(["MISSING_CODE","INVALID_CODE_FORMAT","CONFLICTING_CODE"]);
const sourceRef=/^doc-[A-Za-z0-9_-]{6,64}\/source-000-([a-f0-9]{64})\.(pdf|docx)$/;
const sha=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
const settingsSha=(settings:{copies:number;duplex:boolean;paper:"A4";color:"black_white"})=>
  sha(Buffer.from(JSON.stringify({color:settings.color,copies:settings.copies,
    duplex:settings.duplex,paper:settings.paper}),"utf8"));
const isRecord=(value:unknown):value is Record<string,unknown>=>
  !!value&&typeof value==="object"&&!Array.isArray(value);

export interface PilotVerifiedMedia {
  readonly oa_id:string;
  readonly customer_id:string;
  readonly conversation_id:string;
  readonly provider_event_id:string;
  readonly bytes:Uint8Array;
}
/**
 * Reads media only by a durable event key. Implementations must resolve the
 * provider's private media handle server-side and must never accept a URL or
 * path from the OA payload or caller.
 */
export interface PilotVerifiedMediaPort {
  read_verified(input:{readonly oa_id:string;readonly provider_event_id:string}):Promise<PilotVerifiedMedia|null>;
}

export interface SealedPilotSource {
  readonly schema:"ai0.pilot_sealed_source.v1";
  readonly oa_id:string;
  readonly customer_id:string;
  readonly conversation_id:string;
  readonly provider_event_id:string;
  readonly format:PilotSourceFormat;
  readonly artifact_ref:string;
  readonly sha256:string;
  readonly size_bytes:number;
}
/**
 * Server-only immutable source custody. `seal` must be idempotent and refuse
 * replacing bytes for an existing OA/event. `read_sealed` must read from the
 * same private registry used by Core's TrustedWord/PdfReviewSourceReader.
 */
export interface PilotSourceCustodyPort {
  seal(input:{readonly oa_id:string;readonly customer_id:string;readonly conversation_id:string;
    readonly provider_event_id:string;readonly format:PilotSourceFormat;readonly bytes:Uint8Array;
    readonly sha256:string;readonly size_bytes:number}):Promise<SealedPilotSource>;
  read_sealed(input:{readonly oa_id:string;readonly provider_event_id:string;
    readonly artifact_ref:string}):Promise<Uint8Array|null>;
}

export interface PilotCandidateBindingPort {
  /**
   * Resolve the existing server-owned order/revision and return a candidate
   * only if request_data/settings and Core's private source registry already
   * name this exact sealed source. This is an AI1/AI0 composition boundary,
   * never a client-supplied order or revision.
   */
  bind(input:{readonly shop_id:string;readonly oa_id:string;readonly customer_id:string;
    readonly conversation_id:string;readonly text_event_ids:readonly string[];
    readonly source:SealedPilotSource;
    readonly settings:{readonly copies:number;readonly duplex:boolean;readonly paper:"A4";
      readonly color:"black_white"}}):Promise<PilotWordPdfCandidate|null>;
}

export interface PilotCorePort {
  registerPilotCandidate(candidate:PilotWordPdfCandidate):Promise<PilotCoreResult>;
  authorizePilotPrint(submission:PilotCodeSubmission):Promise<PilotCoreResult>;
}
export interface PilotCoreResult {readonly status:PilotReadiness;readonly reason?:string}

export interface PilotWordPdfIntakePorts {
  /** Re-read persisted verified events, preserving server receipt order. */
  read_verified_events(input:{readonly oa_id:string;readonly event_ids:readonly string[]}):Promise<readonly InboundEvent[]>;
  readonly media:PilotVerifiedMediaPort;
  readonly custody:PilotSourceCustodyPort;
  readonly candidate_binding:PilotCandidateBindingPort;
  readonly core:PilotCorePort;
}
export interface PilotIntakeRequest {
  readonly event_ids:readonly string[];
  /** Omitted while a customer has sent only code/settings text and no file yet. */
  readonly source_event_id?:string;
}
export interface PilotIntakeResult {
  readonly status:PilotReadiness;
  readonly reason?:string;
  readonly candidate_registered:boolean;
  readonly authorization_attempted:boolean;
}

function mediaFormat(bytes:Uint8Array):PilotSourceFormat|null {
  if(bytes.byteLength>=5&&bytes[0]===0x25&&bytes[1]===0x50&&bytes[2]===0x44&&
     bytes[3]===0x46&&bytes[4]===0x2d)return "PDF";
  // OOXML DOCX is a ZIP package. AI3/Core still validate the package structure
  // and document contents; filename/MIME never establish this format.
  if(bytes.byteLength>=4&&bytes[0]===0x50&&bytes[1]===0x4b&&bytes[2]===0x03&&bytes[3]===0x04)
    return "DOCX";
  return null;
}

function sameSettings(candidate:PilotWordPdfCandidate,
  expected:{copies:number;duplex:boolean;paper:"A4";color:"black_white"}):boolean {
  return candidate.settings.copies===expected.copies&&candidate.settings.duplex===expected.duplex&&
    candidate.settings.paper===expected.paper&&candidate.settings.color===expected.color&&
    candidate.settings_sha256===settingsSha(expected);
}

function validSource(source:SealedPilotSource,expected:{oa_id:string;customer_id:string;
  conversation_id:string;provider_event_id:string;format:PilotSourceFormat;sha256:string;
  size_bytes:number}):boolean {
  const match=source&&source.schema==="ai0.pilot_sealed_source.v1"&&
    source.oa_id===expected.oa_id&&source.customer_id===expected.customer_id&&
    source.conversation_id===expected.conversation_id&&source.provider_event_id===expected.provider_event_id&&
    source.format===expected.format&&source.sha256===expected.sha256&&source.size_bytes===expected.size_bytes;
  const ref=sourceRef.exec(source?.artifact_ref??"");
  return !!match&&!!ref&&ref[1]===expected.sha256&&
    ((source.format==="PDF"&&ref[2]==="pdf")||(source.format==="DOCX"&&ref[2]==="docx"));
}

function eligibleSettings(intent:PilotPrintIntent):boolean {
  return intent.copies!==null&&intent.paper==="A4"&&intent.sides!==null&&intent.black_white&&
    intent.reasons.every(reason=>codeOnlyReasons.has(reason));
}

function safeInput(request:unknown):PilotIntakeRequest {
  const keys=isRecord(request)?Object.keys(request).sort().join(","):"";
  if(!isRecord(request)||!(["event_ids","event_ids,source_event_id"].includes(keys))||
    !Array.isArray(request.event_ids)||request.event_ids.length<1||request.event_ids.length>100||
    request.event_ids.some(id=>typeof id!=="string"||!id||id.length>256||id!==id.trim())||
    new Set(request.event_ids).size!==request.event_ids.length||
    (request.source_event_id!==undefined&&
      (typeof request.source_event_id!=="string"||!request.source_event_id||request.source_event_id.length>256||
       request.source_event_id!==request.source_event_id.trim()||!request.event_ids.includes(request.source_event_id))))
    throw new Error("INVALID_PILOT_INTAKE_REQUEST");
  return request as unknown as PilotIntakeRequest;
}

function safeCandidate(candidate:unknown,expected:{shop_id:string;oa_id:string;customer_id:string;
  conversation_id:string;source:SealedPilotSource;settings:{copies:number;duplex:boolean;paper:"A4";
    color:"black_white"}}):candidate is PilotWordPdfCandidate {
  if(!isRecord(candidate)||candidate.shop_id!==expected.shop_id||candidate.oa_id!==expected.oa_id||
    candidate.customer_id!==expected.customer_id||candidate.conversation_id!==expected.conversation_id||
    typeof candidate.order_id!=="string"||!candidate.order_id||candidate.order_id.length>128||
    !Number.isSafeInteger(candidate.revision)||Number(candidate.revision)<1||
    typeof candidate.request_hash!=="string"||!/^[0-9a-f]{64}$/.test(candidate.request_hash)||
    typeof candidate.printer_id!=="string"||!candidate.printer_id||candidate.printer_id.length>128||
    !isRecord(candidate.source)||candidate.source.format!==expected.source.format||
    candidate.source.artifact_ref!==expected.source.artifact_ref||candidate.source.sha256!==expected.source.sha256||
    candidate.source.size_bytes!==expected.source.size_bytes||
    candidate.source.provider_event_id!==expected.source.provider_event_id||
    !isRecord(candidate.settings)||!sameSettings(candidate as unknown as PilotWordPdfCandidate,expected.settings))return false;
  return true;
}

/**
 * AI2's internal adapter for a batch of persisted, already-verified OA events.
 * It never verifies raw webhooks, reads caller media URLs, exposes the code,
 * or creates Core authority itself. AI0's synthetic composition may supply
 * its fixture verifier and server-only Ports here.
 */
export function createPilotWordPdfIntakeAdapter(options:{readonly trusted_shop_id:string;
  readonly trusted_oa_id:string;readonly ports:PilotWordPdfIntakePorts}) {
  const {trusted_shop_id:shopId,trusted_oa_id:oaId,ports}=options;
  if(!shopId||shopId.length>128||!oaId||oaId.length>256||!ports||
    typeof ports.read_verified_events!=="function"||!ports.media||!ports.custody||
    !ports.candidate_binding||!ports.core)
    throw new Error("PILOT_INTAKE_PORTS_REQUIRED");

  return {
    async processVerifiedEvents(input:unknown):Promise<PilotIntakeResult>{
      const request=safeInput(input);
      const events=await ports.read_verified_events({oa_id:oaId,event_ids:request.event_ids});
      if(!Array.isArray(events)||events.length!==request.event_ids.length||
        events.some((event,index)=>!event||event.event_id!==request.event_ids[index]||event.oa_id!==oaId||
          !event.customer_id||!event.conversation_id)||
        new Set(events.map(event=>event.event_id)).size!==events.length)
        return {status:"NEEDS_HUMAN",reason:"VERIFIED_EVENTS_UNAVAILABLE",candidate_registered:false,authorization_attempted:false};
      const first=events[0]!;
      if(events.some(event=>event.customer_id!==first.customer_id||event.conversation_id!==first.conversation_id))
        return {status:"NEEDS_HUMAN",reason:"EVENT_SCOPE_MISMATCH",candidate_registered:false,authorization_attempted:false};
      const fileEvents=events.filter(event=>event.kind==="file");
      const unsupportedEvents=events.filter(event=>event.kind!=="file"&&event.kind!=="text");
      if(unsupportedEvents.length>0||fileEvents.length>1)
        return {status:"NEEDS_HUMAN",reason:"MULTIPLE_OR_UNSUPPORTED_INPUT_EVENTS",
          candidate_registered:false,authorization_attempted:false};
      if(fileEvents.length===0)
        return {status:"WAITING_FOR_FILE",reason:"SOURCE_FILE_EVENT_REQUIRED",
          candidate_registered:false,authorization_attempted:false};
      const sourceEvent=fileEvents[0];
      if(!sourceEvent||sourceEvent.event_id!==request.source_event_id)
        return {status:"NEEDS_HUMAN",reason:"SOURCE_EVENT_NOT_VERIFIED_FILE",candidate_registered:false,authorization_attempted:false};
      // Seal the original immediately once the event-keyed media Port provides
      // bytes. TN-004 requires file intake even when code/settings arrive later.
      // This Port must resolve an already verified event key; it never receives
      // an OA/customer-supplied URL or path.
      const media=await ports.media.read_verified({oa_id:oaId,provider_event_id:sourceEvent.event_id});
      if(!media||media.oa_id!==oaId||media.customer_id!==first.customer_id||
        media.conversation_id!==first.conversation_id||media.provider_event_id!==sourceEvent.event_id||
        !(media.bytes instanceof Uint8Array)||media.bytes.byteLength<1||media.bytes.byteLength>MAX_SOURCE_BYTES)
        return {status:"NEEDS_HUMAN",reason:"VERIFIED_MEDIA_UNAVAILABLE",candidate_registered:false,authorization_attempted:false};
      // Snapshot once so format/size/hash/custody all refer to identical bytes.
      const originalBytes=new Uint8Array(media.bytes);
      const format=mediaFormat(originalBytes);
      if(!format)return {status:"NEEDS_HUMAN",reason:"UNSUPPORTED_SOURCE_BYTES",candidate_registered:false,authorization_attempted:false};
      const digest=sha(originalBytes);
      let source:SealedPilotSource;
      try{
        source=await ports.custody.seal({oa_id:oaId,customer_id:first.customer_id,
          conversation_id:first.conversation_id,provider_event_id:sourceEvent.event_id,
          format,bytes:new Uint8Array(originalBytes),sha256:digest,size_bytes:originalBytes.byteLength});
      }catch{
        return {status:"NEEDS_HUMAN",reason:"SOURCE_CUSTODY_FAILED",candidate_registered:false,authorization_attempted:false};
      }
      if(!validSource(source,{oa_id:oaId,customer_id:first.customer_id,
        conversation_id:first.conversation_id,provider_event_id:sourceEvent.event_id,
        format,sha256:digest,size_bytes:originalBytes.byteLength}))
        return {status:"NEEDS_HUMAN",reason:"SOURCE_CUSTODY_UNVERIFIED",candidate_registered:false,authorization_attempted:false};
      const readback=await ports.custody.read_sealed({oa_id:oaId,
        provider_event_id:sourceEvent.event_id,artifact_ref:source.artifact_ref}).catch(()=>null);
      if(!(readback instanceof Uint8Array)||readback.byteLength!==originalBytes.byteLength||sha(readback)!==digest)
        return {status:"NEEDS_HUMAN",reason:"SOURCE_CUSTODY_READBACK_MISMATCH",candidate_registered:false,authorization_attempted:false};
      const intent=extractPilotPrintIntent(events);
      if(!intent||!eligibleSettings(intent))
        return {status:"WAITING_FOR_SETTINGS",reason:"PRINT_SETTINGS_INCOMPLETE_OR_UNSUPPORTED",
          candidate_registered:false,authorization_attempted:false};
      const settings={copies:intent.copies!,duplex:intent.sides===2,paper:"A4" as const,color:"black_white" as const};
      let candidate:PilotWordPdfCandidate|null;
      try{
        candidate=await ports.candidate_binding.bind({shop_id:shopId,oa_id:oaId,
          customer_id:first.customer_id,conversation_id:first.conversation_id,
          text_event_ids:intent.event_ids,source,settings});
      }catch{
        return {status:"NEEDS_HUMAN",reason:"CORE_CANDIDATE_BINDING_UNAVAILABLE",candidate_registered:false,authorization_attempted:false};
      }
      if(!candidate)return {status:"WAITING_FOR_FILE",reason:"CORE_SOURCE_ORDER_BINDING_REQUIRED",
        candidate_registered:false,authorization_attempted:false};
      if(!safeCandidate(candidate,{shop_id:shopId,oa_id:oaId,customer_id:first.customer_id,
        conversation_id:first.conversation_id,source,settings}))
        return {status:"NEEDS_HUMAN",reason:"CORE_CANDIDATE_BINDING_MISMATCH",candidate_registered:false,authorization_attempted:false};
      let registration:PilotCoreResult;
      try{registration=await ports.core.registerPilotCandidate(candidate);}
      catch{
        return {status:"NEEDS_HUMAN",reason:"CORE_CANDIDATE_REGISTRATION_UNAVAILABLE",candidate_registered:false,authorization_attempted:false};
      }
      if(!registration||typeof registration.status!=="string")
        return {status:"NEEDS_HUMAN",reason:"CORE_CANDIDATE_REGISTRATION_INVALID",candidate_registered:false,authorization_attempted:false};
      if(registration.status!=="WAITING_FOR_CODE"||!intent.code_candidate||!intent.code_event_id)
        return {status:registration.status,...(typeof registration.reason==="string"?{reason:registration.reason}:{}),
          candidate_registered:true,authorization_attempted:false};

      const submission:PilotCodeSubmission={schema:"ai0.pilot_code_submission.v1",shop_id:shopId,oa_id:oaId,
        customer_id:candidate.customer_id,conversation_id:candidate.conversation_id,
        intake_batch_id:candidate.intake_batch_id,
        order_id:candidate.order_id,revision:candidate.revision,provider_event_id:intent.code_event_id,
        code:intent.code_candidate,idempotency_key:"ai2-pilot:"+sha(Buffer.from(JSON.stringify([
          shopId,oaId,candidate.order_id,candidate.revision,intent.code_event_id]),"utf8"))};
      try{
        const authorization=await ports.core.authorizePilotPrint(submission);
        if(!authorization||typeof authorization.status!=="string")
          return {status:"NEEDS_HUMAN",reason:"CORE_AUTHORIZATION_INVALID",candidate_registered:true,authorization_attempted:true};
        return {status:authorization.status,...(typeof authorization.reason==="string"?{reason:authorization.reason}:{}),
          candidate_registered:true,authorization_attempted:true};
      }catch{
        return {status:"NEEDS_HUMAN",reason:"CORE_AUTHORIZATION_UNAVAILABLE",candidate_registered:true,authorization_attempted:true};
      }
    }
  };
}
