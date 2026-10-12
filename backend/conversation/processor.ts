import {createHash} from "node:crypto";
import type { Batch } from "./batch.ts";
import {interpretByRules,type DocumentFact} from "./rules.ts";
import type { GatePort,GateSnapshot } from "./gate.ts";
import type { AiInterpretation } from "../ai/deepseek.ts";
import {confirmationIntent,type ConfirmationCandidatePort} from "./confirmation-candidate.ts";
import {classifyIncomingOrderBatch,type IncomingOrderChange} from "./order-batch-intent.ts";

/** AI1 MUST compare expected_generation under its authoritative shop-scoped
 * PostgreSQL row lock in the SAME transaction as each business effect.
 * Returned stale_generation is a normal concurrent handover, not a retryable error.
 * All other errors propagate so the durable worker keeps the batch for retry.
 */
/** Exact AI1 createAiOrderPort() contract, CODE-301 PR #16 / #28. */
export type DraftResult = {status:"created"|"existing";order_id:string} | {status:"stale_generation"};
export type HumanRouteResult = {status:"routed"|"already_routed";generation:number} | {status:"stale_generation"};
/** CODE-008: Core (AI1) must resolve the active order AND append event IDs in
 * one locked transaction with staff approval. This Port is deliberately optional
 * until AI0 wires AI1's authoritative implementation. It is never simulated by
 * creating a new draft in AI2.
 */
export type ApplyIncomingBatchResult =
  | {status:"created"|"existing";order_id:string;active_revision?:number}
  | {status:"appended";order_id:string;active_revision:number;requires_reconfirmation:true}
  | {status:"needs_human"|"stale_generation"|"closed"|"ambiguous"};
export interface OrderDraftPort {
  apply_incoming_batch?(input:{
    scope:{oa_id:string;customer_id:string;conversation_id:string};
    expected_generation:number;event_ids:string[];text:string;
    idempotency_key:string;intent:"append_or_create"|"explicit_separate";
    changes:IncomingOrderChange[];
  }):Promise<ApplyIncomingBatchResult>;
  suggest_draft(data:{conversation_id:string;customer_id:string;expected_generation:number;
    event_ids:string[];text:string;idempotency_key:string}):Promise<DraftResult>;
  route_human(data:{conversation_id:string;expected_generation:number;reason:string;
    event_ids:string[]}):Promise<HumanRouteResult>;
}
export interface ClassifierPort { classify(text:string):Promise<{result:AiInterpretation}> }
export interface DocumentFactsPort {
  /** AI3 counts files inside ZIP and checks preview. Never infer page count with AI. */
  inspect(batch:Batch):Promise<DocumentFact[]>;
}
export interface ReplyQueuePort {
  enqueue(data:{outbound_id:string;conversation_id:string;generation:number;text:string}):Promise<void>;
}
function batchIdentity(batch:Batch):{event_ids:string[];key:string} {
  const first=batch.events[0];
  if(!first)throw new Error("EMPTY_BATCH");
  const event_ids=[...new Set(batch.events.map(e=>e.event_id))].sort();
  // Stable across crash/restart/worker changes and independent of generation.
  // Bound the idempotency key to AI1's <=128-byte limit; never include message text.
  const digest=createHash("sha256").update(JSON.stringify([
    first.oa_id,first.customer_id,first.conversation_id,event_ids
  ])).digest("hex");
  return {event_ids,key:"zalo:"+digest};
}
function draftOutcome(result:DraftResult):"accepted"|"held" {
  if(result?.status==="stale_generation")return "held";
  if(result && (result.status==="created"||result.status==="existing") &&
    typeof result.order_id==="string"&&result.order_id.length>0)return "accepted";
  // Never treat a malformed or missing AI1 acknowledgement as success.
  throw new Error("AI1_DRAFT_PORT_INVALID_RESULT");
}
function routeOutcome(result:HumanRouteResult):"human"|"held" {
  if(result?.status==="stale_generation")return "held";
  if(result && (result.status==="routed"||result.status==="already_routed") &&
    Number.isSafeInteger(result.generation)&&result.generation>=0)return "human";
  throw new Error("AI1_ROUTE_PORT_INVALID_RESULT");
}
export class ConversationProcessor {
  private readonly gate:GatePort;
  private readonly documents:DocumentFactsPort;
  private readonly orders:OrderDraftPort;
  private readonly reply:ReplyQueuePort;
  private readonly classifier:ClassifierPort|undefined;
  private readonly confirmations:ConfirmationCandidatePort|undefined;
  constructor(gate:GatePort,documents:DocumentFactsPort,orders:OrderDraftPort,
    reply:ReplyQueuePort,classifier?:ClassifierPort,confirmations?:ConfirmationCandidatePort) {
    this.gate=gate;this.documents=documents;this.orders=orders;
    this.reply=reply;this.classifier=classifier;this.confirmations=confirmations;
  }
  private async current(snapshot:GateSnapshot,batch:Batch):Promise<boolean> {
    const now=this.gate.read_verified_batch
      ? await this.gate.read_verified_batch(batch)
      : await this.gate.read(snapshot.conversation_id);
    return now.mode==="AI"&&now.generation===snapshot.generation;
  }
  async consume(batch:Batch):Promise<"processed"|"human"|"held"> {
    const first=batch.events[0];
    if(!first)return "held";
    const snap=this.gate.read_verified_batch
      ? await this.gate.read_verified_batch(batch)
      : await this.gate.read(first.conversation_id);
    if(snap.mode!=="AI")return "held";
    // CODE-402: a standalone "OK" is never a confirmation. Only the
    // authenticated, event-bound challenge Port may persist a candidate.
    // Without that Port we hold for staff; DeepSeek must not infer approval.
    if(confirmationIntent(batch)) {
      if(!this.confirmations)return "held";
      const c=await this.confirmations.consider({batch,expected_generation:snap.generation});
      if(!c||typeof c!=="object")throw new Error("INVALID_CONFIRMATION_CANDIDATE_RESULT");
      if((c.status==="candidate"||c.status==="existing")&&
        typeof c.candidate_id==="string"&&c.candidate_id.length>0)return "processed";
      if(c.status==="pending"||c.status==="needs_human"||
         c.status==="stale_generation")return "held";
      throw new Error("INVALID_CONFIRMATION_CANDIDATE_RESULT");
    }
    const incoming=classifyIncomingOrderBatch(batch);
    // Never interpret a mixed OA/customer/chat or contradictory batch as a
    // single order, even when the provider gives it the same 60s batch key.
    if(incoming.reason==="CONFLICTING_INTENTS")return "held";
    const {event_ids,key}=batchIdentity(batch);
    // Processing payload is canonical even if a retry reconstructs a batch in a
    // different insertion order. AI1 once() rejects same key with different text.
    const ordered=[...batch.events].sort((a,b)=>
      Date.parse(a.occurred_at)-Date.parse(b.occurred_at)||a.event_id.localeCompare(b.event_id));
    const text=ordered.filter(e=>e.kind==="text").map(e=>e.text??"").join("\n");
    const routeHuman=async(reason:string):Promise<"human"|"held">=>{
      if(!await this.current(snap,batch))return "held";
      const result=await this.orders.route_human({
        conversation_id:first.conversation_id,expected_generation:snap.generation,
        reason,event_ids
      });
      return routeOutcome(result);
    };
    let decision;
    try {
      decision=interpretByRules(batch.events,await this.documents.inspect(batch));
    } catch {
      return routeHuman("DOCUMENT_INSPECTION_FAILED");
    }
    // A deterministic order update or explicitly separate request must not
    // depend on a language model being online; Core still adjudicates it.
    const deterministicIncoming=!!this.orders.apply_incoming_batch &&
      incoming.intent!=="clarify" && incoming.changes.length>0;
    if(decision.needs_deepseek && !this.classifier && !deterministicIncoming)
      return routeHuman("AI_UNAVAILABLE");
    if(decision.needs_deepseek && this.classifier && !deterministicIncoming) {
      try {
        const ai=await this.classifier.classify(text);
        if(ai.result.intent==="HUMAN") {
          decision={...decision,intent:"HUMAN" as const,
            handover_reason:"NEEDS_CLARIFICATION" as const,
            reply:"Tôi đã chuyển nhân viên hỗ trợ bạn.",needs_deepseek:false};
        } else if(ai.result.requires_clarification) {
          decision={...decision,intent:"QUESTION" as const,
            reply:"Bạn có thể nói rõ yêu cầu in và thông số bạn muốn không?",needs_deepseek:false};
        } else if(ai.result.intent==="PRINT") {
          decision={...decision,intent:"PRINT" as const,
            reply:"Tôi đã nhận yêu cầu. Cửa hàng sẽ chuẩn bị bản xem trước để bạn xác nhận.",needs_deepseek:false};
        }
      } catch {
        return routeHuman("AI_UNAVAILABLE");
      }
    }
    if(!await this.current(snap,batch))return "held";
    const useAtomic=!!this.orders.apply_incoming_batch &&
      incoming.intent!=="clarify" &&
      (decision.intent==="PRINT" || (decision.intent==="OTHER" && incoming.changes.length>0));
    if(decision.intent==="OTHER"&&!useAtomic)return routeHuman("OUT_OF_SCOPE");
    if(decision.intent==="HUMAN"||decision.handover_reason==="PRICE_QUOTE") {
      const result=await routeHuman(decision.handover_reason??"NEEDS_CLARIFICATION");
      if(result==="held")return "held";
    }
    if(decision.intent==="PRINT"||useAtomic) {
      if(useAtomic && this.orders.apply_incoming_batch && incoming.intent!=="clarify") {
        // Trust only persisted event IDs. AI1 must re-read signed ingress rows
        // and atomically lock the active order/revision and approval boundary.
        const result=await this.orders.apply_incoming_batch({
          scope:{oa_id:first.oa_id,customer_id:first.customer_id,
            conversation_id:first.conversation_id},
          expected_generation:snap.generation,event_ids,text,
          idempotency_key:key+":incoming",intent:incoming.intent,
          changes:incoming.changes
        });
        if(!result||typeof result!=="object")throw new Error("AI1_APPEND_PORT_INVALID_RESULT");
        if(result.status==="stale_generation"||result.status==="needs_human"||
           result.status==="closed"||result.status==="ambiguous")return "held";
        if(!["created","existing","appended"].includes(result.status)||
           typeof result.order_id!=="string"||!result.order_id)
          throw new Error("AI1_APPEND_PORT_INVALID_RESULT");
        if(result.status==="appended"&&
           (!Number.isSafeInteger(result.active_revision)||result.active_revision<1||
            result.requires_reconfirmation!==true))
          throw new Error("AI1_APPEND_PORT_INVALID_RESULT");
      } else {
        // Legacy first-draft interface remains for existing AI0 composition.
        // It does NOT implement cross-batch append: AI0's PG guard holds any
        // subsequent unmatched event until the authoritative Port is wired.
        if(incoming.intent==="explicit_separate")return "held";
        const result=await this.orders.suggest_draft({
          conversation_id:first.conversation_id,customer_id:first.customer_id,
          expected_generation:snap.generation,event_ids,text,idempotency_key:key+":draft"
        });
        if(draftOutcome(result)==="held")return "held";
      }
    }
    if(!await this.current(snap,batch))return "held";
    if(decision.reply) {
      await this.reply.enqueue({outbound_id:"reply:"+key,
        conversation_id:first.conversation_id,generation:snap.generation,text:decision.reply});
    }
    return (decision.intent==="HUMAN"||decision.handover_reason==="PRICE_QUOTE")?"human":"processed";
  }
}
