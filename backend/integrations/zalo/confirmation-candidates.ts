import {randomUUID} from "node:crypto";
import type {CandidateDecision,CandidateInput,ConfirmationCandidatePort} from "../../conversation/confirmation-candidate.ts";
import {confirmationIntent} from "../../conversation/confirmation-candidate.ts";
import type {PgTransactions,PgTx} from "./postgres-durable.ts";

/** Authenticated, server-issued reply challenge. NEVER construct this from
 * text, DeepSeek, webhook headers, customer-provided IDs or a guessed match.
 * AI0 must implement a verified, event-bound resolver before enabling candidates.
 * It is called INSIDE a PostgreSQL transaction against trusted server records.
 */
export interface VerifiedConfirmationChallenge {
  proof:"server_verified_event_bound_challenge";
  challenge_id:string;
  shop_id:string;oa_id:string;customer_id:string;conversation_id:string;
  bound_event_id:string;
  order_id:string;
  kind:"request"|"quote";
  active_revision:number;
  request_hash:string;
  quote_revision:number|null;
  expected_generation:number;
  issued_at:string;expires_at:string;
}
export interface VerifiedChallengePort {
  resolve_verified(tx:PgTx,scope:Readonly<{
    shop_id:string;oa_id:string;customer_id:string;conversation_id:string;
    event_id:string;
  }>):Promise<VerifiedConfirmationChallenge|null>;
}

type EventRow={conversation_id:string;customer_id:string;occurred_at:Date;payload_json:unknown};
type ControlRow={generation:string;status:string};
type RevisionRow={active_revision:number;request_hash:string|null;order_id:string};
type CandidateRow={candidate_id:string;order_id:string;request_hash:string;
  active_revision:number;quote_revision:number|null;kind:string;challenge_id:string};
function pending(reason:string):CandidateDecision {return {status:"pending",reason};}
function manual(reason:string):CandidateDecision {return {status:"needs_human",reason};}
function safeInt(n:unknown):n is number{return typeof n==="number"&&Number.isSafeInteger(n)&&n>=0}
function safeId(s:unknown,max:number):s is string {
  return typeof s==="string"&&s.length>0&&s.trim()===s&&s.length<=max;
}
function safeTime(s:string):number {
  if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(s))
    return NaN;
  return Date.parse(s);
}
function verifiedChallenge(c:VerifiedConfirmationChallenge|null,shop:string,oa:string,
  customer:string,conv:string,eventId:string,expected:number):c is VerifiedConfirmationChallenge {
  if(!c||c.proof!=="server_verified_event_bound_challenge"||
    c.shop_id!==shop||c.oa_id!==oa||c.customer_id!==customer||
    c.conversation_id!==conv||c.bound_event_id!==eventId||
    !safeId(c.challenge_id,128)||!safeId(c.order_id,64)||
    (c.kind!=="request"&&c.kind!=="quote")||
    !safeInt(c.active_revision)||c.active_revision<1||
    !/^[a-f0-9]{64}$/i.test(c.request_hash)||
    (c.kind==="quote" ? !safeInt(c.quote_revision)||c.quote_revision<1 : c.quote_revision!==null)||
    !safeInt(c.expected_generation)||c.expected_generation!==expected)return false;
  const issued=safeTime(c.issued_at),expires=safeTime(c.expires_at);
  return Number.isFinite(issued)&&Number.isFinite(expires)&&issued<expires;
}

/** Only persists an untrusted-for-confirmation *candidate*.
 * Never invokes AI1.confirm, writes core_confirmations, impersonates a customer,
 * changes print approval, or sends an outbound message.
 * All comparison and INSERT run in one database transaction.
 */
export class PostgresConfirmationCandidates implements ConfirmationCandidatePort {
  private readonly db:PgTransactions;
  private readonly shop:string;
  private readonly oa:string;
  private readonly challenges:VerifiedChallengePort|undefined;
  constructor(db:PgTransactions,shop:string,oa:string,challenges?:VerifiedChallengePort) {
    if(!safeId(shop,128)||!safeId(oa,128))throw new Error("INVALID_CANDIDATE_SCOPE");
    this.db=db;this.shop=shop;this.oa=oa;this.challenges=challenges;
  }
  async consider(input:CandidateInput):Promise<CandidateDecision> {
    const event=confirmationIntent(input.batch);
    if(!event)return pending("NOT_AN_ISOLATED_CONFIRMATION_REPLY");
    if(event.oa_id!==this.oa||!safeId(event.conversation_id,256)||
      !safeId(event.customer_id,256)||!safeId(event.event_id,128)||
      !safeInt(input.expected_generation))return manual("UNTRUSTED_EVENT_SCOPE");
    return this.db.transaction(async tx=>{
      // A committed event inserted by the verified Zalo ingress is required.
      // No reliance on the in-memory batch's event ID or raw-text assertion.
      const records=await tx.query<EventRow>(`
        SELECT conversation_id,customer_id,occurred_at,payload_json
        FROM zalo_inbound_events WHERE oa_id=$1 AND event_id=$2 FOR SHARE`,
        [this.oa,event.event_id]);
      const actual=records.rows[0];
      if(!actual||actual.customer_id!==event.customer_id||
        actual.conversation_id!==event.conversation_id)return manual("EVENT_NOT_VERIFIED");
      const p=typeof actual.payload_json==="string"
        ?JSON.parse(actual.payload_json) as Record<string,unknown>
        :actual.payload_json as Record<string,unknown>;
      if(p?.kind!=="text"||p?.text!==event.text||
        p?.oa_id!==event.oa_id||p?.event_id!==event.event_id||
        p?.customer_id!==event.customer_id||p?.conversation_id!==event.conversation_id)
        return manual("EVENT_CONTENT_MISMATCH");
      if(!this.challenges)return pending("CHALLENGE_PORT_UNAVAILABLE");
      const challenge=await this.challenges.resolve_verified(tx,{
        shop_id:this.shop,oa_id:this.oa,customer_id:event.customer_id,
        conversation_id:event.conversation_id,event_id:event.event_id
      });
      if(!verifiedChallenge(challenge,this.shop,this.oa,event.customer_id,
        event.conversation_id,event.event_id,input.expected_generation))
        return pending("MISSING_OR_UNVERIFIED_CHALLENGE");
      const eventTime=new Date(actual.occurred_at).getTime();
      const start=safeTime(challenge.issued_at),end=safeTime(challenge.expires_at);
      const now=await tx.query<{now:Date}>("SELECT now() AS now");
      const dbNow=new Date(now.rows[0]?.now??0).getTime();
      if(!Number.isFinite(eventTime)||eventTime<start||eventTime>end||
        !Number.isFinite(dbNow)||dbNow>end)
        return manual("CHALLENGE_EXPIRED_OR_EVENT_STALE");
      // Lock generation, then the exact active order and revision. A human
      // takeover can never race a successful candidate insert unobserved.
      const controls=await tx.query<ControlRow>(`
        SELECT generation::text AS generation,status FROM core_conversation_controls
        WHERE shop_id=$1 AND conversation_id=$2 FOR UPDATE`,
        [this.shop,event.conversation_id]);
      const control=controls.rows[0];
      if(!control||control.status!=="AI"||
        Number(control.generation)!==input.expected_generation)
        return {status:"stale_generation",reason:"GENERATION_OR_TAKEOVER_CHANGED"};
      const orders=await tx.query<RevisionRow>(`
        SELECT o.id::text AS order_id,o.active_revision,r.request_hash
        FROM core_orders o
        JOIN core_revisions r ON r.order_id=o.id AND r.revision=o.active_revision
        WHERE o.shop_id=$1 AND o.id=$2::uuid AND o.customer_id=$3
          AND o.conversation_id=$4
        FOR UPDATE OF o`,
        [this.shop,challenge.order_id,event.customer_id,event.conversation_id]);
      const order=orders.rows[0];
      if(!order||order.active_revision!==challenge.active_revision||
        order.request_hash!==challenge.request_hash)
        return manual("ORDER_REVISION_HASH_MISMATCH");
      if(challenge.kind==="quote") {
        const quote=await tx.query<{latest:number|null}>(`
          SELECT max(quote_revision)::int AS latest FROM core_quotes WHERE order_id=$1::uuid`,
          [challenge.order_id]);
        if(quote.rows[0]?.latest!==challenge.quote_revision)
          return manual("QUOTE_REVISION_MISMATCH");
      }
      // A challenge belongs to one and ONLY one verified event. The journal
      // is durable after ACK-loss, restart or two workers; no second emission.
      const id=randomUUID();
      const written=await tx.query<{candidate_id:string}>(`
        INSERT INTO zalo_confirmation_candidates
          (candidate_id,shop_id,oa_id,event_id,conversation_id,customer_id,
           challenge_id,order_id,active_revision,request_hash,kind,
           quote_revision,expected_generation)
        VALUES($1::uuid,$2,$3,$4,$5,$6,$7,$8::uuid,$9,$10,$11,$12,$13)
        ON CONFLICT DO NOTHING RETURNING candidate_id::text`,
        [id,this.shop,this.oa,event.event_id,event.conversation_id,
          event.customer_id,challenge.challenge_id,challenge.order_id,
          challenge.active_revision,challenge.request_hash,challenge.kind,
          challenge.quote_revision,input.expected_generation]);
      if(written.rows[0])return {status:"candidate",candidate_id:written.rows[0].candidate_id};
      const existing=await tx.query<CandidateRow>(`
        SELECT candidate_id::text,order_id::text,request_hash,active_revision,
          quote_revision,kind,challenge_id
        FROM zalo_confirmation_candidates WHERE shop_id=$1 AND oa_id=$2
          AND (event_id=$3 OR challenge_id=$4) FOR UPDATE`,
        [this.shop,this.oa,event.event_id,challenge.challenge_id]);
      const record=existing.rows[0];
      if(existing.rows.length!==1||!record||
        record.order_id!==challenge.order_id||
        record.request_hash!==challenge.request_hash||
        record.active_revision!==challenge.active_revision||
        record.quote_revision!==challenge.quote_revision||
        record.kind!==challenge.kind||record.challenge_id!==challenge.challenge_id)
        return manual("CANDIDATE_REPLAY_CONFLICT");
      return {status:"existing",candidate_id:record.candidate_id};
    });
  }
}
