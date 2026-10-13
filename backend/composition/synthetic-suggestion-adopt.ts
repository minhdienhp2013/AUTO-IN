import {createHash} from 'node:crypto';
import {assertStaff,DomainError,canonical} from '../core/model.js';
import type {Principal} from '../core/model.js';
import type {SqlPool} from '../storage/database.js';
import type {OrderService} from '../core/service.js';
import {prepareSyntheticInboundDraft} from './inbound-draft.js';
import type {SyntheticArtifactScope} from './synthetic-ingest.js';

type ProposalRow={order_id:string;customer_id:string;conversation_id:string;
 active_revision:number;manual_lock:boolean;print_closed:boolean;request_data:unknown};
const reject=(code:string):never=>{throw new DomainError(code,
  'Staff must reconcile the original AI2 suggestion',409)};
const uuid=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
/**
 * Simulation-only bridge AI2 suggestion -> exactly ONE existing AI1 order.
 *
 * The staff, not AI2 nor a customer file_ref, chooses paper/copies. The source
 * must have been signed-ingressed and frozen by AI0. A durable reservation is
 * written BEFORE calling AI1.revise; a crash/ACK loss leaves PENDING, which is
 * deliberately fail-closed and must be reconciled by an owner. No auto-retry
 * and no createDraft/new order are possible here.
 */
export async function adoptSyntheticSuggestedSource(
  pool:SqlPool, service:Pick<OrderService,'revise'>,root:string,
  scope:SyntheticArtifactScope,actor:Principal,
  input:{order_id:string;event_id:string;paper:'A4'|'A3';copies:number;duplex:boolean}
):Promise<{status:'adopted';order_id:string;revision:number;
  requires_customer_confirmation:true;preview_trusted:false}>{
  assertStaff(actor);
  if(actor.shop_id!==scope.shop_id||!uuid.test(input?.order_id??''))
    return reject('SOURCE_ADOPTION_SCOPE_DENIED');
  const {source,request_data,settingsHash}=await prepareSyntheticInboundDraft(
    pool,root,scope,{event_id:input.event_id,paper:input.paper,
      copies:input.copies,duplex:input.duplex});
  // Identity from immutable server-owned AI2 proposal, NOT from a webhook body.
  const result=await pool.query<ProposalRow>(
    "SELECT p.order_id::text,o.customer_id,o.conversation_id,o.active_revision,"+
    "o.manual_lock,o.print_closed,r.request_data "+
    "FROM core_ai_draft_proposals p "+
    "JOIN core_orders o ON o.id=p.order_id AND o.shop_id=p.shop_id "+
    "JOIN core_revisions r ON r.order_id=o.id AND r.revision=1 "+
    "JOIN core_shop_settings s ON s.shop_id=o.shop_id AND s.mode='simulation' "+
    "WHERE p.shop_id=$1 AND p.oa_id=$2 AND p.order_id=$3::uuid "+
    "AND p.customer_id=$4 AND p.conversation_id=$5",
    [scope.shop_id,scope.oa_id,input.order_id,source.customer_id,source.conversation_id]);
  const linked=result.rows[0];
  const snapshot=linked?.request_data as {source?:unknown;event_ids?:unknown;
    conversation_id?:unknown}|undefined;
  if(!linked||linked.active_revision!==1||linked.manual_lock||linked.print_closed||
     snapshot?.source!=='zalo_ai_suggestion'||
     snapshot.conversation_id!==source.conversation_id||
     !Array.isArray(snapshot.event_ids)||snapshot.event_ids.length!==1||
     snapshot.event_ids[0]!==input.event_id)
    return reject('SOURCE_ADOPTION_PROVENANCE_MISMATCH');
  const reserved=await pool.query(
    "INSERT INTO ai0_inbound_artifact_drafts "+
    "(shop_id,oa_id,event_id,actor_id,settings_sha256) "+
    "VALUES($1,$2,$3,$4,$5) "+
    "ON CONFLICT (shop_id,oa_id,event_id) DO NOTHING RETURNING event_id",
    [scope.shop_id,scope.oa_id,input.event_id,actor.id,settingsHash]);
  if(reserved.rowCount!==1)
    return reject('SOURCE_ADOPTION_PENDING_OR_ALREADY_LINKED');
  const key='adopt:'+sha([scope.shop_id,scope.oa_id,input.event_id,
    input.order_id,settingsHash].join(':'));
  // AI1 alone enforces active-revision CAS, unsent jobs and normal staff audit.
  // If the HTTP/DB ACK is lost, the reservation remains PENDING; do NOT try
  // this again or silently create another order.
  const revised=await service.revise(actor,input.order_id,{
    expected_revision:1,request_data,idempotency_key:key});
  if(revised.revision!==2)return reject('SOURCE_ADOPTION_REVISION_UNEXPECTED');
  const finalized=await pool.query(
    "UPDATE ai0_inbound_artifact_drafts "+
    "SET status='CREATED',order_id=$4,completed_at=now() "+
    "WHERE shop_id=$1 AND oa_id=$2 AND event_id=$3 "+
    "AND status='PENDING' AND order_id IS NULL RETURNING order_id",
    [scope.shop_id,scope.oa_id,input.event_id,input.order_id]);
  if(finalized.rowCount!==1)
    return reject('SOURCE_ADOPTION_NEEDS_RECONCILIATION');
  return {status:'adopted',order_id:input.order_id,revision:2,
    requires_customer_confirmation:true,preview_trusted:false};
}
