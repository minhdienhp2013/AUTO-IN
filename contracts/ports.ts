import type { FastifyRequest } from 'fastify';
import type { AuthPrincipal, Manifest, OrderRecord, JobRecord, RuntimeMode, WireInput } from './schemas.js';

/** Supplied by AI1: authenticate a session/scoped credential; never accept role/actor headers. */
export interface AuthPort { authenticate(request: FastifyRequest): Promise<AuthPrincipal | null> }
export interface OperationContext {
  principal: AuthPrincipal | null; mode: RuntimeMode; params: Readonly<Record<string, string>>;
  input: unknown;
  /** Only login/logout handlers receive this transport hook; AI1 sets secure cookie policy. */
  setSessionCookie?: (cookie: string) => void;
}
/** Each handler must enforce row-level access, revision, idempotency and business rules in PostgreSQL. */
export type OperationHandler = (context: OperationContext) => Promise<unknown>;
export type Handlers = Readonly<Record<string, OperationHandler>>;
export interface AtomicRepositoryPort {
  getOrder(orderId: string, principal: AuthPrincipal): Promise<OrderRecord>;
  /** Transaction compares current revision/hash/approval/quote/lease, locks, schedule, mode,
   * printer binding and NOT_SENT state, then persists SENDING + one-use authorization.
   * Same idempotency payload replays; different payload ->409. Lease expiry never rewinds SENDING.
   */
  markSending(jobId: string, input: WireInput<'JobActionRequest'>, principal: AuthPrincipal): Promise<WireInput<'SendingResponse'>>;
}
export interface DocumentProcessorPort {
  process(document: Manifest['documents'][number]): Promise<
    { status: 'READY'; document_pages: number; printed_faces: number; physical_sheets: number; preview_ref: string; renderer: string; renderer_version: string } |
    { status: 'NEEDS_HUMAN'; reason: string }
  >;
}
export interface PrinterDriverPort {
  /** AI3 must durably journal intent before invoking driver. Authorization is for this exact job;
   * never retry a side effect after crash/unknown, including expired lease. Real mode requires verified adapter.
   */
  send(job: JobRecord, authorization: WireInput<'SendingResponse'>): Promise<WireInput<'ReportRequest'>>;
}
export interface ZaloPort {
  /** AI2 verifies raw provider signature before normalization/storage; no guessed provider algorithm. */
  verifyAndNormalize(rawBody: Uint8Array, headers: Readonly<Record<string, string>>): Promise<{
    event_id: string; conversation_id: string; customer_id: string; received_at: string; text?: string; document_refs: string[];
  }>;
  /** Check generation, pause/human ownership, effective schedule and OA limits immediately before send. */
  sendIfAllowed(input: { conversation_id: string; generation: number; text: string; idempotency_key: string }): Promise<'SENT' | 'BLOCKED'>;
}
export interface IntentInterpreterPort {
  /** Suggestions only. No print approval, money receipt or invented page/price values. */
  interpret(input: { text: string; conversation_id: string }): Promise<{ intent: 'PRINT' | 'OTHER' | 'NEEDS_HUMAN'; missing_fields: string[]; tokens: number }>;
}
export class ContractError extends Error {
  constructor(public readonly status: 401 | 403 | 409 | 422 | 503, public readonly code: string,
    message: string, public readonly retryable = false, public readonly current_revision?: number) { super(message); }
}
