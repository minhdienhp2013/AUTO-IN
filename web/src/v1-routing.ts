/**
 * V1 Word/PDF display routing. This is NOT a print decision or staff approval.
 * Never guess manual-route categories from raw user text, file names, or a
 * summary row. The only manual queue shown here is the existing scoped
 * pending_updates read model; absent category contracts stay unclassified.
 */
import type { OrderView, VerifiedFileFact } from './domain.ts';

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
