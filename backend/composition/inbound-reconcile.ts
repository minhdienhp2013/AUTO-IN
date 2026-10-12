import { assertOwner, canonical, idempotencyHash, DomainError, sha, type Principal } from '../core/model.js';
import type { SqlPool } from '../storage/database.js';
import type { SyntheticArtifactScope } from './synthetic-ingest.js';
import { prepareSyntheticInboundDraft } from './inbound-draft.js';

const conflict = (code: string, status = 409): never => {
  throw new DomainError(code,'Synthetic draft needs owner reconciliation',status);
};
type Reservation = {
  actor_id: string; settings_sha256: string; status: 'PENDING' | 'CREATED'; order_id: string | null;
};
type Idempotency = {payload_hash:string;response:unknown};
type OrderProof = {
  customer_id:string;conversation_id:string|null;active_revision:number;
  request_hash:string;request_data:unknown;
};
export interface DraftReconciliation {
  status: 'recovered' | 'existing'; order_id: string;
  revision: number; requires_customer_confirmation: true;
  preview_trusted: false; created_new_order: false;
}
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Owner-only: recover an already committed AI1 createDraft result after an
 * ambiguous HTTP/DB acknowledgment. NEVER call createDraft or insert an order.
 * PENDING without a matching committed transaction remains PENDING. */
export async function reconcileSyntheticInboundDraft(
  pool: SqlPool, root: string, scope: SyntheticArtifactScope,
  actor: Principal, untrustedInput: unknown
): Promise<DraftReconciliation> {
  assertOwner(actor);
  if (actor.shop_id !== scope.shop_id) return conflict('FORBIDDEN',403);
  const prepared=await prepareSyntheticInboundDraft(pool,root,scope,untrustedInput);
  const {settings,source,request_data,settingsHash,idempotencyKey}=prepared;
  const conn=await pool.connect();
  try {
    await conn.query('BEGIN');
    const active=await conn.query<{mode:string}>(
      'SELECT mode FROM core_shop_settings WHERE shop_id=$1 FOR UPDATE',[scope.shop_id]);
    if (active.rows[0]?.mode!=='simulation') return conflict('SIMULATION_REQUIRED');
    const res=await conn.query<Reservation>(
      'SELECT actor_id,settings_sha256,status,order_id FROM ai0_inbound_artifact_drafts '+
      'WHERE shop_id=$1 AND oa_id=$2 AND event_id=$3 FOR UPDATE',
      [scope.shop_id,scope.oa_id,settings.event_id]);
    const reservation=res.rows[0];
    if (!reservation) return conflict('DRAFT_RESERVATION_MISSING',404);
    if (reservation.settings_sha256!==settingsHash) return conflict('DRAFT_SETTINGS_CONFLICT');
    const payload={
      customer_id:source.customer_id,
      conversation_id:source.conversation_id,
      request_data,
      idempotency_key:idempotencyKey
    };
    const expectedPayloadHash=idempotencyHash(
      {...actor,id:reservation.actor_id},'orders.create',payload);
    const ledger=await conn.query<Idempotency>(
      'SELECT payload_hash,response FROM core_idempotency '+
      'WHERE shop_id=$1 AND actor_id=$2 AND action=$3 AND key=$4 FOR UPDATE',
      [scope.shop_id,reservation.actor_id,'orders.create',idempotencyKey]);
    const recorded=ledger.rows[0];
    if (!recorded || recorded.payload_hash!==expectedPayloadHash)
      return conflict('DRAFT_EVIDENCE_NOT_COMMITTED');
    const receipt=recorded.response;
    if (!receipt || typeof receipt!=='object' || Array.isArray(receipt))
      return conflict('DRAFT_EVIDENCE_UNCONFIRMED');
    const result=receipt as {order_id?:unknown;revision?:unknown;request_hash?:unknown;print_ready?:unknown};
    if (typeof result.order_id!=='string' || !uuidPattern.test(result.order_id) ||
        result.revision!==1 || result.request_hash!==sha(canonical(request_data)) ||
        result.print_ready!==false)
      return conflict('DRAFT_EVIDENCE_MISMATCH');
    const row=await conn.query<OrderProof>(
      'SELECT o.customer_id,o.conversation_id,o.active_revision,'+
      'r.request_hash,r.request_data FROM core_orders o '+
      'JOIN core_revisions r ON r.order_id=o.id AND r.revision=1 '+
      'WHERE o.id=$1 AND o.shop_id=$2 FOR UPDATE OF o',
      [result.order_id,scope.shop_id]);
    const order=row.rows[0];
    if (!order || order.customer_id!==source.customer_id ||
        order.conversation_id!==source.conversation_id ||
        !Number.isSafeInteger(order.active_revision) || order.active_revision<1 ||
        order.request_hash!==result.request_hash ||
        canonical(order.request_data)!==canonical(request_data))
      return conflict('DRAFT_ORDER_MISMATCH');
    if (reservation.status==='CREATED') {
      if (reservation.order_id!==result.order_id)
        return conflict('DRAFT_ORDER_MISMATCH');
      await conn.query('COMMIT');
      return {status:'existing',order_id:result.order_id,
        revision:order.active_revision,requires_customer_confirmation:true,
        preview_trusted:false,created_new_order:false};
    }
    if (reservation.status!=='PENDING' || reservation.order_id)
      return conflict('DRAFT_RESERVATION_CONFLICT');
    const updated=await conn.query(
      'UPDATE ai0_inbound_artifact_drafts '+
      'SET status=\'CREATED\',order_id=$4,completed_at=now() '+
      'WHERE shop_id=$1 AND oa_id=$2 AND event_id=$3 '+
      'AND status=\'PENDING\' AND order_id IS NULL RETURNING order_id',
      [scope.shop_id,scope.oa_id,settings.event_id,result.order_id]);
    if (updated.rowCount!==1) return conflict('DRAFT_RESERVATION_CONFLICT');
    await conn.query('COMMIT');
    return {status:'recovered',order_id:result.order_id,
      revision:order.active_revision,requires_customer_confirmation:true,
      preview_trusted:false,created_new_order:false};
  } catch (error) {
    try { await conn.query('ROLLBACK'); } catch { /* keep original error */ }
    throw error;
  } finally {
    conn.release();
  }
}
