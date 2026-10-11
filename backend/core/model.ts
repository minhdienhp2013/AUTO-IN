import { createHash, randomUUID } from 'node:crypto';

export type Role = 'owner' | 'staff' | 'customer' | 'processor' | 'print_agent';
export type Mode = 'simulation' | 'controlled_test' | 'production' | 'safe';
export type JobState = 'NOT_SENT' | 'SENDING' | 'SENT_UNVERIFIED' | 'UNKNOWN' | 'VERIFIED_DONE' | 'SIMULATED_DONE';
export interface Principal { id: string; role: Role; shop_id: string; customer_id?: string; verified: boolean; }
export interface PrintPlan { request_hash: string; physical_sheets: number; document_pages: number; printed_faces: number; ready: boolean; printer_id: string; artifact_ref: string; verified_by: string; }
export interface OrderRow { id: string; shop_id: string; customer_id: string; conversation_id: string | null; active_revision: number; manual_lock: boolean; print_closed: boolean; closed_reason: string | null; delivered_sheets: number; }
export interface RevisionRow { order_id: string; revision: number; request_hash: string; request_data: unknown; plan: PrintPlan | null; }
export interface QuoteRow { order_id: string; quote_revision: number; amount_vnd: number; deposit_required_vnd: number; significant_cost: boolean; }
export interface JobRow { id: string; order_id: string; revision: number; request_hash: string; approval_id: string; printer_id: string; state: JobState; claimed_by: string | null; lease_secret_hash: string | null; lease_until: Date | null; sent_at: Date | null; mode_at_send: Mode | null; cancelled_at?: Date | null; }
export interface SettingsRow { shop_id: string; mode: Mode; printing_enabled: boolean; manual_lock: boolean; holiday_dates: string[]; open_at: string; close_at: string; timezone: string; }
export class DomainError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 422, public readonly retryable = false, public readonly current_revision?: number) { super(message); }
}
export function assertStaff(p: Principal): void { if (!p.verified) throw new DomainError('UNAUTHENTICATED','Phiên chưa xác minh',401); if (p.role !== 'staff' && p.role !== 'owner') throw new DomainError('FORBIDDEN','Không có quyền nhân viên',403); }
export function assertOwner(p: Principal): void { assertStaff(p); if (p.role !== 'owner') throw new DomainError('OWNER_REQUIRED','Chỉ chủ cửa hàng được phê duyệt',403); }
export function assertAgent(p: Principal): void { if (!p.verified || p.role !== 'print_agent') throw new DomainError('AGENT_REQUIRED','Yêu cầu credential agent hợp lệ',403); }
export function assertProcessor(p: Principal): void { if (!p.verified || p.role !== 'processor') throw new DomainError('PROCESSOR_REQUIRED','Yêu cầu credential processor',403); }
export function canAccessShop(p: Principal, shop_id: string): void { if (!p.verified) throw new DomainError('UNAUTHENTICATED','Chưa xác minh',401); if (p.shop_id !== shop_id) throw new DomainError('FORBIDDEN','Không được xem dữ liệu cửa hàng khác',403); }
export function checkRevision(expected: number, actual: number): void { if (!Number.isSafeInteger(expected) || expected !== actual) throw new DomainError('STALE_REVISION','Đơn đã thay đổi, cần tải lại',409,false,actual); }
export function nonNegativeVnd(n: number): void { if (!Number.isSafeInteger(n) || n < 0) throw new DomainError('INVALID_MONEY','Giá trị VND phải là số nguyên không âm'); }
// node-postgres intentionally returns BIGINT / SUM(BIGINT) as text, not number.
// Coerce only values representable without precision loss; never concatenate counters.
export function dbSafeInteger(value: number | string, field: string): number {
 if (typeof value !== 'number' && (typeof value !== 'string' || !/^-?\d+$/.test(value)))
  throw new DomainError('INVALID_DB_INTEGER',`Cột ${field} không phải số nguyên`,500);
 const parsed=typeof value==='number'?value:Number(value);
 if (!Number.isSafeInteger(parsed))
  throw new DomainError('DB_INTEGER_OVERFLOW',`Cột ${field} vượt giới hạn số nguyên an toàn`,500);
 return parsed;
}
export function assertPlan(plan: PrintPlan, hash: string): void {
 if (plan.request_hash !== hash || !plan.ready || !plan.verified_by || !plan.artifact_ref || !plan.printer_id || !Number.isSafeInteger(plan.physical_sheets) || plan.physical_sheets < 1 || !Number.isSafeInteger(plan.document_pages) || plan.document_pages < 1 || !Number.isSafeInteger(plan.printed_faces) || plan.printed_faces < 1) throw new DomainError('UNTRUSTED_PLAN','Thiếu kế hoạch in được processor xác minh');
}
export function canonical(value: unknown): string {
 if (value === null || typeof value !== 'object') return JSON.stringify(value);
 if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
 const obj=value as Record<string,unknown>;
 return '{' + Object.keys(obj).sort().map(k=> JSON.stringify(k)+':'+canonical(obj[k])).join(',') + '}';
}
export function sha(value: string): string { return createHash('sha256').update(value).digest('hex'); }
export function newId(): string { return randomUUID(); }
export function idempotencyHash(p: Principal, action: string, data: unknown): string { return sha(canonical({actor_id:p.id,action,data})); }
export function shortage(required: number, received: number): number { return Math.max(0,required-received); }
export function printingAllowed(settings: SettingsRow, now: Date): boolean {
 if (settings.manual_lock || settings.mode === 'safe') return false;
 if (settings.mode !== 'simulation' && !settings.printing_enabled) return false;
 if (settings.timezone !== 'Asia/Ho_Chi_Minh') return false; // fail closed until configured
 const local = new Intl.DateTimeFormat('en-CA',{timeZone:settings.timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now);
 const part=(k:string)=>local.find(x=>x.type===k)?.value ?? '';
 const date=`${part('year')}-${part('month')}-${part('day')}`;
 const clock=`${part('hour')}:${part('minute')}`;
 return !settings.holiday_dates.includes(date) && clock >= settings.open_at && clock < settings.close_at;
}
