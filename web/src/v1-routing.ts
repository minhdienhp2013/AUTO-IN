/**
 * V1 Word/PDF display routing. This is NOT a print decision or staff approval.
 * Never guess categories from raw user text, file extension or a summary row.
 * An optional server classification must match the current order/revision/hash.
 */
import type { OrderView, VerifiedFileFact } from './domain.ts';

export type ManualRouteCategory = 'image'|'cccd'|'temhoa'|'color'|'unsupported';
export type ManualRouteLabel = 'Ảnh'|'CCCD'|'TEMhoa'|'Yêu cầu in màu'|'Định dạng chưa hỗ trợ';
export interface ServerManualRoute {
  category:ManualRouteCategory;
  kind:'file'|'request';
  received_at:string|null;
}
export interface V1ManualQueue {
  source:'server-scoped';
  state:'received_waiting_staff';
  order_id:string;
  revision:number;
  request_hash:string;
  items:ServerManualRoute[];
}
const catLabels:Record<ManualRouteCategory,ManualRouteLabel>={
  image:'Ảnh',cccd:'CCCD',temhoa:'TEMhoa',color:'Yêu cầu in màu',
  unsupported:'Định dạng chưa hỗ trợ'
};
const obj=(x:unknown):Record<string,unknown> =>
  x!==null&&typeof x==='object'&&!Array.isArray(x)?x as Record<string,unknown>:{};
const categories=Object.keys(catLabels) as ManualRouteCategory[];
export const manualRouteLabel=(category:ManualRouteCategory):ManualRouteLabel=>catLabels[category];

/** User-facing copy for an authenticated, revision-bound manual queue row. */
export function manualQueueRowsForDisplay(order:OrderView):Array<{label:ManualRouteLabel;status:string}>|null {
  const queue=order.v1_manual_queue;
  if(order.detail_loaded!==true||!queue||queue.order_id!==order.order_id||
     queue.revision!==order.revision||queue.request_hash!==order.request_hash||
     queue.state!=='received_waiting_staff')return null;
  return queue.items.map(item=>({
    label:manualRouteLabel(item.category),
    status:'Đã nhận — chờ nhân viên; chưa xác nhận xử lý hay in.',
  }));
}

/**
 * Future AI0/AI1 read-only wire: current.v1_manual_queue.
 * Missing, malformed or stale classification is NOT "received".
 * The backend on PR144 has not yet exposed this shape; no synthetic
 * classification is surfaced in live UI until it does.
 */
export function parseServerManualQueue(raw:unknown,
  scope:Pick<OrderView,'order_id'|'revision'|'request_hash'>):V1ManualQueue|null {
  const data=obj(raw),current=obj(data.current),wire=obj(current.v1_manual_queue);
  if(current.revision!==scope.revision||current.request_hash!==scope.request_hash||
     wire.order_id!==scope.order_id||wire.revision!==scope.revision||
     wire.request_hash!==scope.request_hash||wire.status!=='received_waiting_staff'||
     !Array.isArray(wire.items)||wire.items.length<1||wire.items.length>50)
    return null;
  const items:ServerManualRoute[]=[];
  for(const unknownItem of wire.items){
    const item=obj(unknownItem);
    if(!categories.includes(item.category as ManualRouteCategory)||
       (item.kind!=='file'&&item.kind!=='request')||
       !(item.received_at===null||item.received_at===undefined||
         typeof item.received_at==='string'&&
         Number.isFinite(Date.parse(item.received_at))))return null;
    items.push({category:item.category as ManualRouteCategory,kind:item.kind,
      received_at:typeof item.received_at==='string'?item.received_at:null});
  }
  return {source:'server-scoped',state:'received_waiting_staff',
    order_id:scope.order_id,revision:scope.revision,
    request_hash:scope.request_hash,items};
}
export type V1DocumentRoute = 'word'|'pdf'|'staff_only';
/** Only format from a verified catalog; never infer "printed" from preview. */
export function routeVerifiedDocument(fact:Pick<VerifiedFileFact,'format'>):V1DocumentRoute {
  switch(fact.format.trim().toUpperCase()){
    case 'DOCX':return 'word';
    case 'PDF':return 'pdf';
    default:return 'staff_only';
  }
}
/**
 * Read-only projection of the EXISTING server pending_updates.
 * When status is "needs_human", scoped safe metadata may show a generic
 * received queue (no category assertion). "processing" is NOT manual handoff;
 * unknown/CLEAR never claim a received file.
 */
export function pendingStaffQueue(order:OrderView):{count:number;listed:number}|null {
  const pending=order.pending_updates;
  if(order.detail_loaded!==true||pending?.state!=='needs_human'||
     !Number.isSafeInteger(pending.unresolved_count)||
     pending.unresolved_count===null||pending.unresolved_count<1)return null;
  return {count:pending.unresolved_count,listed:pending.items.length};
}
export function v1HasManualRoutingHold(order:OrderView):boolean {
  // New read-only status cannot turn any approval gate true; this is only
  // an extra conservative hold for explicitly classified manual requests.
  return order.v1_manual_queue?.state==='received_waiting_staff';
}
