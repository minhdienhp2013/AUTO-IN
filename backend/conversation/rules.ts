import type { InboundEvent } from "../integrations/zalo/protocol.ts";
export type Intent = "PRINT" | "QUESTION" | "HUMAN" | "OTHER";
export type HandoverReason =
  "EXCEL" | "COLOR_PRINT" | "COMPLEX_PRINT" | "TOO_MANY_DOCUMENTS" |
  "UNSUPPORTED_FILE" | "DOWNLOAD_FAILED" | "UNREADABLE" | "NEEDS_CLARIFICATION" | "PRICE_QUOTE" |
  "IMAGE_V1" | "ZIP_V1" | "DUPLICATE_FILE";
export interface DocumentFact { kind: "pdf" | "word" | "image" | "excel" | "unknown" | "zip";
  count_inside?: number; preview_trusted?: boolean }
export interface RulesResult { intent: Intent; handover_reason?: HandoverReason;
  reply?: string; needs_deepseek: boolean; requires_confirmation: boolean }
// Unicode-aware boundaries: \b does not recognize Vietnamese accented letters.
const boundary = (words: string) => new RegExp(
  `(?:^|[^\\p{L}\\p{N}])(?:${words})(?=$|[^\\p{L}\\p{N}])`, "iu");
const RE_PRICE = boundary("giá|bao\\s+nhiêu\\s+tiền|báo\\s+giá|đặt\\s+cọc");
const RE_COLOR = boundary("in\\s+màu|màu\\s+sắc|đen\\s+trắng\\s+kết\\s+hợp|xen\\s+kẽ\\s+màu");
const RE_PRINT = boundary("in(?:\\s+ấn)?|photo|photocopy|bản|tờ|trang|a4|a3|hai\\s+mặt|một\\s+mặt");
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
  // V1 owner priority: images are staff-only. Never OCR or infer print
  // readiness from image attachments even if a preview happens to exist.
  if (events.some(e=>e.kind==="image") || types.some(f=>f.kind==="image"))
    return {intent:"HUMAN",handover_reason:"IMAGE_V1",reply:"Tôi đã nhận ảnh; nhân viên sẽ kiểm tra và hỗ trợ bạn.",needs_deepseek:false,requires_confirmation:false};
  if (types.some(f=>f.kind === "unknown"))
    return {intent:"HUMAN",handover_reason:"UNSUPPORTED_FILE",reply:"Tôi đã nhận file; nhân viên sẽ kiểm tra định dạng chưa hỗ trợ.",needs_deepseek:false,requires_confirmation:false};
  if (types.some(f=>f.preview_trusted === false))
    return {intent:"HUMAN",handover_reason:"UNREADABLE",reply:"Tôi đã nhận file; nhân viên sẽ kiểm tra vì chưa thể xem trước tin cậy.",needs_deepseek:false,requires_confirmation:false};
  if (types.some(f=>f.kind === "zip" &&
    (f.count_inside === undefined || !Number.isSafeInteger(f.count_inside) ||
      f.count_inside < 0)))
    return {intent:"HUMAN",handover_reason:"NEEDS_CLARIFICATION",reply:"Tôi cần nhân viên kiểm tra số tài liệu trong ZIP.",needs_deepseek:false,requires_confirmation:false};
  const total = types.reduce((sum,f)=>sum + (f.kind === "zip" ? (f.count_inside ?? 0) : 1),0);
  if (!Number.isSafeInteger(total) || total > 5)
    return {intent:"HUMAN",handover_reason:"TOO_MANY_DOCUMENTS",reply:"Đơn có hơn 5 tài liệu hoặc số lượng chưa an toàn; nhân viên sẽ kiểm tra giúp bạn.",needs_deepseek:false,requires_confirmation:false};
  // Even a trusted ZIP count cannot make unpacked content a V1 auto-print.
  if (types.some(f=>f.kind==="zip"))
    return {intent:"HUMAN",handover_reason:"ZIP_V1",reply:"Tôi đã nhận ZIP; nhân viên sẽ kiểm tra từng tài liệu.",needs_deepseek:false,requires_confirmation:false};
  if (types.some(f=>(f.kind==="pdf"||f.kind==="word")&&f.preview_trusted!==true))
    return {intent:"HUMAN",handover_reason:"UNREADABLE",reply:"Tôi đã nhận file; nhân viên sẽ kiểm tra bản xem trước.",needs_deepseek:false,requires_confirmation:false};
  if (RE_MIXED.test(text) || RE_COMPLEX.test(text))
    return {intent:"HUMAN",handover_reason:"COMPLEX_PRINT",reply:"Yêu cầu in này cần nhân viên kiểm tra chi tiết, tôi đã chuyển giúp bạn.",needs_deepseek:false,requires_confirmation:false};
  if (RE_COLOR.test(text))
    return {intent:"HUMAN",handover_reason:"COLOR_PRINT",reply:"Yêu cầu in màu được chuyển nhân viên hỗ trợ bạn.",needs_deepseek:false,requires_confirmation:false};
  if (RE_PRICE.test(text))
    return {intent:"QUESTION",handover_reason:"PRICE_QUOTE",reply:"Giá và tiền cọc do nhân viên cửa hàng xác nhận, tôi sẽ chuyển yêu cầu báo giá cho bạn.",needs_deepseek:false,requires_confirmation:false};
  if (RE_PRINT.test(text) || types.length > 0)
    return {intent:"PRINT",reply:"Tôi đã nhận yêu cầu in. Bạn vui lòng xác nhận thông số và bản xem trước sau khi cửa hàng chuẩn bị.",needs_deepseek:false,requires_confirmation:true};
  return {intent:"OTHER",needs_deepseek:true,requires_confirmation:false};
}
