import { randomBytes } from 'node:crypto';
import { DomainError, dbSafeInteger, newId, sha, canonical } from './model.js';
import {currentEvidence,type TrustedPrintEvidencePort} from './print-evidence.js';
import type { PgStore, SqlConnection } from '../storage/database.js';

/** Created only by AI0 from a VERIFIED provider OA -> shop mapping; never from HTTP body. */
export interface TrustedConfirmationScope { readonly shop_id: string; readonly oa_id: string }
export type ConfirmationKind = 'request' | 'quote';
export interface ConfirmationTarget {
  order_id: string;
  expected_revision: number;
  request_hash: string;
  kind: ConfirmationKind;
  quote_revision?: number;
  expected_generation: number;
}
export interface VerifiedConfirmationEvent extends ConfirmationTarget { event_id: string }
export type RecordedConfirmation =
  | { status: 'confirmed' | 'existing'; confirmation_id: string; order_id: string; revision: number; kind: ConfirmationKind; quote_revision: number | null }
  | { status: 'stale' };

type Order = { id: string; shop_id: string; customer_id: string; conversation_id: string | null;
  active_revision: number; manual_lock: boolean; print_closed: boolean };
type Challenge = { id: string; order_id: string; revision: number; request_hash: string;
  customer_id: string; conversation_id: string; kind: ConfirmationKind; quote_revision: number | null;
  generation: string | number; secret_hash: string; expires_at: Date;
  consumed_event_id: string | null; confirmation_id: string | null };
function bounded(value: string, name: string, max = 256) {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new DomainError('INVALID_CONFIRMATION_INPUT', `Invalid ${name}`, 422);
  return value;
}
function targetOf(x: ConfirmationTarget) {
  if (!x || !Number.isSafeInteger(x.expected_revision) || x.expected_revision < 1 ||
      !Number.isSafeInteger(x.expected_generation) || x.expected_generation < 0 ||
      !/^[0-9a-f]{64}$/.test(x.request_hash) || !['request','quote'].includes(x.kind) ||
      (x.kind === 'request' && x.quote_revision !== undefined) ||
      (x.kind === 'quote' && (!Number.isSafeInteger(x.quote_revision) || (x.quote_revision ?? 0) < 1)))
    throw new DomainError('INVALID_CONFIRMATION_INPUT','Revision, hash, generation or quote is invalid',422);
  bounded(x.order_id, 'order_id', 64);
}

/**
 * SERVER ONLY: issue a random, one-time challenge for a specific revision; AI0 must deliver
 * through the verified OA customer channel. This method does NOT confirm anything.
 * AI0 must verify webhook signature, event type and persist normalized inbound events;
 * plain "OK", user supplied event IDs or text cannot be promoted to postback evidence.
 */
export function createVerifiedConfirmationPort(options: { store: PgStore; trusted: TrustedConfirmationScope; evidence?:TrustedPrintEvidencePort }) {
  const {store, trusted} = options;
  if (!store?.tx || !trusted || typeof trusted.shop_id !== 'string' ||
      typeof trusted.oa_id !== 'string' || !trusted.shop_id.trim() || !trusted.oa_id.trim() ||
      trusted.shop_id.length > 128 || trusted.oa_id.length > 256)
    throw new DomainError('CONFIRMATION_PORT_NOT_CONFIGURED','Trusted OA/shop configuration required',503);
  const shopId = trusted.shop_id, oaId = trusted.oa_id;
  async function evidenceHash(db:SqlConnection,o:Order):Promise<string|null>{
   if(!options.evidence)return null;
   const rev=(await db.query<{request_hash:string;request_data:unknown;plan:import('./model.js').PrintPlan|null}>(
    'SELECT request_hash,request_data,plan FROM core_revisions WHERE order_id=$1 AND revision=$2',
    [o.id,o.active_revision])).rows[0];
   if(!rev?.plan||rev.request_hash!==sha(canonical(rev.request_data)))
    throw new DomainError('STALE_PRINT_EVIDENCE','Chưa có file/hash/plan hiện hành',409);
   return currentEvidence(db,options.evidence,{shop_id:o.shop_id,order_id:o.id,
    revision:o.active_revision,request_hash:rev.request_hash,plan:rev.plan});
  }

  async function lockedTarget(db: SqlConnection, input: ConfirmationTarget) {
    const orders = await db.query<Order>('SELECT id,shop_id,customer_id,conversation_id,active_revision,manual_lock,print_closed FROM core_orders WHERE id=$1 FOR UPDATE',[input.order_id]);
    const o = orders.rows[0];
    if (!o || o.shop_id !== shopId) throw new DomainError('CONFIRMATION_SCOPE_DENIED','Order outside verified shop',403);
    if (o.active_revision !== input.expected_revision || o.manual_lock || o.print_closed)
      return null;
    if (!o.conversation_id) throw new DomainError('CONFIRMATION_UNLINKED','Order has no verified conversation',403);
    const rev = await db.query<{request_hash:string}>('SELECT request_hash FROM core_revisions WHERE order_id=$1 AND revision=$2',[o.id,o.active_revision]);
    if (rev.rows[0]?.request_hash !== input.request_hash) return null;
    const controls = await db.query<{status:'AI'|'HUMAN';generation:string|number}>(
      'SELECT status,generation FROM core_conversation_controls WHERE shop_id=$1 AND conversation_id=$2 FOR UPDATE',
      [shopId,o.conversation_id]);
    const c = controls.rows[0];
    if (!c || c.status !== 'AI' || dbSafeInteger(c.generation,'conversation.generation') !== input.expected_generation)
      return null;
    let quote: number | null = null;
    if (input.kind === 'quote') {
      const latest = await db.query<{quote_revision:number}>(
        'SELECT quote_revision FROM core_quotes WHERE order_id=$1 ORDER BY quote_revision DESC LIMIT 1',[o.id]);
      if (latest.rows[0]?.quote_revision !== input.quote_revision) return null;
      quote = input.quote_revision ?? null;
    }
    // Customer confirmation must never be newly minted after real staff approval.
    // This row lock is the same lock held by OrderService.approve. A committed
    // pre-approval event can still be replayed idempotently after approval.
    const approved=await db.query(
      'SELECT 1 FROM core_approvals WHERE order_id=$1 LIMIT 1',[o.id]);
    return { order:o, quote, approved:approved.rows.length>0 };
  }

  /** Internal issue API: neither a request confirmation nor staff approval. */
  async function issue_challenge(input: ConfirmationTarget): Promise<{status:'issued';challenge_id:string;challenge_token:string;expires_at:Date}|{status:'stale'}> {
    targetOf(input);
    return store.tx(async db=>{
      const bound=await lockedTarget(db,input);
      if (!bound || bound.approved) return {status:'stale'};
      const evidence=await evidenceHash(db,bound.order);
      const id=newId(), token=randomBytes(32).toString('base64url');
      const result=await db.query<{expires_at:Date}>(
        `INSERT INTO core_confirmation_challenges
         (id,shop_id,oa_id,order_id,revision,request_hash,customer_id,conversation_id,kind,quote_revision,generation,secret_hash,expires_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now()+interval '10 minutes') RETURNING expires_at`,
         [id,shopId,oaId,bound.order.id,input.expected_revision,input.request_hash,bound.order.customer_id,
          bound.order.conversation_id,input.kind,bound.quote,input.expected_generation,sha(token)]);
      const expiry=result.rows[0]?.expires_at;
      if (!expiry) throw new DomainError('CHALLENGE_NOT_STORED','Challenge persistence failed',500);
      if(evidence)await db.query(
       "INSERT INTO core_audit(id,shop_id,actor_id,action,order_id,details) "+
       "VALUES($1,$2,$3,'customer.challenge_evidence',$4,$5::jsonb)",
       [newId(),shopId,'verified-oa:'+oaId,bound.order.id,
        JSON.stringify({challenge_id:id,evidence_sha256:evidence})]);
      return {status:'issued',challenge_id:id,challenge_token:token,expires_at:expiry};
    });
  }

  /**
   * The normalized inbound event MUST be server-signed and persisted by AI0/AI2 BEFORE
   * this call, with `payload_json.confirmation_postback` populated ONLY from a verified,
   * explicit accept button (not message text). The random challenge value proves exact
   * order/revision intent; the verified event proves customer/channel identity.
   */
  async function confirm_verified_event(input: VerifiedConfirmationEvent): Promise<RecordedConfirmation> {
    targetOf(input);
    bounded(input.event_id,'event_id');
    return store.tx(async db=>{
      const bound=await lockedTarget(db,input);
      if (!bound) return {status:'stale'};
      const event=await db.query<{customer_id:string;conversation_id:string;postback:unknown}>(
        `SELECT customer_id,conversation_id,payload_json->'confirmation_postback' AS postback
         FROM zalo_inbound_events WHERE oa_id=$1 AND event_id=$2 FOR SHARE`,[oaId,input.event_id]);
      const evidence=event.rows[0];
      if (!evidence || evidence.customer_id!==bound.order.customer_id ||
          evidence.conversation_id!==bound.order.conversation_id)
        throw new DomainError('UNVERIFIED_CONFIRMATION_EVENT','Event provenance does not match customer',403);
      const p=evidence.postback;
      if (!p || typeof p!=='object' || Array.isArray(p))
        throw new DomainError('CONFIRMATION_CHALLENGE_REQUIRED','An explicit verified postback is required',403);
      const data=p as Record<string,unknown>;
      if (data.kind!=='verified_confirmation_accept' || typeof data.challenge_id!=='string' ||
          typeof data.challenge_token!=='string' || !data.challenge_token || data.challenge_token.length>256)
        throw new DomainError('CONFIRMATION_CHALLENGE_REQUIRED','Verified confirmation challenge missing',403);
      const challenges=await db.query<Challenge>(
        `SELECT id,order_id,revision,request_hash,customer_id,conversation_id,kind,quote_revision,
                generation,secret_hash,expires_at,consumed_event_id,confirmation_id
         FROM core_confirmation_challenges WHERE id=$1 AND shop_id=$2 AND oa_id=$3 FOR UPDATE`,
        [data.challenge_id,shopId,oaId]);
      const challenge=challenges.rows[0];
      if (!challenge || challenge.order_id!==bound.order.id || challenge.customer_id!==bound.order.customer_id ||
          challenge.conversation_id!==bound.order.conversation_id || challenge.revision!==input.expected_revision ||
          challenge.request_hash!==input.request_hash || challenge.kind!==input.kind ||
          challenge.quote_revision!==bound.quote ||
          dbSafeInteger(challenge.generation,'challenge.generation')!==input.expected_generation ||
          challenge.secret_hash!==sha(data.challenge_token))
        throw new DomainError('CONFIRMATION_CHALLENGE_MISMATCH','Challenge does not match active order',403);
      if (challenge.consumed_event_id) {
        if (challenge.consumed_event_id!==input.event_id || !challenge.confirmation_id)
          throw new DomainError('CONFIRMATION_REPLAY','Challenge already consumed by a different event',409);
        return {status:'existing',confirmation_id:challenge.confirmation_id,
          order_id:bound.order.id,revision:input.expected_revision,kind:input.kind,quote_revision:bound.quote};
      }
      const printEvidence=await evidenceHash(db,bound.order);
      if(printEvidence){
       const challengeProof=(await db.query<{details:{evidence_sha256?:string}}>(
        "SELECT details FROM core_audit WHERE shop_id=$1 AND order_id=$2 "+
        "AND action='customer.challenge_evidence' AND details->>'challenge_id'=$3",
        [shopId,bound.order.id,challenge.id])).rows[0];
       if(challengeProof?.details?.evidence_sha256!==printEvidence)return {status:'stale'};
      }
      // Staff approval may have won the locked-order race while the
      // customer clicked an earlier unconsumed challenge. HOLD, never insert.
      if (bound.approved) return {status:'stale'};
      if (new Date(challenge.expires_at).getTime() <= Date.now())
        throw new DomainError('CONFIRMATION_CHALLENGE_EXPIRED','Challenge expired',409);
      const priorEvent=await db.query<{confirmation_id:string}>(
        'SELECT confirmation_id FROM core_verified_confirmation_events WHERE shop_id=$1 AND oa_id=$2 AND event_id=$3 FOR UPDATE',
        [shopId,oaId,input.event_id]);
      if (priorEvent.rows.length)
        throw new DomainError('CONFIRMATION_EVENT_REPLAY','An event cannot confirm multiple challenges',409);
      const confirmationId=newId();
      await db.query(`INSERT INTO core_confirmations
        (id,order_id,revision,request_hash,kind,quote_revision,customer_id,channel)
        VALUES($1,$2,$3,$4,$5,$6,$7,'verified_oa_challenge')`,
        [confirmationId,bound.order.id,input.expected_revision,input.request_hash,input.kind,bound.quote,bound.order.customer_id]);
      await db.query('UPDATE core_confirmation_challenges SET consumed_event_id=$2,confirmation_id=$3 WHERE id=$1',
        [challenge.id,input.event_id,confirmationId]);
      await db.query(`INSERT INTO core_verified_confirmation_events
        (shop_id,oa_id,event_id,challenge_id,confirmation_id) VALUES($1,$2,$3,$4,$5)`,
        [shopId,oaId,input.event_id,challenge.id,confirmationId]);
      // Provenance audit uses an OA-scoped service actor, not forged employee/customer principal.
      await db.query(`INSERT INTO core_audit(id,shop_id,actor_id,action,order_id,details)
        VALUES($1,$2,$3,'customer.confirmed_verified_event',$4,$5::jsonb)`,
        [newId(),shopId,'verified-oa:'+oaId,bound.order.id,
         JSON.stringify({event_id:input.event_id,confirmation_id:confirmationId,revision:input.expected_revision,
           request_hash:input.request_hash,kind:input.kind,quote_revision:bound.quote,
           ...(printEvidence?{evidence_sha256:printEvidence}:{})})]);
      return {status:'confirmed',confirmation_id:confirmationId,order_id:bound.order.id,
        revision:input.expected_revision,kind:input.kind,quote_revision:bound.quote};
    });
  }
  return { issue_challenge, confirm_verified_event };
}
