import { dbSafeInteger, DomainError } from './model.js';
import type { SqlConnection } from '../storage/database.js';

export interface PendingUpdateItem {
 kind:'file'|'message';label:string;summary:string;received_at:string|null;
}
export type PendingUpdatesStatus='clear'|'processing'|'needs_human';
export interface PendingUpdatesReadModel {
 order_id:string;revision:number;request_hash:string;status:PendingUpdatesStatus;
 unresolved_count:number;items:PendingUpdateItem[];
}
export interface PendingUpdatesScope {
 order_id:string;shop_id:string;customer_id:string;conversation_id:string|null;
 revision:number;request_hash:string;verified_plan_ready:boolean;
 created_at:Date|string;
}
type RelationRow={proposals:string|null;events:string|null;reviews:string|null;revisions:string|null;approvals:string|null};
type BindingRow={shop_id:string;oa_id:string;customer_id:string;conversation_id:string};
type WindowRow={previous_approved_at:Date|null;approved_at:Date|null;open_count:string|number};
type CountRow={n:string|number};
type PendingRow={kind:string|null;received_at:Date|string|null;total:string|number};

/** Only safe metadata, NEVER inbound text, file name, URI, path, event ID or customer metadata. */
export function safePendingItem(row:{kind:string|null;received_at:Date|string|null}):PendingUpdateItem {
 const file=row.kind==='file'||row.kind==='image';
 let received_at:string|null=null;
 if(row.received_at!==null){
  const date=row.received_at instanceof Date?row.received_at:new Date(row.received_at);
  if(Number.isFinite(date.getTime()))received_at=date.toISOString();
 }
 return {kind:file?'file':'message',
  label:file?'Tệp tin cần đối soát':'Tin nhắn cần đối soát',
  summary:'Chưa được xác minh trong phiên bản đơn hiện hành',
  received_at};
}
export function emptyPending(scope:PendingUpdatesScope,status:PendingUpdatesStatus='needs_human'):PendingUpdatesReadModel {
 return {order_id:scope.order_id,revision:scope.revision,request_hash:scope.request_hash,
  status,unresolved_count:0,items:[]};
}
/** Read-only within caller's Core transaction, after the authoritative order FOR UPDATE lock.
 * Never authorizes approval. Staff approval must independently run the durable inbound gate.
 */
export async function readPendingUpdates(db:SqlConnection,scope:PendingUpdatesScope):Promise<PendingUpdatesReadModel>{
 const unknown=()=>emptyPending(scope);
 if(!scope.conversation_id)return unknown();
 try{
  const t=(await db.query<RelationRow>(
   "SELECT to_regclass('public.core_ai_draft_proposals')::text AS proposals,"+
   "to_regclass('public.zalo_inbound_events')::text AS events,"+
   "to_regclass('public.core_order_inbound_reviews')::text AS reviews,"+
   "to_regclass('public.core_revisions')::text AS revisions,"+
   "to_regclass('public.core_approvals')::text AS approvals")).rows[0];
  if(!t?.proposals||!t.events||!t.reviews||!t.revisions||!t.approvals)return unknown();
  const bindings=await db.query<BindingRow>(
   'SELECT shop_id,oa_id,customer_id,conversation_id FROM core_ai_draft_proposals WHERE order_id=$1',
   [scope.order_id]);
  const binding=bindings.rows[0];
  if(bindings.rows.length!==1||!binding||binding.shop_id!==scope.shop_id||
     binding.customer_id!==scope.customer_id||binding.conversation_id!==scope.conversation_id)
   return unknown();
  // Every valid recorded revision must preserve the first event set. A broken JSON
  // history or a proposal with a foreign OA can never produce a false clear.
  const history=await db.query<{initial_ids:unknown;current_ids:unknown;revision:number;request_hash:string}>(
   'SELECT initial.request_data->\'event_ids\' AS initial_ids,'+
   ' current.request_data->\'event_ids\' AS current_ids,current.revision,current.request_hash '+
   'FROM core_revisions initial JOIN core_revisions current ON current.order_id=initial.order_id '+
   'WHERE initial.order_id=$1 AND initial.revision=1 AND current.revision=$2',[scope.order_id,scope.revision]);
  const rev=history.rows[0];
  if(!rev||history.rows.length!==1||rev.revision!==scope.revision||rev.request_hash!==scope.request_hash||
     !Array.isArray(rev.initial_ids)||!Array.isArray(rev.current_ids)||
     rev.initial_ids.some(x=>typeof x!=='string')||rev.current_ids.some(x=>typeof x!=='string')||
     rev.initial_ids.some(x=>!rev.current_ids.includes(x)))
   return unknown();
  // Distinguish two unapproved orders in one chat (including manual staff drafts).
  // The server verifies tenant/customer/conversation, never the browser's selected order.
  const boundary=await db.query<WindowRow>(
   'SELECT '+
   '(SELECT MAX(a.created_at) FROM core_approvals a JOIN core_orders old ON old.id=a.order_id '+
   'WHERE old.shop_id=$2 AND old.customer_id=$3 AND old.conversation_id=$4 AND old.id<>$1 '+
   'AND a.created_at <=$5::timestamptz) AS previous_approved_at,'+
   '(SELECT MIN(a.created_at) FROM core_approvals a WHERE a.order_id=$1) AS approved_at,'+
   '(SELECT COUNT(*)::int FROM core_orders o WHERE o.shop_id=$2 AND o.customer_id=$3 '+
   'AND o.conversation_id=$4 AND o.manual_lock=false AND o.print_closed=false '+
   'AND NOT EXISTS(SELECT 1 FROM core_approvals a WHERE a.order_id=o.id)) AS open_count',
   [scope.order_id,scope.shop_id,scope.customer_id,scope.conversation_id,scope.created_at]);
  const window=boundary.rows[0];if(!window)return unknown();
  const openCount=dbSafeInteger(window.open_count,'pending.open_count');
  if(openCount>1)return unknown();
  if(window.approved_at===null&&openCount!==1)return unknown();
  // If an event in the current revision predates the previous order's approval,
  // its belonging is ambiguous (a delayed old event). Never silently CLEAR.
  if(window.previous_approved_at!==null){
   const old=await db.query<CountRow>(
    "SELECT count(*)::int AS n FROM zalo_inbound_events e "+
    "WHERE e.oa_id=$1 AND e.customer_id=$2 AND e.conversation_id=$3 "+
    "AND e.event_id=ANY($4::text[]) AND e.received_at<=$5::timestamptz",
    [binding.oa_id,binding.customer_id,binding.conversation_id,rev.current_ids,window.previous_approved_at]);
   if(!old.rows[0]||dbSafeInteger(old.rows[0].n,'pending.old_events')>0)return unknown();
  }
  // Current revision must contain every inbound event it claims was reviewed.
  // Review evidence must match shop/OA/order, be <= active revision and include the
  // event in BOTH its reviewed revision and the current history. Batch DONE is irrelevant.
  const pending=await db.query<PendingRow>(
   "WITH unresolved AS ("+
   "SELECT e.event_id,e.received_at,e.payload_json->>'kind' AS kind "+
   "FROM zalo_inbound_events e "+
   "JOIN core_revisions initial ON initial.order_id=$1 AND initial.revision=1 "+
   "JOIN core_revisions cur ON cur.order_id=$1 AND cur.revision=$2 AND cur.request_hash=$3 "+
   "WHERE e.oa_id=$4 AND e.customer_id=$5 AND e.conversation_id=$6 "+
   "AND e.payload_json->>'kind' IN ('text','image','file') "+
   "AND ($7::timestamptz IS NULL OR e.received_at>$7::timestamptz) "+
   "AND ($8::timestamptz IS NULL OR e.received_at<=$8::timestamptz) "+
   "AND NOT (COALESCE((cur.request_data->'event_ids') ? e.event_id,false) AND "+
   " (COALESCE((initial.request_data->'event_ids') ? e.event_id,false) OR "+
   " EXISTS(SELECT 1 FROM core_order_inbound_reviews j JOIN core_revisions jr "+
   " ON jr.order_id=j.order_id AND jr.revision=j.revision "+
   " WHERE j.shop_id=$9 AND j.oa_id=e.oa_id AND j.order_id=$1 AND j.event_id=e.event_id "+
   " AND j.revision<=$2 AND COALESCE((jr.request_data->'event_ids') ? e.event_id,false))))"+
   ") SELECT kind,received_at,count(*) OVER()::int AS total FROM unresolved "+
   "ORDER BY received_at,event_id LIMIT 12",
   [scope.order_id,scope.revision,scope.request_hash,binding.oa_id,binding.customer_id,
    binding.conversation_id,window.previous_approved_at,window.approved_at,scope.shop_id]);
  const count=pending.rows.length?dbSafeInteger(pending.rows[0]!.total,'pending.unresolved'):0;
  if(count>0){
   if(pending.rows.some(x=>x.received_at===null||!Number.isFinite(new Date(x.received_at).getTime())))
    return unknown();
   return {...emptyPending(scope,'processing'),unresolved_count:count,
    items:pending.rows.map(safePendingItem)};
  }
  return emptyPending(scope,scope.verified_plan_ready?'clear':'processing');
 }catch(error){
  // A failed PostgreSQL transaction cannot safely continue. Never return CLEAR
  // or silently swallow a broken query; the API wrapper responds with 503.
  if(error instanceof DomainError)throw error;
  throw new DomainError('PENDING_READ_UNAVAILABLE','Không thể xác minh tin/file chờ đối soát',503);
 }
}
