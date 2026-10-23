import type {Batch} from './batch.ts';

/** A batching window is never an order boundary. This is intent evidence only;
 * AI1 alone chooses/locks the active order and creates a revision transactionally.
 */
export type IncomingOrderIntent = 'append_or_create' | 'explicit_separate' | 'clarify';
export type IncomingOrderBoundary = 'NEW' | 'CONTINUE' | 'AMBIGUOUS';
export type IncomingOrderChange = 'attachment' | 'copies' | 'paper' | 'duplex' | 'print_request';
export interface IncomingOrderDecision {
  intent:IncomingOrderIntent;
  changes:IncomingOrderChange[];
  reason?:'CONFLICTING_INTENTS' | 'AMBIGUOUS_ORDER_BOUNDARY' | 'UNRELATED_MESSAGE' | 'NO_PRINT_CONTENT';
}

const newOrderNoun=String.raw`đơn(?:\s+(?:in|hàng))?\s+(?:mới|riêng|khác|thứ\s+(?:hai|2)|tiếp\s+theo)`;
const explicitNewOrder=new RegExp(String.raw`(?:^|[^\p{L}\p{N}])(?:tạo|lập|mở|làm|cho|tách|đặt|chuyển\s+sang)\s+(?:(?:giúp|cho|ra|sang|một)\s+)*(?:${newOrderNoun})(?=$|[^\p{L}\p{N}])`,'iu');
const explicitCreateOrder=/(?:^|[^\p{L}\p{N}])(?:tạo|lập|mở|tách|đặt)\s+(?:(?:giúp|cho|ra|một)\s+)*đơn(?=$|[^\p{L}\p{N}])/iu;
const bareNewOrderPrefix=new RegExp(String.raw`^\s*${newOrderNoun}(?:\s*(?:$|[,;:.!])|\s+(?:a[345]\b|in\b|gửi\b|đính\b|file\b|số\s+bản\b|khổ\b|(?:một|hai|2)\s+mặt\b))`,'iu');
const newOrderMention=new RegExp(newOrderNoun,'iu');
const possibleCreateOrder=/(?:^|[^\p{L}\p{N}])(?:tạo|lập|mở|làm|tách|đặt)\s+(?:(?:giúp|cho|ra|một|thêm)\s+)*đơn(?=$|[^\p{L}\p{N}])/iu;
const negatedNewOrder=new RegExp(String.raw`(?:^|[^\p{L}])(?:không|đừng|chưa|chớ|chẳng|khỏi)(?:\s+\p{L}+){0,5}\s+${newOrderNoun}(?=$|[^\p{L}\p{N}])`,'iu');
const append=/(?:gửi|thêm|bổ\s+sung|đính\s+kèm|kèm|đổi|sửa|chỉnh|thay|tăng|giảm|chuyển|cho)\s+(?:thêm\s+|sang\s+|lại\s+)?(?:file|tài\s+liệu|ảnh|bản|số\s+bản|khổ|giấy|a[345]|mặt|trang)|(?:in\s+thêm|file\s+tiếp|còn\s+file)/iu;
const keepCurrentOrder=/(?:tiếp\s+tục|nối\s+tiếp|ghép|bổ\s+sung|thêm)\s+(?:(?:vào|cho)\s+)?(?:đơn\s+(?:cũ|trước|hiện\s+tại|này)|đơn\b)/iu;
const copies=/(?:\d+\s*(?:bản|copies)|(?:số\s+bản|bản\s+in|in\s+thêm\s+\d+))/iu;
const paper=/(?:\bA[345]\b|khổ\s+giấy|đổi\s+khổ|giấy\s+(?:a[345]|ngang|dọc))/iu;
const duplex=/(?:hai\s+mặt|2\s*mặt|một\s*mặt|1\s*mặt|in\s+2\s+mặt|in\s+1\s+mặt)/iu;
const printing=/(?:^|[^\p{L}])(?:in|photo|photocopy|scan|bản\s+in|tờ|trang)(?=$|[^\p{L}])/iu;

/**
 * Parse only explicit new-order instructions. A batching window is not an
 * order boundary; callers must persist NEW through Core's intake boundary.
 * Any mention of a new order that is negated, contradictory, or not clear
 * enough to parse is AMBIGUOUS so the durable worker holds it for staff.
 */
export function classifyIncomingOrderBoundary(batch:Batch):IncomingOrderBoundary {
  const events=batch.events;
  const first=events[0];
  if(!first||events.some(event=>event.oa_id!==first.oa_id||
    event.customer_id!==first.customer_id||event.conversation_id!==first.conversation_id||
    !event.event_id))return 'AMBIGUOUS';
  const value=events.filter(event=>event.kind==='text').map(event=>event.text??'')
    .join(' \n ').normalize('NFC').toLocaleLowerCase('vi');
  const mentionsNew=newOrderMention.test(value);
  const possibleCreate=possibleCreateOrder.test(value);
  if(!mentionsNew&&!possibleCreate)return 'CONTINUE';
  if(negatedNewOrder.test(value)||value.includes('?'))return 'AMBIGUOUS';

  const clearNew=explicitNewOrder.test(value)||explicitCreateOrder.test(value)||
    bareNewOrderPrefix.test(value);
  if(!clearNew)return 'AMBIGUOUS';
  // A new-order request mixed with continuation language cannot safely assign
  // the current lease's code/file/settings to one order.
  if(append.test(value)||keepCurrentOrder.test(value))return 'AMBIGUOUS';
  return 'NEW';
}

export function classifyIncomingOrderBatch(batch:Batch):IncomingOrderDecision {
  const events=batch.events;
  if(events.length===0)return {intent:'clarify',changes:[],reason:'NO_PRINT_CONTENT'};
  const first=events[0];
  if(!first || events.some(e=>e.oa_id!==first.oa_id ||
    e.customer_id!==first.customer_id || e.conversation_id!==first.conversation_id ||
    !e.event_id))return {intent:'clarify',changes:[],reason:'CONFLICTING_INTENTS'};
  const value=events.filter(e=>e.kind==='text').map(e=>e.text??'').join(' \n ').normalize('NFC').toLocaleLowerCase('vi');
  const hasFile=events.some(e=>e.kind==='file'||e.kind==='image');
  const boundary=classifyIncomingOrderBoundary(batch);
  if(boundary==='AMBIGUOUS')return {intent:'clarify',changes:[],
    reason:explicitNewOrder.test(value)&&append.test(value)?'CONFLICTING_INTENTS':'AMBIGUOUS_ORDER_BOUNDARY'};
  const newOrder=boundary==='NEW';
  // A single batch with "add to this" AND "separate order" cannot safely
  // assign which attachment/line belongs to which order: require staff.
  if(newOrder && append.test(value))return {intent:'clarify',changes:[],reason:'CONFLICTING_INTENTS'};
  const changes:IncomingOrderChange[]=[];
  if(hasFile)changes.push('attachment');
  if(copies.test(value))changes.push('copies');
  if(paper.test(value))changes.push('paper');
  if(duplex.test(value))changes.push('duplex');
  if(printing.test(value)||append.test(value))changes.push('print_request');
  if(!hasFile && changes.length===0)
    return {intent:'clarify',changes:[],reason:newOrder?'NO_PRINT_CONTENT':'UNRELATED_MESSAGE'};
  return {intent:newOrder?'explicit_separate':'append_or_create',changes};
}
