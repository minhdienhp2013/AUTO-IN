import {createHash} from "node:crypto";
import type { Batch } from "./batch.ts";
import {interpretByRules,type DocumentFact} from "./rules.ts";
import type { GatePort,GateSnapshot } from "./gate.ts";
import type { AiInterpretation } from "../ai/deepseek.ts";

/** AI1 MUST compare expected_generation under its authoritative shop-scoped
 * PostgreSQL row lock in the SAME transaction as each business effect.
 * Returned stale_generation is a normal concurrent handover, not a retryable error.
 * All other errors propagate so the durable worker keeps the batch for retry.
 */
/** Exact AI1 createAiOrderPort() contract, CODE-301 PR #16 / #28. */
export type DraftResult = {status:"created"|"existing";order_id:string} | {status:"stale_generation"};
export type HumanRouteResult = {status:"routed"|"already_routed";generation:number} | {status:"stale_generation"};
export interface OrderDraftPort {
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
  constructor(gate:GatePort,documents:DocumentFactsPort,orders:OrderDraftPort,
    reply:ReplyQueuePort,classifier?:ClassifierPort) {
    this.gate=gate;this.documents=documents;this.orders=orders;
    this.reply=reply;this.classifier=classifier;
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
    if(decision.needs_deepseek && !this.classifier)
      return routeHuman("AI_UNAVAILABLE");
    if(decision.needs_deepseek && this.classifier) {
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
    if(decision.intent==="OTHER")return routeHuman("OUT_OF_SCOPE");
    if(decision.intent==="HUMAN"||decision.handover_reason==="PRICE_QUOTE") {
      const result=await routeHuman(decision.handover_reason??"NEEDS_CLARIFICATION");
      if(result==="held")return "held";
    }
    if(decision.intent==="PRINT") {
      // AI1 performs generation CAS and idempotent draft insert AT the side-effect
      // boundary: this second gate read alone cannot prevent a concurrent handover.
      const result=await this.orders.suggest_draft({
        conversation_id:first.conversation_id,customer_id:first.customer_id,
        expected_generation:snap.generation,event_ids,text,idempotency_key:key+":draft"
      });
      if(draftOutcome(result)==="held")return "held";
    }
    if(!await this.current(snap,batch))return "held";
    if(decision.reply) {
      await this.reply.enqueue({outbound_id:"reply:"+key,
        conversation_id:first.conversation_id,generation:snap.generation,text:decision.reply});
    }
    return (decision.intent==="HUMAN"||decision.handover_reason==="PRICE_QUOTE")?"human":"processed";
  }
}
