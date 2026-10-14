/** CODE-008 UI read-only helpers. Pending updates are authoritative only when
 * provided by AI0/AI1 with exact order + active revision + request hash.
 * Missing/stale data is UNKNOWN, never silently interpreted as an empty inbox. */
import { hasValidApprovalInputs, type OrderView } from './domain.ts';

export type InboundState = 'unknown' | 'clear' | 'processing' | 'needs_human';
export interface PendingInboundItem {
  kind: 'file' | 'message';
  label: string;
  summary: string;
  received_at: string | null;
}
export interface PendingInboundUpdates {
  state: InboundState;
  unresolved_count: number | null;
  items: PendingInboundItem[];
}
export type Code008OrderView = OrderView & {
  customer_id?: string | null;
  detail_loaded?: boolean;
  pending_updates?: PendingInboundUpdates;
};
export interface ChatOpenGroup {
  customer_id: string;
  conversation_id: string;
  orders: Code008OrderView[];
}
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const unknownPending = (): PendingInboundUpdates => ({ state: 'unknown', unresolved_count: null, items: [] });
/** AI1 CODE-008 backend contract: current.pending_updates is scoped to the active
 * order/revision/hash. Missing/malformed/stale data always blocks approval. */
export function parsePendingInbound(detail: unknown, order: Pick<OrderView, 'order_id'|'revision'|'request_hash'>): PendingInboundUpdates {
  const data = object(detail);
  const current = object(data.current);
  const pending = object(current.pending_updates);
  if (current.revision !== order.revision || current.request_hash !== order.request_hash ||
      pending.order_id !== order.order_id || pending.revision !== order.revision ||
      pending.request_hash !== order.request_hash ||
      !['clear','processing','needs_human'].includes(String(pending.status)) ||
      !Number.isSafeInteger(pending.unresolved_count) || (pending.unresolved_count as number) < 0 ||
      !Array.isArray(pending.items) || pending.items.length > 100) return unknownPending();
  const items: PendingInboundItem[] = [];
  for (const raw of pending.items) {
    const i = object(raw);
    if ((i.kind !== 'file' && i.kind !== 'message') || typeof i.label !== 'string' || i.label.length > 120 ||
      typeof i.summary !== 'string' || i.summary.length > 350 ||
      (i.received_at !== undefined && i.received_at !== null && typeof i.received_at !== 'string') ||
      i.label.includes('[AUTO-IN SYSTEM:') || i.summary.includes('[AUTO-IN SYSTEM:')) return unknownPending();
    items.push({ kind: i.kind, label: i.label, summary: i.summary,
      received_at: typeof i.received_at === 'string' ? i.received_at : null });
  }
  // Backend readPendingUpdates() deliberately returns processing(0) while
  // verified_plan_ready is false and needs_human(0) for ambiguous scope.
  // Only a scoped CLEAR(0,[]) proves the inbox has no unresolved events.
  if (pending.status === 'clear' && (pending.unresolved_count !== 0 || items.length !== 0) ||
      pending.status !== 'clear' && items.length > (pending.unresolved_count as number)) return unknownPending();
  return { state: pending.status as Exclude<InboundState, 'unknown'>,
    unresolved_count: pending.unresolved_count as number, items };
}
export function enrichOrderWithCode008(detail: unknown, order: OrderView): Code008OrderView {
  const data = object(detail);
  const row = object(data.order);
  const active = object(data.current);
  // Fail closed if an inconsistent details envelope was supplied.
  if (row.id !== order.order_id || row.active_revision !== order.revision ||
      active.revision !== order.revision || active.request_hash !== order.request_hash)
    return { ...order, customer_id: null, detail_loaded: false, pending_updates: unknownPending() };
  return { ...order, customer_id: typeof row.customer_id === 'string' && row.customer_id ? row.customer_id : null,
    detail_loaded: true, pending_updates: parsePendingInbound(detail, order) };
}
export function isOpenBeforeStaffApproval(order: Code008OrderView): boolean {
  return order.detail_loaded === true && !order.manual_lock && order.print_state === 'NOT_SENT' &&
    (order.order_state === 'draft' || order.order_state === 'awaiting_customer' || order.order_state === 'confirmed');
}
/** Groups are for DISPLAY ONLY: never merge order IDs or attach a new event. */
export function groupOpenOrdersByChat(orders: readonly Code008OrderView[]): ChatOpenGroup[] {
  const groups = new Map<string, ChatOpenGroup>();
  for (const order of orders) {
    if (!isOpenBeforeStaffApproval(order) || !order.customer_id || !order.conversation_id) continue;
    const key = JSON.stringify([order.customer_id,order.conversation_id]);
    let group=groups.get(key);
    if(!group) {group={customer_id:order.customer_id,conversation_id:order.conversation_id,orders:[]};groups.set(key,group);}
    group.orders.push(order);
  }
  return [...groups.values()].sort((a,b)=>a.customer_id.localeCompare(b.customer_id) ||
    a.conversation_id.localeCompare(b.conversation_id));
}
export function hasClearPendingInbound(order: Code008OrderView): boolean {
  return order.detail_loaded === true && order.pending_updates?.state === 'clear' &&
    order.pending_updates.unresolved_count === 0 && order.pending_updates.items.length === 0;
}
export function canApproveAfterInboundReview(order: Code008OrderView): boolean {
  return hasClearPendingInbound(order) && hasValidApprovalInputs(order);
}
export function canEditPrintRequest(order: Code008OrderView): boolean {
  return !order.manual_lock && order.print_state === 'NOT_SENT' &&
    order.order_state !== 'approved' && order.order_state !== 'closed';
}
export function requiresCustomerReconfirmation(order: Code008OrderView): boolean {
  return order.revision > 1 && order.confirmed_revision !== order.revision;
}