import {
  checkFirstPageSuggestedIntent,
  type FirstPageSuggestedDeliveryIntent
} from './first-page-delivery-intent.ts';
import {
  SAFE_FIRST_PAGE_QUESTION,
  type FirstPageQuestionScope,
  type FirstPageQuestionSnapshot
} from './first-page-question.ts';
import type {GateSnapshot} from './gate.ts';

/** TN005 AI2 <-> AI1/AI0 contract ONLY.
 *
 * NOT IMPLEMENTED on PR129: AI1 must own a shop-scoped Core CAS and AI0 must
 * bind the trusted sealed-source read, transactional outbox and dispatcher.
 * These methods are not equivalent to an ordinary gate.read() + enqueue().
 * In particular, NO fallback to PostgresOutboundRepository.enqueue() is safe.
 */
export interface FirstPageCoreCasPort {
  /** MUST check shop/order/current revision/request hash/verified sealed SHA,
   * OA/customer/conversation, and AI1 mode=AI/generation INSIDE the SAME
   * locked PostgreSQL transaction that inserts ONE idempotent outbox row.
   * A stale/tampered request must produce zero outbox rows or mutation.
   * The only successful reply is 'queued'; it attests transaction COMMITTED.
   */
  compare_and_enqueue_suggested(input:Readonly<{
    outbound_id:string;
    intent:FirstPageSuggestedDeliveryIntent;
  }>):Promise<FirstPageCoreEnqueueResult>;
  /** MUST use an authoritative fresh order/source/generation check for the
   * exact RESERVED, unmodified outbound_id/payload just before provider I/O.
   * Mark/cancel stale reservations by existing safe transitions; NEVER
   * resend UNKNOWN/SENT. 'current' is NOT proof provider delivery.
   */
  compare_reserved_before_provider_io(input:Readonly<{
    outbound_id:string;
    intent:FirstPageSuggestedDeliveryIntent;
  }>):Promise<FirstPageCoreDeliveryResult>;
}

export type FirstPageCoreStale =
  'stale_revision'|'stale_request_hash'|'stale_source_sha';
export type FirstPageCoreDenied =
  'handover'|'cross_shop'|'tampered'|'not_found'|'unavailable';
export type FirstPageCoreEnqueueResult =
  | {readonly status:'queued';readonly outbound_id:string}
  | {readonly status:FirstPageCoreStale|FirstPageCoreDenied};
export type FirstPageCoreDeliveryResult =
  | {readonly status:'current';readonly outbound_id:string}
  | {readonly status:FirstPageCoreStale|FirstPageCoreDenied};
export type FirstPageCasDecision =
  | {readonly status:'queued'|'ready';readonly outbound_id:string;readonly text:string}
  | {readonly status:'generic_rebind_required';readonly text:typeof SAFE_FIRST_PAGE_QUESTION}
  | {readonly status:'blocked';readonly text:typeof SAFE_FIRST_PAGE_QUESTION};

const blocked=():FirstPageCasDecision=>
  ({status:'blocked',text:SAFE_FIRST_PAGE_QUESTION});
const generic=():FirstPageCasDecision=>
  ({status:'generic_rebind_required',text:SAFE_FIRST_PAGE_QUESTION});
const stale=new Set<string>(['stale_revision','stale_request_hash','stale_source_sha']);
const denied=new Set<string>(['handover','cross_shop','tampered','not_found','unavailable']);
const outboundId=(value:unknown):value is string=>
  typeof value==='string'&&/^[A-Za-z0-9:_-]{1,128}$/.test(value);
const validCas=(value:unknown):value is {status:string;outbound_id?:unknown}=>{
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const status=(value as {status?:unknown}).status;
  return typeof status==='string'&&
    (stale.has(status)||denied.has(status)||status==='queued'||status==='current');
};

/** AI2 boundary checks are a PRECONDITION, never the CAS itself. 'current'
 * here is not an outbox authorization; only AI1's atomic port can queue.
 * The snapshot and gate MUST be supplied from trusted AI0/AI1 reads, never
 * JSON from a customer, OA webhook, or browser request body.
 */
async function runStage(
  stage:'before_enqueue'|'before_delivery',
  outbound_id:string,
  intent:FirstPageSuggestedDeliveryIntent,
  scope:Readonly<FirstPageQuestionScope>,
  fresh:FirstPageQuestionSnapshot|null|undefined,
  gate:GateSnapshot|null|undefined,
  core:FirstPageCoreCasPort|undefined,
):Promise<FirstPageCasDecision> {
  if(!outboundId(outbound_id))return blocked();
  const local=checkFirstPageSuggestedIntent(intent,scope,fresh,gate,stage);
  if(local.status==='blocked')return blocked();
  if(local.status==='generic_rebind_required')return generic();
  // Neither operation is permitted in the absence of AI1's atomic CAS.
  if(!core)return blocked();
  const method=stage==='before_enqueue' ?
    core.compare_and_enqueue_suggested : core.compare_reserved_before_provider_io;
  if(typeof method!=='function')return blocked();
  try{
    const result=await method.call(core,{outbound_id,intent});
    if(!validCas(result))return blocked();
    if(stale.has(result.status))return generic();
    if(denied.has(result.status))return blocked();
    const success=stage==='before_enqueue'?'queued':'current';
    if(result.status!==success||result.outbound_id!==outbound_id)return blocked();
    return {status:stage==='before_enqueue'?'queued':'ready',
      outbound_id,text:local.text};
  }catch{
    // Database/Port unavailable is never a reason to send a generic reply.
    // Do not log error messages: they may carry private source information.
    return blocked();
  }
}

/** Contract consumer for AI0's future atomic CAS-and-enqueue Port.
 * NEVER directly calls outbox.enqueue().
 */
export function gateFirstPageEnqueue(
  outbound_id:string,intent:FirstPageSuggestedDeliveryIntent,
  scope:Readonly<FirstPageQuestionScope>,fresh:FirstPageQuestionSnapshot|null|undefined,
  gate:GateSnapshot|null|undefined,core?:FirstPageCoreCasPort,
):Promise<FirstPageCasDecision>{
  return runStage('before_enqueue',outbound_id,intent,scope,fresh,gate,core);
}

/** Check a previously RESERVED exact outbound before provider I/O. This
 * method is data-only and never calls provider/send_text() on its own.
 * Caller MUST cancel a non-ready reservation; no silent stale->generic send.
 */
export function gateFirstPageDelivery(
  outbound_id:string,intent:FirstPageSuggestedDeliveryIntent,
  scope:Readonly<FirstPageQuestionScope>,fresh:FirstPageQuestionSnapshot|null|undefined,
  gate:GateSnapshot|null|undefined,core?:FirstPageCoreCasPort,
):Promise<FirstPageCasDecision>{
  return runStage('before_delivery',outbound_id,intent,scope,fresh,gate,core);
}
