import type { Batch } from "./batch.ts";
import {interpretByRules,type DocumentFact} from "./rules.ts";
import type { GatePort } from "./gate.ts";
import type { AiInterpretation } from "../ai/deepseek.ts";
/** AI1 decides revisions, confirmation, permission, price and approval. */
export interface OrderDraftPort {
  suggest_draft(data: {conversation_id:string; customer_id:string;
    event_ids:string[]; text:string; idempotency_key:string}): Promise<{order_id:string;revision:number}>;
  route_human(data:{conversation_id:string; reason:string; event_ids:string[]}): Promise<void>;
}
export interface ClassifierPort { classify(text:string): Promise<{result:AiInterpretation}> }
export interface DocumentFactsPort {
  /** AI3 counts files inside ZIP and checks preview. Never infer page count with AI. */
  inspect(batch: Batch): Promise<DocumentFact[]>;
}
export interface ReplyQueuePort {
  enqueue(data:{outbound_id:string;conversation_id:string;generation:number;text:string}):Promise<void>;
}
export class ConversationProcessor {
  private readonly gate:GatePort;
  private readonly documents:DocumentFactsPort;
  private readonly orders:OrderDraftPort;
  private readonly reply:ReplyQueuePort;
  private readonly classifier?:ClassifierPort;
  constructor(gate:GatePort,documents:DocumentFactsPort,orders:OrderDraftPort,
    reply:ReplyQueuePort,classifier?:ClassifierPort) {
    this.gate=gate;this.documents=documents;this.orders=orders;
    this.reply=reply;this.classifier=classifier;
  }
  async consume(batch:Batch):Promise<"processed"|"human"|"held"> {
    const first=batch.events[0];
    if (!first) return "held";
    const snap=await this.gate.read(first.conversation_id);
    // Always persist events upstream; never process or enqueue replies while taken over.
    if (snap.mode !== "AI") return "held";
    const text=batch.events.filter(e=>e.kind==="text").map(e=>e.text??"").join("\n");
    let decision;
    try {
      decision=interpretByRules(batch.events,await this.documents.inspect(batch));
    } catch {
      await this.orders.route_human({conversation_id:first.conversation_id,
        reason:"DOCUMENT_INSPECTION_FAILED",event_ids:batch.events.map(e=>e.event_id)});
      return "human";
    }
    if (decision.needs_deepseek && !this.classifier) {
      await this.orders.route_human({conversation_id:first.conversation_id,reason:"AI_UNAVAILABLE",
        event_ids:batch.events.map(e=>e.event_id)});
      return "human";
    }
    if (decision.needs_deepseek && this.classifier) {
      try {
        const ai=await this.classifier.classify(text);
        if (ai.result.intent === "HUMAN") {
          decision={...decision,intent:"HUMAN" as const,handover_reason:"NEEDS_CLARIFICATION" as const,
            reply:"Tôi đã chuyển nhân viên hỗ trợ bạn.",needs_deepseek:false};
        } else if (ai.result.requires_clarification) {
          decision={...decision,intent:"QUESTION" as const,reply:ai.result.question ?? "Bạn có thể nói rõ yêu cầu in không?",needs_deepseek:false};
        } else if (ai.result.intent === "PRINT") {
          decision={...decision,intent:"PRINT" as const,reply:"Tôi đã nhận yêu cầu. Cửa hàng sẽ chuẩn bị bản xem trước để bạn xác nhận.",needs_deepseek:false};
        }
      } catch {
        await this.orders.route_human({conversation_id:first.conversation_id,reason:"AI_UNAVAILABLE",
          event_ids:batch.events.map(e=>e.event_id)});
        return "human";
      }
    }
    // Suppress stale side effects after takeover during classifier / inspection.
    const beforeAction=await this.gate.read(first.conversation_id);
    if (beforeAction.mode!=="AI" || beforeAction.generation!==snap.generation) return "held";
    if (decision.intent === "OTHER") {
      await this.orders.route_human({conversation_id:first.conversation_id,reason:"OUT_OF_SCOPE",
        event_ids:batch.events.map(e=>e.event_id)});
      return "human";
    }
    if (decision.intent === "HUMAN") {
      await this.orders.route_human({conversation_id:first.conversation_id,
        reason:decision.handover_reason??"NEEDS_CLARIFICATION",event_ids:batch.events.map(e=>e.event_id)});
    }
    if (decision.intent === "PRINT") {
      await this.orders.suggest_draft({
        conversation_id:first.conversation_id,customer_id:first.customer_id,
        event_ids:batch.events.map(e=>e.event_id),text,
        idempotency_key:`zalo:${first.oa_id}:${batch.events.map(e=>e.event_id).sort().join(":")}`,
      });
    }
    // Recheck generation AFTER AI/AI3/AI1 before queuing any outbound.
    const latest=await this.gate.read(first.conversation_id);
    if (latest.mode!=="AI" || latest.generation!==snap.generation) return "held";
    if (decision.reply) {
      await this.reply.enqueue({outbound_id:`reply:${first.oa_id}:${batch.events.map(e=>e.event_id).sort().join(":")}`,
        conversation_id:first.conversation_id,generation:snap.generation,text:decision.reply});
    }
    return decision.intent==="HUMAN"?"human":"processed";
  }
}
