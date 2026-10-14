import {createHash,timingSafeEqual} from "node:crypto";
import {isVerifiedConfirmationPostback} from "../integrations/zalo/protocol.ts";
import type {VerifiedChallengePort,VerifiedConfirmationChallenge} from "../integrations/zalo/confirmation-candidates.ts";
import type {PgTx} from "../integrations/zalo/postgres-durable.ts";

type TrustedScope={readonly shop_id:string;readonly oa_id:string};
type InboundRow={
  event_id:string;oa_id:string;customer_id:string;conversation_id:string;
  occurred_at:Date;received_at:Date;payload_json:unknown;
};
type ChallengeRow={
  challenge_id:string;shop_id:string;oa_id:string;order_id:string;
  customer_id:string;conversation_id:string;kind:string;quote_revision:number|null;
  revision:number;active_revision:number;challenge_request_hash:string;
  active_request_hash:string;generation:string;current_generation:string;
  current_status:string;manual_lock:boolean;print_closed:boolean;approved:boolean;
  latest_quote_revision:number|null;secret_hash:string;
  consumed_event_id:string|null;confirmation_id:string|null;
  created_at:Date;expires_at:Date;
};

function record(value:unknown):Record<string,unknown>|null {
  if(typeof value==="string") {
    try { value=JSON.parse(value) as unknown; } catch { return null; }
  }
  return value!==null&&typeof value==="object"&&!Array.isArray(value)
    ?value as Record<string,unknown>:null;
}
function millis(value:unknown):number {
  if(value instanceof Date)return value.getTime();
  if(typeof value==="string")return Date.parse(value);
  return NaN;
}
function safeGeneration(value:unknown):number|null {
  const parsed=typeof value==="number"?value:typeof value==="string"?Number(value):NaN;
  return Number.isSafeInteger(parsed)&&parsed>=0?parsed:null;
}
function exactPostbackPayload(payload:Record<string,unknown>):boolean {
  const keys=Object.keys(payload);
  const allowed=["event_id","oa_id","customer_id","conversation_id","occurred_at","kind","confirmation_postback"];
  return keys.length===allowed.length&&keys.every(key=>allowed.includes(key));
}
function tokenMatches(token:string,secretHash:string):boolean {
  const expected=Buffer.from(secretHash.trim(),"hex");
  if(expected.length!==32)return false;
  const actual=createHash("sha256").update(token,"utf8").digest();
  return timingSafeEqual(actual,expected);
}

/**
 * Simulation-only adapter for the synthetic ingress. It resolves evidence from
 * one already-persisted, normalized postback inside AI2's PostgreSQL transaction.
 * It never creates confirmations, approvals, outbound replies, or print jobs.
 * The synthetic fixture key is not a real Zalo signature or customer identity.
 */
export function createPostgresVerifiedChallengeResolver(options:{trusted:TrustedScope}):VerifiedChallengePort {
  const shop=options?.trusted?.shop_id,oa=options?.trusted?.oa_id;
  if(typeof shop!=="string"||!shop.trim()||shop.length>128||
     typeof oa!=="string"||!oa.trim()||oa.length>256)
    throw new Error("INVALID_VERIFIED_CHALLENGE_SCOPE");
  return {
    async resolve_verified(tx:PgTx,scope:Readonly<{shop_id:string;oa_id:string;customer_id:string;conversation_id:string;event_id:string}>):Promise<VerifiedConfirmationChallenge|null> {
      if(scope.shop_id!==shop||scope.oa_id!==oa||
         typeof scope.event_id!=="string"||!scope.event_id.trim()||
         scope.event_id.length>128||
         typeof scope.customer_id!=="string"||!scope.customer_id.trim()||
         typeof scope.conversation_id!=="string"||!scope.conversation_id.trim())
        return null;

      // Re-read the committed ingress row; an in-memory event or text cannot
      // supply challenge proof. pg uses one transaction/client for this query.
      const events=await tx.query<InboundRow>(`
        SELECT event_id,oa_id,customer_id,conversation_id,occurred_at,received_at,payload_json
        FROM zalo_inbound_events WHERE oa_id=$1 AND event_id=$2 FOR SHARE`,
        [oa,scope.event_id]);
      const event=events.rows[0];
      if(!event||event.oa_id!==oa||event.event_id!==scope.event_id||
         event.customer_id!==scope.customer_id||
         event.conversation_id!==scope.conversation_id)
        return null;
      const payload=record(event.payload_json);
      if(!payload||!exactPostbackPayload(payload)||
         payload.kind!=="postback"||payload.oa_id!==oa||
         payload.event_id!==scope.event_id||
         payload.customer_id!==scope.customer_id||
         payload.conversation_id!==scope.conversation_id||
         typeof payload.occurred_at!=="string"||
         !Number.isFinite(Date.parse(payload.occurred_at))||
         Date.parse(payload.occurred_at)!==millis(event.occurred_at)||
         !isVerifiedConfirmationPostback(payload.confirmation_postback))
        return null;
      const postback=payload.confirmation_postback;

      // Read-only proof lookup. AI2 takes the generation/order locks later in
      // this same transaction. AI1 alone writes core_confirmations and rechecks
      // the authoritative state under its row locks.
      const found=await tx.query<ChallengeRow>(`
        SELECT c.id::text AS challenge_id,c.shop_id,c.oa_id,
          c.order_id::text AS order_id,c.customer_id,c.conversation_id,c.kind,
          c.quote_revision,c.revision,o.active_revision,
          c.request_hash AS challenge_request_hash,r.request_hash AS active_request_hash,
          c.generation::text AS generation,ctl.generation::text AS current_generation,
          ctl.status AS current_status,o.manual_lock,o.print_closed,
          EXISTS(SELECT 1 FROM core_approvals a WHERE a.order_id=o.id) AS approved,
          (SELECT max(q.quote_revision)::int FROM core_quotes q WHERE q.order_id=o.id)
            AS latest_quote_revision,
          c.secret_hash,c.consumed_event_id,c.confirmation_id,c.created_at,c.expires_at
        FROM core_confirmation_challenges c
        JOIN core_orders o ON o.id=c.order_id AND o.shop_id=c.shop_id
        JOIN core_revisions r ON r.order_id=o.id AND r.revision=o.active_revision
        JOIN core_conversation_controls ctl
          ON ctl.shop_id=c.shop_id AND ctl.conversation_id=c.conversation_id
        WHERE c.id=$1::uuid AND c.shop_id=$2 AND c.oa_id=$3
          AND c.customer_id=$4 AND c.conversation_id=$5`,
        [postback.challenge_id,shop,oa,scope.customer_id,scope.conversation_id]);
      const challenge=found.rows[0];
      if(!challenge||challenge.challenge_id!==postback.challenge_id||
         challenge.shop_id!==shop||challenge.oa_id!==oa||
         challenge.customer_id!==scope.customer_id||
         challenge.conversation_id!==scope.conversation_id||
         challenge.current_status!=="AI"||challenge.manual_lock||challenge.print_closed||
         challenge.approved||challenge.revision!==challenge.active_revision||
         challenge.challenge_request_hash.trim()!==challenge.active_request_hash.trim()||
         !/^[a-f0-9]{64}$/i.test(challenge.active_request_hash.trim())||
         !tokenMatches(postback.challenge_token,challenge.secret_hash))
        return null;
      const generation=safeGeneration(challenge.generation);
      const currentGeneration=safeGeneration(challenge.current_generation);
      if(generation===null||currentGeneration!==generation)return null;
      if(challenge.kind==="request") {
        if(challenge.quote_revision!==null)return null;
      } else if(challenge.kind==="quote") {
        if(!Number.isSafeInteger(challenge.quote_revision)||
           challenge.quote_revision===null||challenge.quote_revision<1||
           challenge.latest_quote_revision!==challenge.quote_revision)
          return null;
      } else return null;
      if((challenge.consumed_event_id===null)!==(challenge.confirmation_id===null))
        return null;
      if(challenge.consumed_event_id!==null&&challenge.consumed_event_id!==scope.event_id)
        return null;

      const issued=millis(challenge.created_at),expires=millis(challenge.expires_at);
      const occurred=millis(event.occurred_at),received=millis(event.received_at);
      const current=await tx.query<{now:Date}>("SELECT now() AS now");
      const dbNow=millis(current.rows[0]?.now);
      if(!Number.isFinite(issued)||!Number.isFinite(expires)||issued>=expires||
         !Number.isFinite(occurred)||occurred<issued||occurred>expires||
         !Number.isFinite(received)||received<issued||received>expires||
         !Number.isFinite(dbNow)||dbNow>expires||received>dbNow)
        return null;

      const requestHash=challenge.active_request_hash.trim();
      const activeRevision=challenge.active_revision;
      if(!Number.isSafeInteger(activeRevision)||activeRevision<1)
        return null;
      return {
        proof:"server_verified_event_bound_challenge",
        challenge_id:challenge.challenge_id,
        shop_id:shop,oa_id:oa,customer_id:scope.customer_id,
        conversation_id:scope.conversation_id,bound_event_id:scope.event_id,
        order_id:challenge.order_id,kind:challenge.kind as "request"|"quote",
        active_revision:activeRevision,request_hash:requestHash,
        quote_revision:challenge.quote_revision,
        expected_generation:generation,
        issued_at:new Date(issued).toISOString(),
        expires_at:new Date(expires).toISOString()
      };
    }
  };
}
