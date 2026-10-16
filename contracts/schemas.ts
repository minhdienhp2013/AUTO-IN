import { Type as T, type Static, type TSchema } from '@sinclair/typebox';
const object = <P extends Record<string, TSchema>>(p: P) => T.Object(p, { additionalProperties: false });
const enumeration = <V extends string>(values: V[]) => T.Union(values.map(v => T.Literal(v)));
export const Id = T.String({ minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]*$' });
export const Hash = T.String({ pattern: '^[a-f0-9]{64}$' });
export const Revision = T.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
export const Count = T.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const Money = Count;
export const Timestamp = T.String({ format: 'date-time', pattern: 'Z$' });
export const Mode = enumeration(['simulation', 'controlled_test', 'production', 'safe']);
export const JobState = enumeration(['NOT_SENT', 'SENDING', 'SENT_UNVERIFIED', 'UNKNOWN', 'VERIFIED_DONE', 'SIMULATED_DONE']);
export const Role = enumeration(['owner', 'staff', 'customer', 'agent']);
export const Principal = object({ actor_id: Id, role: Role, permissions: T.Array(T.String({ minLength: 1 })),
  customer_id: T.Optional(Id), verified_channel_id: T.Optional(Id), agent_id: T.Optional(Id), printer_ids: T.Optional(T.Array(Id)) });
export const Settings = object({ printer_id: Id, paper: enumeration(['A4', 'A3']), orientation: enumeration(['portrait', 'landscape']),
  copies: T.Integer({ minimum: 1, maximum: 10000 }), sides: enumeration(['simplex', 'duplex']),
  flip_edge: enumeration(['long', 'short']), scaling: T.Literal('shrink_to_fit'), color: enumeration(['monochrome', 'manual_color']),
  page_ranges: T.Array(object({ from: Revision, to: Revision }), { minItems: 1 }),
  separate_files: T.Literal(true), separate_copies: T.Literal(true) });
export const Document = object({ document_id: Id, original_sha256: Hash, format: enumeration(['pdf', 'word', 'image', 'manual']), settings: Settings });
export const RequestManifest = object({ documents: T.Array(Document, { minItems: 1 }),
  exact_text: T.Optional(T.String()), layout: T.Optional(object({ font_family: T.String({ minLength: 1 }), font_size: T.Number({ exclusiveMinimum: 0 }) })) });
const mutation = { expected_revision: Revision, idempotency_key: T.String({ minLength: 1, maxLength: 128 }) };
const binding = { revision: Revision, request_hash: Hash };
export const Counts = object({ document_pages: Count, printed_faces: Count, physical_sheets: Count });
export const Quote = object({ quote_revision: Revision, amount_vnd: Money, deposit_requested_vnd: Money,
  significant_cost: T.Boolean(), entered_by: Id, entered_at: Timestamp });
export const Confirmation = object({ confirmation_id: Id, ...binding, customer_id: Id, verified_channel_id: Id,
  quote_revision: T.Optional(Revision), confirmed_at: Timestamp });
export const Approval = object({ approval_id: Id, ...binding, quote_revision: T.Optional(Revision), actor_id: Id,
  approved_at: Timestamp, deposit_shortfall_vnd: Money, deposit_warning_acknowledged: T.Boolean() });
export const StateAxes = object({
  conversation: enumeration(['AI', 'NEEDS_HUMAN', 'HUMAN', 'PAUSED', 'OUT_OF_HOURS']),
  order: enumeration(['DRAFT', 'AWAITING_CONFIRMATION', 'CONFIRMED', 'APPROVED', 'ABANDONED']),
  print: enumeration(['OPEN', 'MANUAL', 'CLOSED', 'EXCEPTION_CLOSED']),
  delivery: enumeration(['AWAITING_CHECK', 'READY', 'PARTIAL', 'DELIVERED', 'UNCLAIMED']),
  payment: enumeration(['UNPAID', 'PARTIAL', 'PAID', 'OVERPAID', 'REFUND_PENDING', 'REFUND_APPROVED', 'REFUNDED']) });
export const Order = object({ order_id: Id, customer_id: Id, conversation_id: Id, active_revision: Revision, request_hash: Hash,
  manifest: RequestManifest, mode: Mode, states: StateAxes, counts: T.Optional(Counts), quote: T.Optional(Quote),
  confirmation: T.Optional(Confirmation), approval: T.Optional(Approval), outstanding_vnd: Money,
  refund_due_vnd: Money, delivered_sheets: Count, undelivered_sheets: Count, manual_locked: T.Boolean(), updated_at: Timestamp });
export const Evidence = T.Union([
  object({ evidence_kind: T.Literal('simulated'), journal_id: Id, observed_at: Timestamp }),
  object({ evidence_kind: T.Literal('spooler'), journal_id: Id, spooler_id: Id, observed_at: Timestamp }),
  object({ evidence_kind: T.Literal('ambiguous'), journal_id: Id, reason: T.String({ minLength: 1 }), observed_at: Timestamp }),
  object({ evidence_kind: T.Literal('staff_verified'), journal_id: Id, actor_id: Id, verified_sheets: Count, observed_at: Timestamp }),
  object({ evidence_kind: T.Literal('device_verified'), journal_id: Id, device_evidence_ref: Id, verified_sheets: Count, observed_at: Timestamp })
]);
export const PrintJob = object({ job_id: Id, order_id: Id, ...binding, approval_id: Id, printer_id: Id,
  mode: Mode, state: JobState, counts: Counts, manifest: RequestManifest,
  lease: T.Optional(object({ lease_id: Id, agent_id: Id, expires_at: Timestamp })), evidence: T.Optional(Evidence) });
// Structural state/evidence constraints are exported for TS, Python and OpenAPI alike.
Object.assign(PrintJob, { allOf: [
  { if: { properties: { state: { const: 'SIMULATED_DONE' } }, required: ['state'] }, then: { required: ['evidence'], properties: { mode: { const: 'simulation' }, evidence: { properties: { evidence_kind: { const: 'simulated' } } } } } },
  { if: { properties: { state: { const: 'VERIFIED_DONE' } }, required: ['state'] }, then: { required: ['evidence'], properties: { mode: { enum: ['controlled_test', 'production'] }, evidence: { properties: { evidence_kind: { enum: ['staff_verified', 'device_verified'] } } } } } },
  { if: { properties: { state: { enum: ['NOT_SENT', 'SENDING'] } }, required: ['state'] }, then: { not: { required: ['evidence'] } } },
  { if: { properties: { state: { const: 'SENT_UNVERIFIED' } }, required: ['state'] }, then: { required: ['evidence'], properties: { mode: { enum: ['controlled_test', 'production'] }, evidence: { properties: { evidence_kind: { const: 'spooler' } } } } } },
  { if: { properties: { state: { const: 'UNKNOWN' } }, required: ['state'] }, then: { required: ['evidence'], properties: { evidence: { properties: { evidence_kind: { const: 'ambiguous' } } } } } }
] });
Object.assign(Principal, { allOf: [
  { if: { properties: { role: { const: 'customer' } }, required: ['role'] }, then: { required: ['customer_id', 'verified_channel_id'] } },
  { if: { properties: { role: { const: 'agent' } }, required: ['role'] }, then: { required: ['agent_id', 'printer_ids'], properties: { printer_ids: { minItems: 1 } } } }
] });
export const ErrorResponse = object({ error: object({ code: T.String({ minLength: 1 }), message: T.String(), retryable: T.Boolean(), current_revision: T.Optional(Revision) }) });
const HolidayDate = T.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' });
export const ShopSchedule = object({ shop_id: Id, version: Revision,
  open_at: T.String({ pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' }),
  close_at: T.String({ pattern: '^(([01]\\d|2[0-3]):[0-5]\\d|24:00)$' }),
  timezone: T.Literal('Asia/Ho_Chi_Minh'), holiday_dates: T.Array(HolidayDate, { maxItems: 730 }),
  manual_lock: T.Boolean(), operational_guard: object({ mode: Mode, printing_enabled: T.Boolean() }),
  changed: T.Optional(T.Boolean()) });
export const ShopSchedulePatch = object({ expected_version: Revision,
  idempotency_key: T.String({ minLength: 1, maxLength: 128 }),
  open_at: T.Optional(ShopSchedule.properties.open_at), close_at: T.Optional(ShopSchedule.properties.close_at),
  timezone: T.Optional(ShopSchedule.properties.timezone),
  holiday_dates: T.Optional(ShopSchedule.properties.holiday_dates), manual_lock: T.Optional(T.Boolean()) });
export const LoginRequest = object({ username: T.String({ minLength: 1, maxLength: 128 }), password: T.String({ minLength: 1, maxLength: 1024 }) });
export const LoginResponse = object({ authenticated: T.Literal(true), principal: Principal });
export const EmptyRequest = object({});
export const Ack = object({ accepted: T.Literal(true) });
export const CreateOrderRequest = object({ customer_id: Id, conversation_id: Id, manifest: RequestManifest, idempotency_key: mutation.idempotency_key });
export const ReviseOrderRequest = object({ ...mutation, manifest: RequestManifest });
export const ConfirmRequest = object({ ...mutation, request_hash: Hash, quote_revision: T.Optional(Revision) });
export const ApproveRequest = object({ ...mutation, request_hash: Hash, quote_revision: T.Optional(Revision), deposit_warning_acknowledged: T.Boolean() });
export const QuoteRequest = object({ ...mutation, amount_vnd: Money, deposit_requested_vnd: Money, significant_cost: T.Boolean() });
export const PaymentRequest = object({ ...mutation, transaction_id: Id, kind: enumeration(['receipt', 'refund_approval', 'refund_paid']), amount_vnd: Money,
  method: enumeration(['cash', 'bank_transfer']), verification_ref: Id });
export const DeliveryRequest = object({ ...mutation, sheets: Count, quality_checked: T.Literal(true) });
export const ManualRequest = object({ ...mutation, reason: T.String({ minLength: 1 }), action: enumeration(['lock', 'record_result', 'close_exception', 'authorize_reprint']),
  observed_sheets: T.Optional(Count), evidence_ref: T.Optional(Id) });
export const ConversationRequest = object({ ...mutation, reason: T.String({ minLength: 1 }) });
export const ConversationResponse = object({ conversation_id: Id, revision: Revision, generation: Count, state: enumeration(['AI', 'HUMAN']) });
export const ClaimRequest = object({ printer_id: Id, idempotency_key: mutation.idempotency_key });
export const ClaimResponse = object({ job: T.Union([PrintJob, T.Null()]) });
export const JobActionRequest = object({ ...mutation, request_hash: Hash, lease_id: Id });
export const SendingResponse = object({ job_id: Id, revision: Revision, request_hash: Hash, lease_id: Id,
  state: T.Literal('SENDING'), send_authorization_id: Id, authorized_at: Timestamp, mode: Mode });
export const ReportRequest = T.Union([
  object({ ...mutation, request_hash: Hash, lease_id: Id, send_authorization_id: Id, mode: T.Literal('simulation'),
    state: T.Literal('SIMULATED_DONE'), evidence: object({ evidence_kind: T.Literal('simulated'), journal_id: Id, observed_at: Timestamp }) }),
  object({ ...mutation, request_hash: Hash, lease_id: Id, send_authorization_id: Id, mode: enumeration(['controlled_test', 'production']),
    state: T.Literal('SENT_UNVERIFIED'), evidence: object({ evidence_kind: T.Literal('spooler'), journal_id: Id, spooler_id: Id, observed_at: Timestamp }) }),
  object({ ...mutation, request_hash: Hash, lease_id: Id, send_authorization_id: Id, mode: enumeration(['simulation', 'controlled_test', 'production', 'safe']),
    state: T.Literal('UNKNOWN'), evidence: object({ evidence_kind: T.Literal('ambiguous'), journal_id: Id, reason: T.String({ minLength: 1 }), observed_at: Timestamp }) }),
  object({ ...mutation, request_hash: Hash, lease_id: Id, send_authorization_id: Id, mode: enumeration(['controlled_test', 'production']),
    state: T.Literal('VERIFIED_DONE'), evidence: object({ evidence_kind: T.Literal('device_verified'), journal_id: Id, device_evidence_ref: Id, verified_sheets: Count, observed_at: Timestamp }) })
]); // Staff verification is a trusted service action, never an agent-supplied actor_id.
export const OrderList = object({ orders: T.Array(Order) });
export const OrderQuery = object({ customer_id: T.Optional(Id), limit: T.Optional(T.Integer({ minimum: 1, maximum: 100 })), cursor: T.Optional(Id) });
export const schemas = { Id, Hash, Revision, Count, Money, Timestamp, Mode, JobState, Role, Principal, Settings, Document, RequestManifest,
  Counts, Quote, Confirmation, Approval, StateAxes, Order, Evidence, PrintJob, ErrorResponse, LoginRequest, LoginResponse, EmptyRequest, Ack,
  CreateOrderRequest, ReviseOrderRequest, ConfirmRequest, ApproveRequest, QuoteRequest, PaymentRequest, DeliveryRequest, ManualRequest,
  ConversationRequest, ConversationResponse, ClaimRequest, ClaimResponse, JobActionRequest, SendingResponse, ReportRequest, OrderList, OrderQuery,
  ShopSchedule, ShopSchedulePatch };
export type SchemaName = keyof typeof schemas;
export type AuthPrincipal = Static<typeof Principal>;
export type Manifest = Static<typeof RequestManifest>;
export type OrderRecord = Static<typeof Order>;
export type JobRecord = Static<typeof PrintJob>;
export type RuntimeMode = Static<typeof Mode>;
export type WireInput<N extends SchemaName> = Static<(typeof schemas)[N]>;
