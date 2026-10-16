import {
  formatBoundFirstPageQuestion,SAFE_FIRST_PAGE_QUESTION,
  type FirstPageQuestionScope,type FirstPageQuestionSnapshot
} from './first-page-question.ts';
import type {GateSnapshot} from './gate.ts';

/** Advisory-only, serializable immutable values prepared from an AI0-trusted
 * shop-scoped snapshot. NOT an authorization token or customer confirmation.
 * Never construct this from HTTP/OA fields or from an earlier preview alone.
 */
export interface FirstPageSuggestionEvidence {
  readonly shop_id:string;
  readonly order_id:string;
  readonly revision:number;
  readonly oa_id:string;
  readonly customer_id:string;
  readonly conversation_id:string;
  readonly request_hash:string;
  readonly source_sha256:string;
  readonly generation:number;
}
export interface FirstPageSuggestedDeliveryIntent {
  readonly kind:'tn005.first_page.suggested.v1';
  readonly evidence:Readonly<FirstPageSuggestionEvidence>;
  readonly text:string;
}
export type FirstPageDeliveryPreparation =
  | {readonly status:'suggested';readonly intent:FirstPageSuggestedDeliveryIntent}
  | {readonly status:'generic';readonly text:typeof SAFE_FIRST_PAGE_QUESTION}
  | {readonly status:'blocked';readonly text:typeof SAFE_FIRST_PAGE_QUESTION};
export type FirstPageDeliveryCheck =
  | {readonly status:'current';readonly text:string}
  | {readonly status:'generic_rebind_required';readonly text:typeof SAFE_FIRST_PAGE_QUESTION}
  | {readonly status:'blocked';readonly text:typeof SAFE_FIRST_PAGE_QUESTION};

/** This check is pure. Actual compare-and-enqueue must happen INSIDE AI0's
 * outbox transaction with locked Core order, current sealed source and AI1
 * conversation control. A generic fallback is only prose, NOT a write permit.
 */
export function prepareFirstPageSuggestedIntent(
  scope:Readonly<FirstPageQuestionScope>,
  snapshot:FirstPageQuestionSnapshot|null|undefined,
  gate:GateSnapshot|null|undefined,
):FirstPageDeliveryPreparation {
  if(!scope||!gate||gate.mode!=='AI'||
     gate.conversation_id!==scope.conversation_id||
     !Number.isSafeInteger(gate.generation)||gate.generation<0)
    return {status:'blocked',text:SAFE_FIRST_PAGE_QUESTION};
  const formatted=formatBoundFirstPageQuestion(scope,snapshot);
  if(!formatted.used_suggestion || !snapshot?.current)
    return {status:'generic',text:SAFE_FIRST_PAGE_QUESTION};
  const current=snapshot.current;
  const evidence=Object.freeze({
    shop_id:scope.shop_id,order_id:scope.order_id,revision:scope.revision,
    oa_id:scope.oa_id,customer_id:scope.customer_id,
    conversation_id:scope.conversation_id,
    request_hash:current.request_hash,source_sha256:current.source_sha256,
    generation:gate.generation,
  });
  return {status:'suggested',intent:Object.freeze({
    kind:'tn005.first_page.suggested.v1' as const,
    evidence,text:formatted.text,
  })};
}
const record=(value:unknown):value is Record<string,unknown>=>
  value!==null&&typeof value==='object'&&!Array.isArray(value);
const exactKeys=(value:Record<string,unknown>,keys:readonly string[])=>
  Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const evidenceKeys=['shop_id','order_id','revision','oa_id','customer_id',
  'conversation_id','request_hash','source_sha256','generation'] as const;
const sha=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);

/** AI0 MUST invoke for BOTH:
 * 1) 'before_enqueue': in the SAME transaction/CAS that inserts the outbox row;
 * 2) 'before_delivery': on fresh committed state after outbound reservation,
 *    immediately before any provider I/O. Cancel a stale reserved outbound,
 *    never rewrite/retry it using a previously generated suggested text.
 *
 * AI0 is responsible for verifying sealed bytes/manifest and supplying a fresh
 * authoritative Core+conversation state, not reading evidence from metadata.
 * This pure result cannot itself claim an atomic database or provider boundary.
 */
export function checkFirstPageSuggestedIntent(
  intent:unknown,
  scope:Readonly<FirstPageQuestionScope>,
  latest:FirstPageQuestionSnapshot|null|undefined,
  gate:GateSnapshot|null|undefined,
  stage:'before_enqueue'|'before_delivery',
):FirstPageDeliveryCheck {
  const blocked=():FirstPageDeliveryCheck=>
    ({status:'blocked',text:SAFE_FIRST_PAGE_QUESTION});
  const rebind=():FirstPageDeliveryCheck=>
    ({status:'generic_rebind_required',text:SAFE_FIRST_PAGE_QUESTION});
  if(stage!=='before_enqueue'&&stage!=='before_delivery')return blocked();
  if(!scope||!gate||gate.mode!=='AI'||
     gate.conversation_id!==scope.conversation_id||
     !Number.isSafeInteger(gate.generation)||gate.generation<0)return blocked();
  if(!record(intent)||!exactKeys(intent,['kind','evidence','text'])||
     intent.kind!=='tn005.first_page.suggested.v1'||
     !record(intent.evidence)||!exactKeys(intent.evidence,evidenceKeys))
    return blocked();
  const expected=intent.evidence;
  if(typeof intent.text!=='string'||
     expected.shop_id!==scope.shop_id||expected.order_id!==scope.order_id||
     expected.oa_id!==scope.oa_id||expected.customer_id!==scope.customer_id||
     expected.conversation_id!==scope.conversation_id||
     !Number.isSafeInteger(expected.revision)||Number(expected.revision)<1||
     !sha(expected.request_hash)||!sha(expected.source_sha256)||
     !Number.isSafeInteger(expected.generation)||Number(expected.generation)<0)
    return blocked(); // untrusted/cross-identity/altered proof, never authorize
  if(expected.generation!==gate.generation)return blocked(); // handover and return
  if(expected.revision!==scope.revision)return rebind(); // revised order
  const fresh=formatBoundFirstPageQuestion(scope,latest);
  if(!fresh.used_suggestion||fresh.text!==intent.text||!latest?.current||
     latest.current.request_hash!==expected.request_hash||
     latest.current.source_sha256!==expected.source_sha256)
    return rebind();
  return {status:'current',text:fresh.text};
}
