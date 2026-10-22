import {createHash} from "node:crypto";
import type {ApplyIncomingBatchInput,ApplyIncomingBatchResult} from "../core/incoming-batch-port.ts";
import type {IncomingQueueBatchInput,IncomingQueueBatchSnapshot} from "../core/oa-intake-batches.ts";
import type {LeasedBatch} from "../integrations/zalo/postgres-durable.ts";
import type {InboundEvent} from "../integrations/zalo/protocol.ts";
import {extractPilotPrintIntent} from "./pilot-print-intent.ts";
import {classifyIncomingOrderBatch} from "./order-batch-intent.ts";
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
  /** The server composition must use Core's IncomingBatchPort configured with
   * a private-custody IncomingSealedSourceReader. AI2 never supplies source data. */
  apply_incoming_batch(input:ApplyIncomingBatchInput):Promise<ApplyIncomingBatchResult>;
}
export type CorePilotIntakeCalls=Pick<CorePilotIntakePort,
  "acceptIncomingQueueBatch"|"apply_incoming_batch">;
export type CorePilotIntakeIntegration=CorePilotIntakeCalls&{
  readonly trusted_shop_id:string;readonly trusted_oa_id:string;
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
  if(/(?:số\s*bản\s*[:：-]?\s*\d{1,3}|\d{1,3}\s*bản|\bA[345]\b|(?:1|2|một|hai)\s*mặt|đen\s*trắng|trắng\s*đen|\bb\s*\/\s*w\b|\bmàu\b)/iu.test(event.text))return true;
  const parsed=extractPilotPrintIntent([event]);
  if(!parsed)return false;
  return parsed.copies!==null||parsed.paper!==null||parsed.sides!==null||parsed.black_white||
    parsed.reasons.some(reason=>reason==="CONFLICTING_COPIES"||reason==="CONFLICTING_SIDES"||
      reason==="UNSUPPORTED_PRINT_OPTION");
}
export function isCorePilotIntakeBatch(batch:Batch):boolean {
  if(batch.events.some(event=>event.kind==="file"))return true;
  return batch.events.some(event=>labelledCode(event)||hasSettingsEvidence(event));
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
      if(incoming.reason==="CONFLICTING_INTENTS")return "held";
      const selection:NonNullable<IncomingQueueBatchInput["selection"]>={
        ...(currentCodeId?{code_event_id:currentCodeId}:{}),
        ...(sourceEventId?{source_event_id:sourceEventId}:{}),
        ...(settingsEventIds.length?{settings_event_ids:settingsEventIds}: {})
      };
      const acceptInput:IncomingQueueBatchInput={
        queue_batch_id:lease.batch_id,lease_token:lease.lease_token,purpose:"PILOT",
        event_ids:ids,
        ...(incoming.intent==="explicit_separate"?{boundary:"NEW" as const}:{boundary:"CONTINUE" as const}),
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
      if(snapshot.readiness!=="READY")return "processed";
      const settingsBindings=snapshot.events.filter(event=>event.role==="SETTINGS");
      const sourceBindings=snapshot.events.filter(event=>event.role==="SOURCE");
      if(settingsBindings.length<1||settingsBindings.some(event=>event.kind!=="text")||
         sourceBindings.length!==1||sourceBindings[0]?.kind!=="file")return "held";
      const settingsIds=settingsBindings.map(event=>event.event_id);
      let settingsEvents:readonly InboundEvent[];
      try { settingsEvents=await core.read_settings_events({
          intake_batch_id:snapshot.intake_batch_id,queue_batch_id:lease.batch_id,
          lease_token:lease.lease_token,oa_id:snapshot.oa_id,customer_id:snapshot.customer_id,
          conversation_id:snapshot.conversation_id,event_ids:settingsIds
        });
      } catch(error) {
        if(permanentCoreErrors.has(errorCode(error)??""))return "held";
        throw error;
      }
      if(!Array.isArray(settingsEvents)||settingsEvents.length!==settingsIds.length||
         new Set(settingsEvents.map(event=>event.event_id)).size!==settingsEvents.length||
         settingsEvents.some(event=>!settingsIds.includes(event.event_id)||event.oa_id!==oa||
           event.customer_id!==snapshot.customer_id||event.conversation_id!==snapshot.conversation_id||
           event.kind!=="text"||typeof event.text!=="string"))return "held";
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
