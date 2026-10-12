import { actionPath, depositShortfall, hasValidApprovalInputs, validMoney, type ActionKind, type Mutation, type OrderView, type Snapshot, type StaffSession, type OperationMode, type ConversationState } from './domain.ts';
import { demoOrders, demoSession } from './fixtures.ts';

export class ApiFault extends Error {
  readonly status: number; readonly code: string; readonly currentRevision?: number;
  constructor(status: number, code: string, message: string, currentRevision?: number) { super(message); this.name = 'ApiFault'; this.status = status; this.code = code; this.currentRevision = currentRevision; }
}
export interface PrintPort {
  login(shopId: string, username: string, password: string): Promise<StaffSession>;
  logout(): Promise<void>;
  me(): Promise<StaffSession>;
  listOrders(): Promise<OrderView[]>;
  getOrder(id: string): Promise<OrderView>;
  /** Verified *raster* bytes only; NOT customer confirmation or approval. */
  loadVerifiedPreviewPages(order: Pick<OrderView,'order_id'|'revision'|'request_hash'>): Promise<Blob[]>;
  mutate(order: OrderView, kind: ActionKind, payload: Record<string, string | number | boolean | null>, key: string): Promise<OrderView>;
  mode(): Promise<OperationMode>;
}
export const isDemo = (env: Pick<ImportMetaEnv, 'VITE_DEMO_MODE'> = import.meta.env): boolean => env.VITE_DEMO_MODE !== 'false';
export const newMutationKey = (): string => crypto.randomUUID();
export const makeMutation = (order: OrderView, payload: Record<string, string | number | boolean | null>, key: string): Mutation => ({
  ...payload, expected_revision: order.revision, request_hash: order.request_hash, idempotency_key: key,
});

const knownState = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => typeof value === 'string' && allowed.includes(value as T) ? value as T : fallback;
// PostgreSQL bigint counters may be JSON decimal strings through pg. Convert only
// non-negative safe integers; never coerce floats, signs, exponent notation or unsafe values.
const asNum = (n: unknown): number | null => {
  if (validMoney(n)) return n;
  if (typeof n === 'string' && /^(0|[1-9][0-9]*)$/.test(n)) {
    const value = Number(n);
    return Number.isSafeInteger(value) ? value : null;
  }
  return null;
};
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
    order_id: asString(o.order_id), job_id: typeof o.job_id === 'string' ? o.job_id : null, customer_name: asString(o.customer_name, 'Khách hàng'), conversation_id: typeof o.conversation_id === 'string' ? o.conversation_id : null,
    conversation_generation: asNum(o.conversation_generation), conversation_claimed_by: typeof o.conversation_claimed_by === 'string' ? o.conversation_claimed_by : null,
    revision: asNum(o.revision) ?? 0, request_hash: asString(o.request_hash), quote_revision: asNum(o.quote_revision),
    order_state: knownState(o.order_state, ['draft','awaiting_customer','confirmed','approved','abandoned','closed'] as const, 'draft'),
    conversation_state: knownState(o.conversation_state, ['ai','needs_human','staff'] as const, 'needs_human'),
    print_state: knownState(o.print_state, ['NOT_SENT','SENDING','SENT_UNVERIFIED','UNKNOWN','VERIFIED_DONE','SIMULATED_DONE'] as const, 'UNKNOWN'),
    delivery_state: knownState(o.delivery_state, ['not_ready','quality_check','ready','partial','delivered','exception_closed'] as const, 'not_ready'),
    payment_state: knownState(o.payment_state, ['unpaid','deposit_requested','partial','paid','refund_pending','refunded'] as const, 'unpaid'),
    confirmed_revision: asNum(o.confirmed_revision), confirmed_quote_revision: asNum(o.confirmed_quote_revision),
    amount_vnd: asNum(o.amount_vnd), required_deposit_vnd: asNum(o.required_deposit_vnd) ?? 0, received_vnd: asNum(o.received_vnd) ?? 0,
    large_cost_flag: o.large_cost_flag === true, delivered_sheets: asNum(o.delivered_sheets) ?? 0, total_sheets: asNum(o.total_sheets), verified_sheets: asNum(o.verified_sheets),
    urgent: o.urgent === true, created_at: asString(o.created_at),
    documents, warnings: Array.isArray(o.warnings) ? o.warnings.filter((w): w is string => typeof w === 'string') : [],
    audit: Array.isArray(o.audit) ? o.audit.map((entry) => { const a = asObject(entry); return { at: asString(a.at), actor: asString(a.actor), action: asString(a.action), summary: asString(a.summary) }; }) : [],
    manual_lock: o.manual_lock === true,
  };
}
/** Adapter for the actual AI1 CODE-101 GET /orders response. A list row is only a summary:
 * no proof of customer confirmation, print status, documents or permission is inferred. */
export function mapOrderSummary(raw: unknown): OrderView {
  const r = asObject(raw);
  if (typeof r.id !== 'string' || !Number.isSafeInteger(r.active_revision) || (r.active_revision as number) < 1) {
    throw new ApiFault(503, 'INVALID_ORDER_SUMMARY', 'API danh sách đơn thiếu mã hoặc phiên bản.');
  }
  return mapOrder({
    order_id: r.id, customer_name: `Mã khách: ${asString(r.customer_id, 'chưa rõ')}`,
    conversation_id: r.conversation_id, revision: r.active_revision,
    manual_lock: r.manual_lock, delivered_sheets: r.delivered_sheets,
    order_state: r.print_closed === true ? 'closed' : 'draft', created_at: r.created_at,
    warnings: ['Danh sách chỉ là dữ liệu tổng hợp; mở đơn để tải trạng thái từ server.'],
  });
}
/** AI1 CODE-006 getOrder returns {order,revisions,jobs,quote,received_vnd,
 * current,print_progress,conversation_control}. The server supplies current
 * confirmation/plan/conversation facts, but does NOT expose per-file preview URLs. */
export function mapCoreOrderDetail(raw: unknown): OrderView {
  const data = asObject(raw), row = asObject(data.order);
  const id = asString(row.id), revision = row.active_revision;
  if (!id || !Number.isSafeInteger(revision) || (revision as number) < 1 || !Array.isArray(data.revisions) || !Array.isArray(data.jobs)) {
    throw new ApiFault(503, 'INVALID_ORDER_DETAIL', 'API chi tiết đơn thiếu mã, phiên bản hoặc lịch sử lệnh.');
  }
  const rev = data.revisions.map(asObject).find(v => v.revision === revision);
  if (!rev || typeof rev.request_hash !== 'string' || !rev.request_hash) {
    throw new ApiFault(503, 'INVALID_REVISION', 'Chưa nhận phiên bản và dấu vân tay tài liệu hiện hành.');
  }
  // CODE-301 AI1 read model: only nested `current` is authoritative for the
  // active revision. Never promote a historical confirmation or client flag.
  const current = asObject(data.current), quote = asObject(data.quote);
  const nested = 'current' in data;
  if (nested && (asNum(current.revision) !== revision || current.request_hash !== rev.request_hash)) {
    throw new ApiFault(503, 'INVALID_CURRENT_REVISION', 'Read model hiện hành không khớp phiên bản/hash.');
  }
  const candidate = nested ? asObject(current.verified_plan) : asObject(rev.plan);
  const trustedPlan = candidate.ready === true && candidate.request_hash === rev.request_hash &&
    typeof candidate.verified_by === 'string' && candidate.verified_by.length > 0 &&
    typeof candidate.artifact_ref === 'string' && candidate.artifact_ref.length > 0 &&
    asNum(candidate.physical_sheets) !== null && (asNum(candidate.physical_sheets) ?? 0) > 0;
  const count = trustedPlan ? asNum(candidate.physical_sheets) : null;
  const requestConfirmation = asObject(current.request_confirmation);
  const priceConfirmation = asObject(current.price_confirmation);
  const confirmedRevision = nested && requestConfirmation.revision === revision &&
    requestConfirmation.request_hash === rev.request_hash && requestConfirmation.kind === 'request'
    ? revision : null;
  const quoteRevision = asNum(quote.quote_revision);
  const confirmedQuoteRevision = nested && quoteRevision !== null &&
    priceConfirmation.revision === revision && priceConfirmation.request_hash === rev.request_hash &&
    priceConfirmation.kind === 'quote' && asNum(priceConfirmation.quote_revision) === quoteRevision
    ? quoteRevision : null;
  const needsPrice = count !== null && count > 150 || quote.significant_cost === true;
  const approval = asObject(current.approval);
  const approved = nested && trustedPlan && confirmedRevision === revision &&
    (!needsPrice || confirmedQuoteRevision === quoteRevision && quoteRevision !== null) &&
    approval.revision === revision && approval.request_hash === rev.request_hash &&
    (!needsPrice || asNum(approval.quote_revision) === quoteRevision) &&
    typeof approval.id === 'string' && approval.id.length > 0;

  const latest = data.jobs.map(asObject).filter(j => asNum(j.revision) === revision && (!nested || j.request_hash === rev.request_hash) && !j.cancelled_at);
  const states = latest.map(j => j.state);
  // Ambiguous attempts override all completed ones; no automatic resend.
  const reportedPrintState = latest.length === 0 ? 'NOT_SENT' : states.includes('UNKNOWN') ? 'UNKNOWN' :
    states.includes('SENDING') ? 'SENDING' : states.includes('SENT_UNVERIFIED') ? 'SENT_UNVERIFIED' :
    states.includes('SIMULATED_DONE') ? 'SIMULATED_DONE' :
    states.every(x => x === 'VERIFIED_DONE') ? 'VERIFIED_DONE' :
    states.every(x => x === 'NOT_SENT') ? 'NOT_SENT' : 'UNKNOWN';
  const uncertainJobs = latest.filter(j => j.state === 'SENT_UNVERIFIED' || j.state === 'UNKNOWN');
  const jobId = uncertainJobs.length === 1 && typeof uncertainJobs[0].id === 'string' ? uncertainJobs[0].id : null;
  const progress = asObject(data.print_progress);
  const delivered = asNum(row.delivered_sheets) ?? 0;
  const amount = asNum(quote.amount_vnd), received = asNum(data.received_vnd) ?? 0;
  const realEvidenceJobs = latest.filter(j =>
    ((j.state === 'VERIFIED_DONE' && (j.evidence_kind === 'staff_inspected' || j.evidence_kind === 'device_verified')) ||
     (j.state === 'UNKNOWN' && j.evidence_kind === 'staff_inspected')) &&
    (j.mode_at_send === 'controlled_test' || j.mode_at_send === 'production'));
  const evidenceCounts = realEvidenceJobs.map(j => asNum(j.verified_sheets));
  const knownVerified = evidenceCounts.length > 0 && evidenceCounts.every(n => n !== null);
  const evidenceTotal = knownVerified ? evidenceCounts.reduce<number>((sum, n) => sum + (n ?? 0), 0) : null;
  const safeEvidenceTotal = evidenceTotal !== null && Number.isSafeInteger(evidenceTotal) ? evidenceTotal : null;
  const legacyVerified = safeEvidenceTotal;
  // The nested progress is calculated server-side and can include inspected
  // partial UNKNOWN jobs. Still reject impossible values and simulation-only paper.
  const serverVerified = nested && asNum(progress.planned_sheets) === count
    ? asNum(progress.verified_sheets) : null;
  const verifiedSheets = nested
    ? (safeEvidenceTotal !== null && count !== null && serverVerified !== null &&
       serverVerified <= count && serverVerified <= safeEvidenceTotal ? serverVerified : null)
    : legacyVerified;
  // A job's status alone (or a spooler acknowledgment) is not physical paper.
  // Contradictory/missing evidence can NEVER produce a VERIFIED_DONE label.
  const completeEvidence = count !== null && verifiedSheets !== null && verifiedSheets >= count &&
    delivered <= verifiedSheets && (!nested ||
      (progress.fully_verified === true && progress.requires_manual_reconciliation === false));
  const print_state = reportedPrintState === 'VERIFIED_DONE' && !completeEvidence
    ? 'UNKNOWN' : reportedPrintState;
  const physicallyComplete = print_state === 'VERIFIED_DONE' && completeEvidence;
  const control = asObject(data.conversation_control);
  const controlStatus = control.status === 'AI' ? 'ai' : control.status === 'HUMAN' ? 'staff' : 'needs_human';
  const controlGeneration = (control.status === 'AI' || control.status === 'HUMAN') && row.conversation_id
    ? asNum(control.generation) : null;
  const warnings = [
    'Chưa có danh sách file/URL preview được cấp quyền: không thể duyệt chỉ bằng kế hoạch tổng hợp.',
    ...(latest.some(j => j.state === 'UNKNOWN') ? ['Có lệnh UNKNOWN, cần đối soát; không tự gửi lại.'] : []),
    ...(reportedPrintState === 'VERIFIED_DONE' && !completeEvidence ? ['Trạng thái in hoàn tất không khớp bằng chứng giấy thật; cần đối soát, không đánh dấu in/giao đủ.'] : []),
  ];
  if (!trustedPlan) warnings.push('Kế hoạch in chưa có bằng chứng processor đáng tin.');
  if (nested && current.preview_ref && !candidate.preview_verified) warnings.push('Preview chưa được processor xác minh.');
  if (nested && !confirmedRevision) warnings.push('Chưa có xác nhận yêu cầu đúng phiên bản/hash.');
  if (nested && needsPrice && !confirmedQuoteRevision) warnings.push('Đơn lớn/chi phí đáng kể chưa có xác nhận giá đúng phiên bản.');
  const normalized = mapOrder({
    order_id: id, job_id: jobId, customer_name: `Mã khách: ${asString(row.customer_id, 'chưa rõ')}`,
    conversation_id: row.conversation_id,
    conversation_generation: controlGeneration,
    conversation_claimed_by: controlStatus === 'staff' && typeof control.claimed_by === 'string' ? control.claimed_by : null,
    conversation_state: controlStatus,
    revision, request_hash: rev.request_hash,
    confirmed_revision: confirmedRevision, confirmed_quote_revision: confirmedQuoteRevision,
    quote_revision: quoteRevision, amount_vnd: amount,
    required_deposit_vnd: quote.deposit_required_vnd, received_vnd: received,
    large_cost_flag: quote.significant_cost === true,
    manual_lock: row.manual_lock === true || row.print_closed === true,
    order_state: row.print_closed === true ? 'closed' : approved || latest.length > 0 ? 'approved' : confirmedRevision !== null ? 'confirmed' : 'draft',
    print_state, total_sheets: count, verified_sheets: verifiedSheets, delivered_sheets: delivered,
    delivery_state: physicallyComplete && delivered >= count! ? 'delivered' :
      delivered > 0 ? 'partial' : physicallyComplete ? 'quality_check' : 'not_ready',
    payment_state: amount !== null && received >= amount ? 'paid' : received > 0 ? 'partial' : 'unpaid',
    created_at: row.created_at, warnings, documents: [],
  });
  return normalized;
}
const unwrap = (payload: unknown, key: 'order' | 'orders' | 'session'): unknown => {
  const obj = asObject(payload);
  if (key in obj) return obj[key];
  // AI0 may add an envelope during contract integration; fail visibly if it differs.
  return payload;
};
export class HttpPrintPort implements PrintPort {
  private readonly baseUrl: string; private readonly fetcher: typeof fetch;
  // Backend AI1 has bearer sessions, NOT browser cookie sessions. No persistence,
  // no localStorage and no token in URL: refreshing requires a fresh login.
  private token: string | null = null;
  constructor(baseUrl = '', fetcher: typeof fetch = globalThis.fetch.bind(globalThis)) { this.baseUrl = baseUrl; this.fetcher = fetcher; }
  private async call(path: string, options: RequestInit = {}): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}${path}`, {
        ...options, credentials: 'same-origin', cache: 'no-store',
        headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}),
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}), ...options.headers },
      });
    } catch { throw new ApiFault(0, 'NETWORK', 'Mất kết nối API. Không tự xác nhận kết quả; tải lại để đối soát.'); }
    let json: unknown = null;
    try { json = await response.json(); } catch { if (response.ok) throw new ApiFault(503, 'BAD_RESPONSE', 'API trả dữ liệu không đọc được.'); }
    if (!response.ok) {
      const e = asObject(asObject(json).error);
      const defaults: Record<number, string> = { 401: 'Hết phiên đăng nhập. Vui lòng đăng nhập lại.', 403: 'Tài khoản không có quyền thực hiện.', 409: 'Phiên bản đã thay đổi. Tải lại đơn trước khi thao tác.', 422: 'Dữ liệu nghiệp vụ chưa hợp lệ.', 503: 'Chức năng chưa sẵn sàng.' };
      if (response.status === 401) this.token = null;
      throw new ApiFault(response.status, asString(e.code, `HTTP_${response.status}`), asString(e.message, defaults[response.status] ?? 'API không xử lý được yêu cầu.'), asNum(e.current_revision) ?? undefined);
    }
    return json;
  }
  private session(raw: unknown): StaffSession {
    const o = asObject(raw);
    if (!asString(o.id) || !asString(o.shop_id) || o.verified !== true || !['staff', 'owner'].includes(String(o.role))) {
      throw new ApiFault(503, 'INVALID_SESSION', 'API chưa trả tài khoản nhân viên/chủ đã xác minh.');
    }
    return { actor_id: asString(o.id), display_name: `${o.role === 'owner' ? 'Chủ' : 'Nhân viên'} · ${asString(o.id).slice(0,8)}`,
      role: o.role as StaffSession['role'], can_approve: true, can_manage_schedule: o.role === 'owner' };
  }
  async login(shopId: string, username: string, password: string): Promise<StaffSession> {
    this.token = null;
    const result = asObject(await this.call('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ shop_id: shopId, username, password }) }));
    if (typeof result.token !== 'string' || !result.token || !result.principal) throw new ApiFault(503,'INVALID_LOGIN','API chưa cấp phiên xác minh.');
    this.token = result.token;
    try { return await this.me(); } catch(e) { this.token = null; throw e; }
  }
  async logout() { try { if(this.token) await this.call('/api/v1/auth/logout', { method: 'POST' }); } finally { this.token = null; } }
  async me(): Promise<StaffSession> {
    if (!this.token) throw new ApiFault(401, 'UNAUTHENTICATED', 'Vui lòng đăng nhập để xem đơn.');
    return this.session(asObject(await this.call('/api/v1/auth/me')).principal);
  }
  async listOrders() {
    const raw = asObject(await this.call('/api/v1/orders')).orders;
    if (!Array.isArray(raw)) throw new ApiFault(503, 'INVALID_ORDERS', 'Danh sách đơn từ API chưa đúng hợp đồng.');
    return raw.map(mapOrderSummary);
  }
  async getOrder(id: string) {
    const raw = await this.call(`/api/v1/orders/${encodeURIComponent(id)}`);
    return mapCoreOrderDetail(raw);
  }
  async loadVerifiedPreviewPages(order: Pick<OrderView,'order_id'|'revision'|'request_hash'>): Promise<Blob[]> {
    const {order_id,revision,request_hash}=order;
    if (!this.token || !/^[0-9a-f-]{36}$/i.test(order_id) ||
        !Number.isSafeInteger(revision) || revision < 1 ||
        !/^[0-9a-f]{64}$/.test(request_hash))
      throw new ApiFault(409,'PREVIEW_UNVERIFIED','Không xác minh được phiên bản và hash để xem trước.');
    const root=`/api/v1/orders/${order_id}/revisions/${revision}/previews`;
    const catalog=asObject(await this.call(root));
    const entries=catalog.previews;
    if (catalog.preview_verified!==true || catalog.order_id!==order_id ||
        catalog.revision!==revision || catalog.request_hash!==request_hash ||
        !Number.isSafeInteger(catalog.preview_count) ||
        (catalog.preview_count as number)<1 || (catalog.preview_count as number)>15 ||
        !Array.isArray(entries) || entries.length!==catalog.preview_count)
      throw new ApiFault(409,'PREVIEW_UNVERIFIED','Danh sách ảnh xem trước không khớp phiên bản hiện tại.');
    const token=this.token;
    const pages:Blob[]=[];
    const signature=[137,80,78,71,13,10,26,10];
    for(let index=0;index<entries.length;index++) {
      const entry=asObject(entries[index]);
      const exactUrl=`${root}/${index}`;
      if(entry.index!==index || entry.url!==exactUrl || entry.content_type!=='image/png')
        throw new ApiFault(409,'PREVIEW_UNVERIFIED','Đường dẫn ảnh xem trước không hợp lệ.');
      let response:Response;
      try {
        response=await this.fetcher(this.baseUrl+exactUrl,{
          method:'GET',credentials:'same-origin',cache:'no-store',
          headers:{Authorization:'Bearer '+token,Accept:'image/png'}
        });
      } catch {
        throw new ApiFault(0,'PREVIEW_NETWORK','Không tải được ảnh xác minh; cần kiểm tra lại.');
      }
      if(!response.ok || response.headers.get('content-type')?.split(';')[0]?.trim()!=='image/png')
        throw new ApiFault(response.status,'PREVIEW_UNAVAILABLE','Ảnh xem trước không còn hợp lệ; cần đối chiếu bản gốc.');
      const claimed=Number(response.headers.get('content-length'));
      if(claimed>8*1024*1024)
        throw new ApiFault(409,'PREVIEW_TOO_LARGE','Ảnh xem trước vượt giới hạn.');
      const buffer=await response.arrayBuffer();
      const bytes=new Uint8Array(buffer);
      if(bytes.length<8 || bytes.length>8*1024*1024 ||
          !signature.every((value,n)=>bytes[n]===value))
        throw new ApiFault(409,'PREVIEW_INVALID_PNG','Nội dung ảnh xem trước không được xác minh.');
      pages.push(new Blob([buffer],{type:'image/png'}));
    }
    if(this.token!==token)
      throw new ApiFault(401,'PREVIEW_SESSION_CHANGED','Phiên đã thay đổi trong lúc tải xem trước.');
    return pages;
  }
  async mutate(order: OrderView, kind: ActionKind, payload: Record<string, string | number | boolean | null>, key: string): Promise<OrderView> {
    // AI1 CODE-201 routes now exist, but they require current generation from a
    // verified read model. No value supplied => fail closed, no request sent.
    if (kind === 'handover' || kind === 'return_to_ai') {
      if (order.conversation_generation === null || !order.conversation_id) throw new ApiFault(503, 'GENERATION_UNVERIFIED', 'Chưa có generation hội thoại do máy chủ xác minh, không được tiếp quản/trả AI.');
      const response = asObject(await this.call(actionPath(order,kind), {method:'POST',
        body:JSON.stringify({expected_generation:order.conversation_generation,idempotency_key:key}),
        headers:{'Idempotency-Key':key}}));
      const expectedState = kind === 'handover' ? 'HUMAN' : 'AI';
      if (response.conversation_id !== order.conversation_id || response.status !== expectedState ||
          !Number.isSafeInteger(response.generation) || (response.generation as number) <= order.conversation_generation) {
        throw new ApiFault(503,'INVALID_CONVERSATION_RECEIPT','Biên nhận hội thoại không xác minh thay đổi generation; cần đối soát.');
      }
      // Only server receipt, not browser assumptions, changes the conversation axis.
      const conversation_state: ConversationState = kind === 'handover' ? 'staff' : 'ai';
      return {...order, conversation_generation:response.generation as number,
        conversation_claimed_by:typeof response.claimed_by === 'string'?response.claimed_by:null,
        conversation_state};
    }
    const body = makeMutation(order, payload, key);
    const raw = await this.call(actionPath(order, kind), { method: 'POST', body: JSON.stringify(body), headers: { 'Idempotency-Key': key } });
    const receipt = asObject(raw);
    if (kind !== 'payment' && kind !== 'verify_paper' && receipt.order_id !== order.order_id) throw new ApiFault(503, 'INVALID_MUTATION_RECEIPT', 'API thiếu mã đơn trong biên nhận; cần đối soát.');
    if (kind === 'verify_paper') {
      // AI1 returns UNKNOWN when staff inspected *part* of a real job.
      // UNKNOWN is NEVER a completed print, but the confirmed sheets matter.
      const sheets = asNum(receipt.verified_sheets), requested = asNum(payload.physical_sheets);
      if (receipt.job_id !== order.job_id ||
          (receipt.state !== 'VERIFIED_DONE' && receipt.state !== 'UNKNOWN') ||
          sheets === null || requested === null || sheets !== requested ||
          asNum(receipt.planned_sheets) === null || sheets > (asNum(receipt.planned_sheets) ?? 0)) {
        throw new ApiFault(503, 'INVALID_MUTATION_RECEIPT', 'Biên nhận kiểm giấy không đủ bằng chứng hoặc không khớp job/số tờ; phải đối soát.');
      }
      const fresh = await this.getOrder(order.order_id);
      if (fresh.print_state !== receipt.state || fresh.verified_sheets === null ||
          fresh.verified_sheets < sheets) {
        throw new ApiFault(503, 'PAPER_READMODEL_MISMATCH', 'Đọc lại đơn chưa khớp giấy đã kiểm chứng; phải đối soát.');
      }
      return fresh;
    }
    // A 2xx receipt is NOT an order snapshot; always re-read the server.
    return this.getOrder(order.order_id);
  }
  async mode(): Promise<OperationMode> {
    // No public mode route in AI1: do not present simulated/production as fact.
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
  async login(_shopId: string, username: string, _password: string) {
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
  async loadVerifiedPreviewPages(): Promise<Blob[]> {
    // Demo images cannot be used as verified processor proof.
    return [];
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
    if (kind === 'verify_paper') throw new ApiFault(503,'DEMO_ONLY','Không thể dùng demo làm bằng chứng đã in giấy thật.');
    if (kind === 'approve') {
      if (!hasValidApprovalInputs(updated)) throw new ApiFault(422, 'NEEDS_CONFIRMATION', 'Chưa đủ điều kiện duyệt phiên bản/preview/giá.');
      if (depositShortfall(updated) > 0 && body.acknowledge_deposit_shortage !== true) throw new ApiFault(422, 'DEPOSIT_ACK', 'Phải đọc cảnh báo cọc thiếu.');
      updated.order_state = 'approved';
    } else if (kind === 'quote') {
      if (!validMoney(body.amount_vnd) || !validMoney(body.deposit_required_vnd) || typeof body.significant_cost !== 'boolean') throw new ApiFault(422, 'INVALID_AMOUNT', 'Giá, mức cọc và đánh dấu chi phí phải hợp lệ.');
      updated.required_deposit_vnd = body.deposit_required_vnd; updated.large_cost_flag = body.significant_cost;
      updated.amount_vnd = body.amount_vnd;
      updated.quote_revision = (updated.quote_revision ?? 0) + 1;
      updated.confirmed_quote_revision = null;
    } else if (kind === 'payment') {
      if (!validMoney(body.amount_vnd) || body.amount_vnd === 0 || !['cash','bank_transfer'].includes(String(body.method))) throw new ApiFault(422, 'INVALID_PAYMENT', 'Nhập số tiền nhận thực tế và phương thức.');
      updated.received_vnd += body.amount_vnd;
      updated.payment_state = updated.amount_vnd !== null && updated.received_vnd >= updated.amount_vnd ? 'paid' : 'partial';
    } else if (kind === 'delivery') {
      if (updated.print_state !== 'VERIFIED_DONE') throw new ApiFault(422, 'NOT_VERIFIED', 'Không ghi giao giấy thật từ tác vụ chưa xác minh.');
      if (!validMoney(body.physical_sheets) || body.physical_sheets === 0 || updated.total_sheets === null || updated.delivered_sheets + body.physical_sheets > updated.total_sheets) throw new ApiFault(422, 'INVALID_SHEETS', 'Số tờ giao không hợp lệ.');
      updated.delivered_sheets += body.physical_sheets;
      updated.delivery_state = updated.delivered_sheets === updated.total_sheets ? 'delivered' : 'partial';
    } else if (kind === 'manual') {
      if (updated.print_state !== 'NOT_SENT') throw new ApiFault(422, 'PRINT_UNCERTAIN', 'Lệnh đã hoặc có thể đã gửi; phải đối soát trước.');
      if (!String(body.reason ?? '').trim()) throw new ApiFault(422, 'REASON_REQUIRED', 'Cần lý do xử lý thủ công.');
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
  const session = await port.me();
  const [orders, mode] = await Promise.all([port.listOrders(), port.mode()]);
  return { session, orders, mode };
};