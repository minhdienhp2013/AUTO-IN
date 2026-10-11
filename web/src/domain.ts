/** UI-only view models; API shape remains owned by AI0. JSON wire uses snake_case. */
export type OperationMode = 'simulation' | 'controlled_test' | 'production' | 'safe' | 'unverified';
export type PrintState = 'NOT_SENT' | 'SENDING' | 'SENT_UNVERIFIED' | 'UNKNOWN' | 'VERIFIED_DONE' | 'SIMULATED_DONE';
export type StaffRole = 'owner' | 'staff';
export type OrderState = 'draft' | 'awaiting_customer' | 'confirmed' | 'approved' | 'abandoned' | 'closed';
export type ConversationState = 'ai' | 'needs_human' | 'staff';
export type DeliveryState = 'not_ready' | 'quality_check' | 'ready' | 'partial' | 'delivered' | 'exception_closed';
export type PaymentState = 'unpaid' | 'deposit_requested' | 'partial' | 'paid' | 'refund_pending' | 'refunded';

export interface DocumentView {
  document_id: string;
  filename: string;
  format: string;
  pages: number | null;
  printed_faces: number | null;
  physical_sheets: number | null;
  copies: number;
  paper: string;
  duplex: boolean;
  orientation: 'portrait' | 'landscape';
  preview_url: string | null;
  preview_trusted: boolean;
  warnings: string[];
}
export interface AuditEntry { at: string; actor: string; action: string; summary: string }
export interface OrderView {
  order_id: string;
  job_id?: string | null; // AI1 job eligible for physical-paper verification; never inferred from a list
  customer_name: string;
  conversation_id: string | null;
  revision: number;
  request_hash: string;
  quote_revision: number | null;
  order_state: OrderState;
  conversation_state: ConversationState;
  print_state: PrintState;
  delivery_state: DeliveryState;
  payment_state: PaymentState;
  confirmed_revision: number | null;
  confirmed_quote_revision: number | null;
  amount_vnd: number | null;
  required_deposit_vnd: number;
  received_vnd: number;
  large_cost_flag: boolean;
  delivered_sheets: number;
  total_sheets: number | null;
  urgent: boolean;
  created_at: string;
  documents: DocumentView[];
  warnings: string[];
  audit: AuditEntry[];
  manual_lock: boolean;
}
export interface StaffSession { actor_id: string; display_name: string; role: StaffRole; can_approve: boolean; can_manage_schedule: boolean }
export interface Snapshot { mode: OperationMode; orders: OrderView[]; session: StaffSession }
export type ActionKind = 'approve' | 'quote' | 'payment' | 'delivery' | 'manual' | 'handover' | 'return_to_ai' | 'verify_paper';
export interface Mutation { expected_revision: number; idempotency_key: string; request_hash: string; [key: string]: string | number | boolean | null }

export const printLabels: Record<PrintState, string> = {
  NOT_SENT: 'Chưa gửi máy', SENDING: 'Đang gửi lệnh', SENT_UNVERIFIED: 'Đã gửi · chưa kiểm giấy',
  UNKNOWN: 'Chưa rõ · cần đối soát', VERIFIED_DONE: 'Đã xác minh giấy thật', SIMULATED_DONE: 'Mô phỏng xong · chưa in giấy',
};
export const orderLabels: Record<OrderState, string> = { draft: 'Đang chuẩn bị', awaiting_customer: 'Chờ khách xác nhận', confirmed: 'Chờ nhân viên duyệt', approved: 'Đã duyệt', abandoned: 'Bỏ dở', closed: 'Đã đóng' };
export const conversationLabels: Record<ConversationState, string> = { ai: 'AI hỗ trợ', needs_human: 'Cần nhân viên', staff: 'Nhân viên tiếp quản' };
export const deliveryLabels: Record<DeliveryState, string> = { not_ready: 'Chưa sẵn sàng', quality_check: 'Chờ kiểm giấy', ready: 'Sẵn sàng giao', partial: 'Giao một phần', delivered: 'Đã giao đủ', exception_closed: 'Đóng phần in ngoại lệ' };
export const paymentLabels: Record<PaymentState, string> = { unpaid: 'Chưa thu', deposit_requested: 'Đang yêu cầu cọc', partial: 'Còn phải thu', paid: 'Đã thu đủ', refund_pending: 'Chờ hoàn tiền', refunded: 'Đã hoàn thực tế' };
export const money = (n: number | null): string => n === null ? 'Chưa nhập' : new Intl.NumberFormat('vi-VN').format(n) + ' đ';
export const hasValidApprovalInputs = (order: OrderView): boolean => {
  if (order.order_state !== 'confirmed' || order.confirmed_revision !== order.revision || order.manual_lock) return false;
  if (!order.request_hash || order.documents.length === 0 || order.documents.some(d => !d.preview_trusted || d.pages === null || d.physical_sheets === null)) return false;
  if (order.print_state !== 'NOT_SENT') return false;
  const mustConfirmPrice = order.total_sheets !== null && order.total_sheets > 150 || order.large_cost_flag;
  return !mustConfirmPrice || order.amount_vnd !== null && order.quote_revision !== null && order.confirmed_quote_revision === order.quote_revision;
};
export const depositShortfall = (o: OrderView): number => Math.max(0, o.required_deposit_vnd - o.received_vnd);
export const receivable = (o: OrderView): number | null => o.amount_vnd === null ? null : Math.max(0, o.amount_vnd - o.received_vnd);
export const isPrintUncertain = (s: PrintState): boolean => ['SENDING', 'SENT_UNVERIFIED', 'UNKNOWN'].includes(s);
export const validMoney = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
export const actionPath = (order: OrderView, kind: ActionKind): string => {
  const prefix = '/api/v1';
  if (kind === 'verify_paper') {
    if (!order.job_id) throw new Error('Chưa xác định duy nhất tác vụ cần kiểm giấy.');
    return `${prefix}/print-jobs/${encodeURIComponent(order.job_id)}/verify-paper`;
  }
  if (kind === 'handover' || kind === 'return_to_ai') {
    if (!order.conversation_id) throw new Error('Đơn chưa liên kết hội thoại.');
    return `${prefix}/conversations/${encodeURIComponent(order.conversation_id)}/${kind === 'handover' ? 'handover' : 'return-to-ai'}`;
  }
  const suffix: Record<Exclude<ActionKind, 'handover' | 'return_to_ai' | 'verify_paper'>, string> = {
    approve: 'approvals', quote: 'quote', payment: 'payments', delivery: 'deliveries', manual: 'manual',
  };
  return `${prefix}/orders/${encodeURIComponent(order.order_id)}/${suffix[kind]}`;
};