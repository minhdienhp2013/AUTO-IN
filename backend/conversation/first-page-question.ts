/** TN005 is a FIRST-PAGE advisory, never an order/print authority.
 * This module only constructs a question; it NEVER queues or sends a reply,
 * records approval/price, mutates a revision or reads any document/OCR bytes.
 */
export const SAFE_FIRST_PAGE_QUESTION =
  "Bạn muốn in bao nhiêu bản, khổ giấy nào và một mặt hay hai mặt? Cửa hàng sẽ kiểm tra bản xem trước để bạn xác nhận.";

const categories = {
  WORKSHEET:"phiếu học tập",
  EXAM:"đề kiểm tra hoặc đề thi",
  APPLICATION_FORM:"đơn hoặc tờ khai",
  CONTRACT_MINUTES:"hợp đồng hoặc biên bản",
  LESSON_PLAN:"giáo án",
  CV_PROFILE:"hồ sơ cá nhân hoặc CV",
  ADMINISTRATIVE:"văn bản hành chính",
  GENERAL_DOCUMENT:"tài liệu hướng dẫn",
} as const;
type Category = keyof typeof categories;

/** All identifiers must come from trusted AI0 server context, never provider
 * webhook JSON, DeepSeek, customer text or a browser supplied scope. The
 * revision is the requested revision, not merely whatever is newest at read.
 */
export interface FirstPageQuestionScope {
  shop_id:string;
  order_id:string;
  revision:number;
  oa_id:string;
  customer_id:string;
  conversation_id:string;
}
/** AI0 must read the authoritative current Core row, resolve the current
 * verified SEALED source (not a filename supplied by caller), and the stored
 * TN005 advisory in one consistent shop-scoped read transaction. The boolean
 * is an assertion from AI0's sealed-source verification, not from metadata.
 */
export interface FirstPageQuestionSnapshot {
  current?: {
    shop_id:string; order_id:string; active_revision:number;
    oa_id:string; customer_id:string; conversation_id:string;
    request_hash:string; source_sha256:string; sealed_source_verified:boolean;
  } | null;
  advisory?: {
    shop_id:string; order_id:string; revision:number;
    request_hash:string; artifact_sha256:string; metadata:unknown;
  } | null;
}
export interface FirstPageQuestionReadPort {
  read_bound(scope:Readonly<FirstPageQuestionScope>):Promise<FirstPageQuestionSnapshot | null>;
}
export interface FirstPageQuestion {
  text:string;
  used_suggestion:boolean;
}
const safe=():FirstPageQuestion=>({text:SAFE_FIRST_PAGE_QUESTION,used_suggestion:false});
const object=(value:unknown):value is Record<string,unknown>=>
  value!==null && typeof value==="object" && !Array.isArray(value);
const digest=(v:unknown):v is string=>
  typeof v==="string" && /^[0-9a-f]{64}$/.test(v);
const identity=(v:unknown):v is string=>
  typeof v==="string" && v.length>0 && v.length<=128;
const uuid=(v:unknown):v is string=>
  typeof v==="string" && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(v);

/** Only whitelisted TN005 category LABELS become prose; never interpolate
 * raw OCR text, file names, reason, method, customer text, or JSON fields.
 * Any malformed, missing, uncertain, stale or cross-shop record falls back.
 */
export function formatBoundFirstPageQuestion(
  scope:Readonly<FirstPageQuestionScope>,snapshot:FirstPageQuestionSnapshot | null | undefined,
):FirstPageQuestion {
  if(!scope || !identity(scope.shop_id) || !uuid(scope.order_id) ||
     !Number.isSafeInteger(scope.revision) || scope.revision<1 ||
     !identity(scope.oa_id) || !identity(scope.customer_id) ||
     !identity(scope.conversation_id) || !object(snapshot))return safe();
  const current=snapshot.current,record=snapshot.advisory;
  if(!object(current)||!object(record)||
     current.shop_id!==scope.shop_id||current.order_id!==scope.order_id||
     current.active_revision!==scope.revision||
     current.oa_id!==scope.oa_id||current.customer_id!==scope.customer_id||
     current.conversation_id!==scope.conversation_id||
     current.sealed_source_verified!==true||
     !digest(current.request_hash)||!digest(current.source_sha256)||
     record.shop_id!==scope.shop_id||record.order_id!==scope.order_id||
     record.revision!==scope.revision||
     record.request_hash!==current.request_hash||
     record.artifact_sha256!==current.source_sha256)return safe();
  const metadata=record.metadata;
  if(!object(metadata)||
     Object.keys(metadata).sort().join(",")!==
       "analyzed_page_count,category,confidence_label,method,reason_code,schema_version,status"||
     metadata.schema_version!=="tn005.first_page.v1"||
     metadata.status!=="SUGGESTED"||metadata.confidence_label!=="high"||
     metadata.analyzed_page_count!==1||metadata.reason_code!=="NONE"||
     !["pymupdf_page0_text","pymupdf_page0_local_ocr",
       "pillow_frame0_local_ocr"].includes(String(metadata.method))||
     typeof metadata.category!=="string"||
     !Object.prototype.hasOwnProperty.call(categories,metadata.category))return safe();
  const label=categories[metadata.category as Category];
  return {
    text:`Trang đầu có vẻ là ${label}. ${SAFE_FIRST_PAGE_QUESTION}`,
    used_suggestion:true,
  };
}

/** Read failure is never an excuse to reuse cached/stale advice.
 * No automatic outbox write: AI0 must separately CAS-check order/revision,
 * request hash, source SHA and the conversation's AI generation at enqueue.
 */
export async function prepareBoundFirstPageQuestion(
  scope:Readonly<FirstPageQuestionScope>,port:FirstPageQuestionReadPort,
):Promise<FirstPageQuestion> {
  if(!scope||!port || typeof port.read_bound!=="function")return safe();
  try {
    return formatBoundFirstPageQuestion(scope,await port.read_bound({...scope}));
  } catch {
    // Do not log DB errors or private source details into a customer question.
    return safe();
  }
}
