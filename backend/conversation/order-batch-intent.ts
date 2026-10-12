import type {Batch} from './batch.ts';

/** A batching window is never an order boundary. This is intent evidence only;
 * AI1 alone chooses/locks the active order and creates a revision transactionally.
 */
export type IncomingOrderIntent = 'append_or_create' | 'explicit_separate' | 'clarify';
export type IncomingOrderChange = 'attachment' | 'copies' | 'paper' | 'duplex' | 'print_request';
export interface IncomingOrderDecision {
  intent:IncomingOrderIntent;
  changes:IncomingOrderChange[];
  reason?:'CONFLICTING_INTENTS' | 'UNRELATED_MESSAGE' | 'NO_PRINT_CONTENT';
}
const separate=/(?:^|[^\p{L}])(?:tạo|lập|mở|làm|cho|tách|in)\s+(?:giúp\s+)?(?:một\s+)?(?:đơn\s+(?:in\s+)?(?:mới|riêng|khác)|đơn\s+thứ\s+hai)(?=$|[^\p{L}])|(?:^|[^\p{L}])(?:đơn\s+(?:in\s+)?(?:này\s+)?(?:riêng|khác)|đơn\s+thứ\s+hai)(?=$|[^\p{L}])/iu;
const negatedSeparate=/(?:không|đừng|chưa|chớ)\s+(?:cần\s+|phải\s+|muốn\s+)?(?:tạo|lập|mở|làm|tách|in)\s+(?:một\s+)?đơn\s+(?:in\s+)?(?:mới|riêng|khác)/iu;
const append=/(?:gửi|thêm|bổ\s+sung|đính\s+kèm|kèm|đổi|sửa|chỉnh|thay|tăng|giảm|chuyển|cho)\s+(?:thêm\s+|sang\s+|lại\s+)?(?:file|tài\s+liệu|ảnh|bản|số\s+bản|khổ|giấy|a[345]|mặt|trang)|(?:in\s+thêm|file\s+tiếp|còn\s+file)/iu;
const copies=/(?:\d+\s*(?:bản|copies)|(?:số\s+bản|bản\s+in|in\s+thêm\s+\d+))/iu;
const paper=/(?:\bA[345]\b|khổ\s+giấy|đổi\s+khổ|giấy\s+(?:a[345]|ngang|dọc))/iu;
const duplex=/(?:hai\s+mặt|2\s*mặt|một\s+mặt|1\s*mặt|in\s+2\s+mặt|in\s+1\s+mặt)/iu;
const printing=/(?:^|[^\p{L}])(?:in|photo|photocopy|scan|bản\s+in|tờ|trang)(?=$|[^\p{L}])/iu;
export function classifyIncomingOrderBatch(batch:Batch):IncomingOrderDecision {
  const events=batch.events;
  if(events.length===0)return {intent:'clarify',changes:[],reason:'NO_PRINT_CONTENT'};
  const first=events[0];
  if(!first || events.some(e=>e.oa_id!==first.oa_id ||
    e.customer_id!==first.customer_id || e.conversation_id!==first.conversation_id ||
    !e.event_id))return {intent:'clarify',changes:[],reason:'CONFLICTING_INTENTS'};
  const value=events.filter(e=>e.kind==='text').map(e=>e.text??'').join(' \n ').normalize('NFC').toLocaleLowerCase('vi');
  const hasFile=events.some(e=>e.kind==='file'||e.kind==='image');
  const newOrder=separate.test(value) && !negatedSeparate.test(value);
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
