import { actionPath, depositShortfall, hasValidApprovalInputs, validMoney, type ActionKind, type Mutation, type OrderView, type Snapshot, type StaffSession, type OperationMode } from './domain.ts';
import { demoOrders, demoSession } from './fixtures.ts';

export class ApiFault extends Error {
  readonly status: number; readonly code: string; readonly currentRevision?: number;
  constructor(status: number, code: string, message: string, currentRevision?: number) { super(message); this.name = 'ApiFault'; this.status = status; this.code = code; this.currentRevision = currentRevision; }
}
export interface PrintPort {
  login(username: string, password: string): Promise<StaffSession>;
  logout(): Promise<void>;
  me(): Promise<StaffSession>;
  listOrders(): Promise<OrderView[]>;
  getOrder(id: string): Promise<OrderView>;
  mutate(order: OrderView, kind: ActionKind, payload: Record<string, string | number | boolean | null>, key: string): Promise<OrderView>;
  mode(): Promise<OperationMode>;
}
export const isDemo = (env: { VITE_DEMO_MODE?: string } = import.meta.env): boolean => env.VITE_DEMO_MODE !== 'false';
export const newMutationKey = (): string => crypto.randomUUID();
export const makeMutation = (order: OrderView, payload: Record<string, string | number | boolean | null>, key: string): Mutation => ({
  ...payload, expected_revision: order.revision, request_hash: order.request_hash, idempotency_key: key,
});

const knownState = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => typeof value === 'string' && allowed.includes(value as T) ? value as T : fallback;
const asNum = (n: unknown): number | null => validMoney(n) ? n : null;
const asString = (s: unknown, fallback = ''): string => typeof s === 'string' ? s : fallback;
const asObject = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
/** Provisional consumer mapper. AI0 owns final JSON responses, not this file. */
export function mapOrder(raw: unknown): OrderView {
  const o = asObject(raw);
  const documents = Array.isArray(o.documents) ? o.documents.map(item => {
    const d = asObject(item);
    return {
      document_id: asString(d.document_id), filename: asString(d.filename, 'Tài liệu'), format: asString(d.format, 'Chưa rõ'),
      pages: asNum(d.pages), printed_faces: asNum(d.printed_faces), physical_sheets: asNum(d.physical_sheets),
      copies: asNum(d.copies) ?? 1, paper: asString(d.paper, 'Chưa rõ'), duplex: d.duplex === true,
      orientation: knownState(d.orientation, ['portrait', 'landscape'] as const, 'portrait'),
      preview_url: typeof d.preview_url === 'string' ? d.preview_url : null,
      preview_trusted: d.preview_trusted === true, warnings: Array.isArray(d.warnings) ? d.warnings.filter((w): w is string => typeof w === 'string') : [],
    };
  }) : [];
  return {
    order_id: asString(o.order_id), customer_name: asString(o.customer_name, 'Khách hàng'), conversation_id: typeof o.conversation_id === 'string' ? o.conversation_id : null,
    revision: asNum(o.revision) ?? 0, request_hash: asString(o.request_hash), quote_revision: asNum(o.quote_revision),
    order_state: knownState(o.order_state, ['draft','awaiting_customer','confirmed','approved','abandoned','closed'] as const, 'draft'),
    conversation_state: knownState(o.conversation_state, ['ai','needs_human','staff'] as const, 'needs_human'),
    print_state: knownState(o.print_state, ['NOT_SENT','SENDING','SENT_UNVERIFIED','UNKNOWN','VERIFIED_DONE','SIMULATED_DONE'] as const, 'UNKNOWN'),
    delivery_state: knownState(o.delivery_state, ['not_ready','quality_check','ready','partial','delivered','exception_closed'] as const, 'not_ready'),
    payment_state: knownState(o.payment_state, ['unpaid','deposit_requested','partial','paid','refund_pending','refunded'] as const, 'unpaid'),
    confirmed_revision: asNum(o.confirmed_revision), confirmed_quote_revision: asNum(o.confirmed_quote_revision),
    amount_vnd: asNum(o.amount_vnd), required_deposit_vnd: asNum(o.required_deposit_vnd) ?? 0, received_vnd: asNum(o.received_vnd) ?? 0,
    large_cost_flag: o.large_cost_flag === true, delivered_sheets: asNum(o.delivered_sheets) ?? 0, total_sheets: asNum(o.total_sheets),
    urgent: o.urgent === true, created_at: asString(o.created_at),
    documents, warnings: Array.isArray(o.warnings) ? o.warnings.filter((w): w is string => typeof w === 'string') : [],
    audit: Array.isArray(o.audit) ? o.audit.map((entry) => { const a = asObject(entry); return { at: asString(a.at), actor: asString(a.actor), action: asString(a.action), summary: asString(a.summary) }; }) : [],
    manual_lock: o.manual_lock === true,
  };
}
const unwrap = (payload: unknown, key: 'order' | 'orders' | 'session'): unknown => {
  const obj = asObject(payload);
  if (key in obj) return obj[key];
  // AI0 may add an envelope during contract integration; fail visibly if it differs.
  return payload;
};
export class HttpPrintPort implements PrintPort {
  private readonly baseUrl: string; private readonly fetcher: typeof fetch;
  constructor(baseUrl = '', fetcher: typeof fetch = fetch) { this.baseUrl = baseUrl; this.fetcher = fetcher; }
  private async call(path: string, options: RequestInit = {}): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}${path}`, {
        ...options, credentials: 'include', cache: 'no-store',
        headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
      });
    } catch { throw new ApiFault(0, 'NETWORK', 'Mất kết nối API. Không tự xác nhận kết quả; tải lại để đối soát.'); }
    let json: unknown = null;
    try { json = await response.json(); } catch { if (response.ok) throw new ApiFault(503, 'BAD_RESPONSE', 'API trả dữ liệu không đọc được.'); }
    if (!response.ok) {
      const e = asObject(asObject(json).error);
      const defaults: Record<number, string> = { 401: 'Hết phiên đăng nhập. Vui lòng đăng nhập lại.', 403: 'Tài khoản không có quyền thực hiện.', 409: 'Phiên bản đã thay đổi. Tải lại đơn trước khi thao tác.', 422: 'Dữ liệu nghiệp vụ chưa hợp lệ.', 503: 'Chức năng chưa sẵn sàng.' };
      throw new ApiFault(response.status, asString(e.code, `HTTP_${response.status}`), asString(e.message, defaults[response.status] ?? 'API không xử lý được yêu cầu.'), asNum(e.current_revision) ?? undefined);
    }
    return json;
  }
  async login(username: string, password: string): Promise<StaffSession> {
    await this.call('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
    return this.me(); // trust /me, not the submitted role or browser storage.
  }
  async logout() { await this.call('/api/v1/auth/logout', { method: 'POST' }); }
  async me(): Promise<StaffSession> {
    const o = asObject(unwrap(await this.call('/api/v1/auth/me'), 'session'));
    if (!o.actor_id || !o.role) throw new ApiFault(503, 'INVALID_SESSION', 'API chưa trả đủ thông tin tài khoản.');
    return { actor_id: asString(o.actor_id), display_name: asString(o.display_name, 'Nhân viên'), role: knownState(o.role, ['staff','owner'] as const, 'staff'), can_approve: o.can_approve === true, can_manage_schedule: o.can_manage_schedule === true };
  }
  async listOrders() {
    const raw = unwrap(await this.call('/api/v1/orders'), 'orders');
    if (!Array.isArray(raw)) throw new ApiFault(503, 'INVALID_ORDERS', 'Danh sách đơn từ API chưa đúng hợp đồng.');
    return raw.map(mapOrder);
  }
  async getOrder(id: string) { return mapOrder(unwrap(await this.call(`/api/v1/orders/${encodeURIComponent(id)}`), 'order')); }
  async mutate(order: OrderView, kind: ActionKind, payload: Record<string, string | number | boolean | null>, key: string) {
    const raw = await this.call(actionPath(order, kind), { method: 'POST', body: JSON.stringify(makeMutation(order, payload, key)), headers: { 'Idempotency-Key': key } });
    // Mutations may return a receipt only. Never infer success details from local payload.
    const o = asObject(raw);
    if ('order' in o && asObject(o.order).order_id) return mapOrder(o.order);
    return this.getOrder(order.order_id);
  }
  async mode(): Promise<OperationMode> {
    // No public runtime mode route in wire v0.1. Do not guess a production mode.
    return 'unverified';
  }
}
export class DemoPrintPort implements PrintPort {
  private orders = structuredClone(demoOrders);
  private session = structuredClone(demoSession);
  private handled = new Map<string, { signature: string; order: OrderView }>();
  private online = true;
  setNetwork(online: boolean) { this.online = online; }
  private checkNetwork() { if (!this.online) throw new ApiFault(0, 'NETWORK', 'Mất mạng mô phỏng.'); }
  async login(username: string, _password: string) {
    this.checkNetwork();
    this.session = username === 'demo-owner' ? { actor_id: 'demo-owner', display_name: 'Chủ demo', role: 'owner', can_approve: true, can_manage_schedule: true } : structuredClone(demoSession);
    return structuredClone(this.session);
  }
  async logout() { this.checkNetwork(); }
  async me() { this.checkNetwork(); return structuredClone(this.session); }
  async listOrders() { this.checkNetwork(); return structuredClone(this.orders); }
  async getOrder(id: string) {
    this.checkNetwork(); const found = this.orders.find(o => o.order_id === id);
    if (!found) throw new ApiFault(404, 'NOT_FOUND', 'Không tìm thấy đơn mô phỏng.');
    return structuredClone(found);
  }
  async mutate(order: OrderView, kind: ActionKind, payload: Record<string, string | number | boolean | null>, key: string) {
    this.checkNetwork();
    const body = makeMutation(order, payload, key);
    const signature = JSON.stringify({ order_id: order.order_id, kind, body: { ...body, idempotency_key: undefined } });
    const prior = this.handled.get(key);
    if (prior) {
      if (signature !== prior.signature) throw new ApiFault(409, 'IDEMPOTENCY_CONFLICT', 'Khóa thao tác đã dùng với dữ liệu khác.');
      return structuredClone(prior.order);
    }
    const index = this.orders.findIndex(o => o.order_id === order.order_id);
    if (index < 0) throw new ApiFault(404, 'NOT_FOUND', 'Không tìm thấy đơn.');
    const current = this.orders[index];
    if (current.revision !== order.revision || current.request_hash !== order.request_hash) throw new ApiFault(409, 'STALE_REVISION', 'Đơn đã thay đổi; tải lại.', current.revision);
    if (kind !== 'handover' && kind !== 'return_to_ai' && !this.session.can_approve) throw new ApiFault(403, 'FORBIDDEN', 'Bạn không có quyền thao tác.');
    const updated = structuredClone(current);
    if (kind === 'approve') {
      if (!hasValidApprovalInputs(updated)) throw new ApiFault(422, 'NEEDS_CONFIRMATION', 'Chưa đủ điều kiện duyệt phiên bản/preview/giá.');
      if (depositShortfall(updated) > 0 && body.deposit_shortfall_acknowledged !== true) throw new ApiFault(422, 'DEPOSIT_ACK', 'Phải đọc cảnh báo cọc thiếu.');
      updated.order_state = 'approved';
    } else if (kind === 'quote') {
      if (!validMoney(body.amount_vnd)) throw new ApiFault(422, 'INVALID_AMOUNT', 'Giá phải là số VND nguyên không âm.');
      updated.amount_vnd = body.amount_vnd;
      updated.quote_revision = (updated.quote_revision ?? 0) + 1;
      updated.confirmed_quote_revision = null;
    } else if (kind === 'payment') {
      if (!validMoney(body.amount_vnd) || body.amount_vnd === 0 || !['cash','transfer'].includes(String(body.method))) throw new ApiFault(422, 'INVALID_PAYMENT', 'Nhập số tiền nhận thực tế và phương thức.');
      updated.received_vnd += body.amount_vnd;
      updated.payment_state = updated.amount_vnd !== null && updated.received_vnd >= updated.amount_vnd ? 'paid' : 'partial';
    } else if (kind === 'delivery') {
      if (updated.print_state !== 'VERIFIED_DONE') throw new ApiFault(422, 'NOT_VERIFIED', 'Không ghi giao giấy thật từ tác vụ chưa xác minh.');
      if (!validMoney(body.sheets) || body.sheets === 0 || updated.total_sheets === null || updated.delivered_sheets + body.sheets > updated.total_sheets) throw new ApiFault(422, 'INVALID_SHEETS', 'Số tờ giao không hợp lệ.');
      updated.delivered_sheets += body.sheets;
      updated.delivery_state = updated.delivered_sheets === updated.total_sheets ? 'delivered' : 'partial';
    } else if (kind === 'manual') {
      if (updated.print_state !== 'NOT_SENT') throw new ApiFault(422, 'PRINT_UNCERTAIN', 'Lệnh đã hoặc có thể đã gửi; phải đối soát trước.');
      updated.manual_lock = true;
    } else if (kind === 'handover') {
      updated.conversation_state = 'staff';
    } else if (kind === 'return_to_ai') {
      if (updated.conversation_state !== 'staff') throw new ApiFault(422, 'NOT_HANDOVER', 'Chưa có nhân viên tiếp quản.');
      updated.conversation_state = 'ai';
    }
    updated.audit.unshift({ at: new Date().toISOString(), actor: this.session.display_name, action: `DEMO_${kind.toUpperCase()}`, summary: 'Thao tác giả lập; không kết nối máy in/Zalo/thanh toán thật.' });
    this.orders[index] = updated;
    this.handled.set(key, { signature, order: structuredClone(updated) });
    return structuredClone(updated);
  }
  async mode(): Promise<OperationMode> { return 'simulation'; }
}
export const makePort = (): PrintPort => isDemo() ? new DemoPrintPort() : new HttpPrintPort(import.meta.env.VITE_API_BASE_URL ?? '');
export const snapshotFromPort = async (port: PrintPort): Promise<Snapshot> => {
  const [session, orders, mode] = await Promise.all([port.me(), port.listOrders(), port.mode()]);
  return { session, orders, mode };
};