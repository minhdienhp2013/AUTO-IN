import type { SqlPool } from '../storage/database.js';

/**
 * AI0 CODE-007: READ-ONLY preflight for a possible customer confirmation.
 * Even a correctly signed, persisted "OK" is NEVER consent to a particular
 * revision or price. AI1 must authenticate the customer and repeat all checks
 * atomically under its write lock before recording any confirmation.
 *
 * NEVER use this result as a customer Principal or a print approval.
 */
export type ConfirmationCandidateInput = Readonly<{
  order_id:string;event_id:string;expected_revision:number;
  expected_request_hash:string;expected_generation:number;
  kind:'request'|'quote';quote_revision?:number;
}>;
type Reason='INVALID_REFERENCE'|'SOURCE_NOT_BOUND'|'EVENT_NOT_TEXT'|
  'ORDER_LOCKED'|'GENERATION_CHANGED'|'HUMAN_TAKEOVER'|
  'STALE_REVISION'|'PLAN_NOT_VERIFIED'|'QUOTE_CHANGED';
export type CandidateVerdict =
  {status:'blocked';reason:Reason} |
  {status:'candidate_requires_credential';order_id:string;revision:number;
   request_hash:string;kind:'request'|'quote';quote_revision:number|null;
   customer_credential_verified:false};
interface Scope {kind:'synthetic_fixture';shop_id:string;oa_id:string}
interface Row {
  customer_id:string;conversation_id:string;
  event_customer_id:string;event_conversation_id:string;raw_event:unknown;
  active_revision:number;request_hash:string;plan:unknown;
  manual_lock:boolean;print_closed:boolean;generation:string;
  control_status:'AI'|'HUMAN';quote_revision:number|null;
}
const uuidPattern=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const shaPattern=/^[a-f0-9]{64}$/;
const required=(v:unknown,max:number):v is string=>
  typeof v==='string' && v.length>0 && v.length<=max;
const blocked=(reason:Reason):CandidateVerdict=>({status:'blocked',reason});

/** Trusted shop/OA come ONLY from server configuration, never webhook input. */
export async function preflightSyntheticConfirmationCandidate(
  db:SqlPool,scope:Scope,candidate:ConfirmationCandidateInput
):Promise<CandidateVerdict>{
  if(scope?.kind!=='synthetic_fixture'||!required(scope.shop_id,128)||
     !required(scope.oa_id,128))throw Error('TRUSTED_SYNTHETIC_SCOPE_REQUIRED');
  if(!uuidPattern.test(candidate.order_id??'') ||
     !required(candidate.event_id,256) ||
     !Number.isSafeInteger(candidate.expected_revision)||candidate.expected_revision<1||
     !shaPattern.test(candidate.expected_request_hash??'')||
     !Number.isSafeInteger(candidate.expected_generation)||candidate.expected_generation<0||
     (candidate.kind!=='request'&&candidate.kind!=='quote')||
     (candidate.kind==='quote'&&
       (!Number.isSafeInteger(candidate.quote_revision)||(candidate.quote_revision??0)<1))||
     (candidate.kind==='request'&&candidate.quote_revision!==undefined))
    return blocked('INVALID_REFERENCE');

  // One coherent read-only snapshot for informative preflight. AI1 MUST repeat
  // every identity/generation/revision/price check in the write transaction.
  const sql=[
    'SELECT o.customer_id,o.conversation_id,ev.customer_id AS event_customer_id,',
    'ev.conversation_id AS event_conversation_id,ev.payload_json AS raw_event,',
    'o.active_revision,r.request_hash,r.plan,o.manual_lock,o.print_closed,',
    'c.generation::text AS generation,c.status AS control_status,q.quote_revision',
    'FROM core_orders o',
    "JOIN core_shop_settings ss ON ss.shop_id=o.shop_id AND ss.mode='simulation'",
    'JOIN core_revisions r ON r.order_id=o.id AND r.revision=o.active_revision',
    'JOIN core_conversation_controls c ON c.shop_id=o.shop_id AND c.conversation_id=o.conversation_id',
    'JOIN zalo_inbound_events ev ON ev.oa_id=$2 AND ev.event_id=$4',
    'LEFT JOIN LATERAL (SELECT quote_revision FROM core_quotes',
    'WHERE order_id=o.id ORDER BY quote_revision DESC LIMIT 1) q ON true',
    'WHERE o.shop_id=$1 AND o.id=$3'
  ].join(' ');
  const {rows}=await db.query<Row>(sql,
    [scope.shop_id,scope.oa_id,candidate.order_id,candidate.event_id]);
  const row=rows[0];
  if(!row||!row.customer_id||!row.conversation_id||
     row.event_customer_id!==row.customer_id||
     row.event_conversation_id!==row.conversation_id)
    return blocked('SOURCE_NOT_BOUND');
  const event=row.raw_event;
  if(!event||typeof event!=='object'||Array.isArray(event))
    return blocked('EVENT_NOT_TEXT');
  const e=event as Record<string,unknown>;
  if(e.kind!=='text'||e.event_id!==candidate.event_id||
     e.oa_id!==scope.oa_id||e.customer_id!==row.customer_id||
     e.conversation_id!==row.conversation_id||!required(e.text,4000))
    return blocked('EVENT_NOT_TEXT');
  if(row.manual_lock||row.print_closed)return blocked('ORDER_LOCKED');
  if(row.control_status!=='AI')return blocked('HUMAN_TAKEOVER');
  if(Number(row.generation)!==candidate.expected_generation)
    return blocked('GENERATION_CHANGED');
  if(row.active_revision!==candidate.expected_revision||
     row.request_hash!==candidate.expected_request_hash)
    return blocked('STALE_REVISION');
  const plan=row.plan;
  if(!plan||typeof plan!=='object'||Array.isArray(plan)||
     (plan as Record<string,unknown>).ready!==true||
     (plan as Record<string,unknown>).request_hash!==row.request_hash)
    return blocked('PLAN_NOT_VERIFIED');
  if(candidate.kind==='quote' &&
     (row.quote_revision===null||row.quote_revision!==candidate.quote_revision))
    return blocked('QUOTE_CHANGED');
  // Never imply customer identity, possession of challenge, consent, or approval.
  return {status:'candidate_requires_credential',
    order_id:candidate.order_id,revision:row.active_revision,
    request_hash:row.request_hash,kind:candidate.kind,
    quote_revision:candidate.kind==='quote'?row.quote_revision:null,
    customer_credential_verified:false};
}
