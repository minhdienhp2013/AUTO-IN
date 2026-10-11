import type { InboundEvent } from "../integrations/zalo/protocol.ts";
export type Intent = "PRINT" | "QUESTION" | "HUMAN" | "OTHER";
export type HandoverReason =
  "EXCEL" | "COLOR_PRINT" | "COMPLEX_PRINT" | "TOO_MANY_DOCUMENTS" |
  "UNSUPPORTED_FILE" | "DOWNLOAD_FAILED" | "UNREADABLE" | "NEEDS_CLARIFICATION";
export interface DocumentFact { kind: "pdf" | "word" | "image" | "excel" | "unknown" | "zip";
  count_inside?: number; preview_trusted?: boolean }
export interface RulesResult { intent: Intent; handover_reason?: HandoverReason;
  reply?: string; needs_deepseek: boolean; requires_confirmation: boolean }
const RE_PRICE = /(giá|bao nhiêu tiền|báo giá|đặt cọc)/iu;
const RE_COLOR = /\b(in màu|màu sắc|đen trắng kết hợp|xen kẽ màu)\b/i;
const RE_PRINT = /\b(in|photo|photocopy|in ấn|bản|tờ|trang|a4|a3|hai mặt|một mặt)\b/i;
const RE_MIXED = /in\s*(trang|page).*(màu|đen)|trang.*(màu|đen).*(trang|page)/i;
const RE_COMPLEX = /in.*(sách đóng gáy|dàn trang|đóng quyển|thiết kế)/i;
export function interpretByRules(
  events: readonly InboundEvent[],
  documents: readonly DocumentFact[] = [],
): RulesResult {
  const text = events.filter(e=>e.kind === "text").map(e=>e.text ?? "").join(" ").normalize("NFC");
  const types = [...documents];
  if (types.some(f=>f.kind === "excel"))
    return {intent:"HUMAN",handover_reason:"EXCEL",reply:"Tôi đã nhận yêu cầu. Tôi sẽ chuyển nhân viên hỗ trợ file Excel cho bạn.",needs_deepseek:false,requires_confirmation:false};
  if (types.some(f=>f.kind === "unknown" || f.preview_trusted === false))
    return {intent:"HUMAN",handover_reason:"UNREADABLE",reply:"Tôi đã nhận file; nhân viên sẽ kiểm tra vì chưa thể xem trước tin cậy.",needs_deepseek:false,requires_confirmation:false};
  if (types.some(f=>f.kind === "zip" && f.count_inside === undefined))
    return {intent:"HUMAN",handover_reason:"NEEDS_CLARIFICATION",reply:"Tôi cần kiểm tra số tài liệu bên trong ZIP trước khi tiếp tục.",needs_deepseek:false,requires_confirmation:false};
  const total = types.reduce((sum,f)=>sum + (f.kind === "zip" ? (f.count_inside ?? 0) : 1),0);
  if (total > 5)
    return {intent:"HUMAN",handover_reason:"TOO_MANY_DOCUMENTS",reply:"Đơn có hơn 5 tài liệu; nhân viên sẽ kiểm tra giúp bạn.",needs_deepseek:false,requires_confirmation:false};
  if (RE_MIXED.test(text) || RE_COMPLEX.test(text))
    return {intent:"HUMAN",handover_reason:"COMPLEX_PRINT",reply:"Yêu cầu in này cần nhân viên kiểm tra chi tiết, tôi đã chuyển giúp bạn.",needs_deepseek:false,requires_confirmation:false};
  if (RE_COLOR.test(text))
    return {intent:"HUMAN",handover_reason:"COLOR_PRINT",reply:"Yêu cầu in màu được chuyển nhân viên hỗ trợ bạn.",needs_deepseek:false,requires_confirmation:false};
  if (RE_PRICE.test(text))
    return {intent:"QUESTION",reply:"Giá và tiền cọc do nhân viên cửa hàng xác nhận, tôi sẽ chuyển yêu cầu báo giá cho bạn.",needs_deepseek:false,requires_confirmation:false};
  if (RE_PRINT.test(text) || types.length > 0)
    return {intent:"PRINT",reply:"Tôi đã nhận yêu cầu in. Bạn vui lòng xác nhận thông số và bản xem trước sau khi cửa hàng chuẩn bị.",needs_deepseek:false,requires_confirmation:true};
  return {intent:"OTHER",needs_deepseek:true,requires_confirmation:false};
}
