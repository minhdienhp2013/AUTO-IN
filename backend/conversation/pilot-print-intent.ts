import type {InboundEvent} from "../integrations/zalo/protocol.ts";

/**
 * Conservative extraction from already-persisted OA text. This is a candidate
 * for AI1's authoritative, shop-scoped validation, never a code verification,
 * customer-presence proof, order update, approval or permission to print.
 * File custody is separate: an OA attachment event is not trusted file bytes.
 */
export interface PilotPrintIntent {
  readonly scope:{oa_id:string;customer_id:string;conversation_id:string};
  readonly event_ids:readonly string[];
  readonly code_candidate:string|null;
  readonly copies:number|null;
  readonly paper:"A4"|null;
  readonly sides:1|2|null;
  readonly black_white:boolean;
  readonly status:"ready_for_core_validation"|"needs_clarification";
  readonly reasons:readonly (
    "MISSING_CODE"|"MISSING_COPIES"|"MISSING_PAPER"|"MISSING_SIDES"|
    "MISSING_BLACK_WHITE"|"CONFLICTING_CODE"|"CONFLICTING_COPIES"|
    "CONFLICTING_SIDES"|"UNSUPPORTED_PRINT_OPTION"
  )[];
}

function unique<T>(values:readonly T[]):T[]{return [...new Set(values)];}

/** Text must explicitly label the shop code. A bare number may be a phone,
 * order ID or page count, so it is never interpreted as a code. AI1 defines
 * the actual code alphabet/length and checks its 30-minute validity in DB.
 */
export function extractPilotPrintIntent(events:readonly InboundEvent[]):PilotPrintIntent|null {
  const first=events[0];
  if(!first||events.some(e=>e.oa_id!==first.oa_id||
    e.customer_id!==first.customer_id||e.conversation_id!==first.conversation_id||
    !e.event_id))return null;
  const textEvents=events.filter(e=>e.kind==="text"&&typeof e.text==="string");
  if(textEvents.length===0)return null;
  const text=textEvents.map(e=>e.text).join("\n").normalize("NFC");
  const upper=text.toUpperCase();
  const reasons:PilotPrintIntent["reasons"][number][]=[];
  const codes=unique([...text.matchAll(/(?:^|[^\p{L}\p{N}])mã\s*(?:cửa\s*hàng|tạm)?\s*[:：-]\s*([A-Za-z0-9]{4,16})(?=$|[^\p{L}\p{N}])/giu)]
    .map(match=>match[1]?.toUpperCase()).filter((value):value is string=>!!value));
  const code_candidate=codes.length===1?codes[0]??null:null;
  if(codes.length>1)reasons.push("CONFLICTING_CODE");
  else if(!code_candidate)reasons.push("MISSING_CODE");

  const copies=unique([...text.matchAll(/(?:^|[^\p{L}\p{N}])(?:số\s*bản\s*[:：-]?\s*(\d{1,3})|(?:in\s+)?(\d{1,3})\s*bản)(?=$|[^\p{L}\p{N}])/giu)]
    .map(match=>Number(match[1]??match[2])).filter(Number.isSafeInteger));
  const copiesValue=copies.length===1&&copies[0]!==undefined&&copies[0]>=1&&copies[0]<=99?copies[0]:null;
  if(copies.length>1)reasons.push("CONFLICTING_COPIES");
  else if(copiesValue===null)reasons.push("MISSING_COPIES");

  const paper=/(?:^|[^A-Z0-9])A4(?=$|[^A-Z0-9])/.test(upper)?"A4":null;
  if(!paper)reasons.push("MISSING_PAPER");
  const one=/(?:^|[^\p{L}\p{N}])(?:1|một)\s*mặt(?=$|[^\p{L}\p{N}])/iu.test(text);
  const two=/(?:^|[^\p{L}\p{N}])(?:2|hai)\s*mặt(?=$|[^\p{L}\p{N}])/iu.test(text);
  const sides:1|2|null=one===two?null:one?1:2;
  if(one&&two)reasons.push("CONFLICTING_SIDES");
  else if(sides===null)reasons.push("MISSING_SIDES");
  const black_white=/(?:^|[^\p{L}\p{N}])(?:đen\s*trắng|trắng\s*đen|b\s*\/\s*w)(?=$|[^\p{L}\p{N}])/iu.test(text);
  if(!black_white)reasons.push("MISSING_BLACK_WHITE");
  if(/(?:^|[^A-Z0-9])A3(?=$|[^A-Z0-9])/.test(upper)||
     /(?:^|[^\p{L}\p{N}])(?:in\s*)?màu(?=$|[^\p{L}\p{N}])/iu.test(text))
    reasons.push("UNSUPPORTED_PRINT_OPTION");

  return {
    scope:{oa_id:first.oa_id,customer_id:first.customer_id,
      conversation_id:first.conversation_id},
    event_ids:unique(textEvents.map(e=>e.event_id)).sort(),
    code_candidate,copies:copiesValue,paper,sides,black_white,
    status:reasons.length===0?"ready_for_core_validation":"needs_clarification",reasons
  };
}
