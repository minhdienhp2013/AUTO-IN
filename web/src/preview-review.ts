import type { OrderView, StaffSession, VerifiedFileFact } from './domain.ts';
import { canApproveAfterInboundReview, canEditPrintRequest, hasClearPendingInbound, hasCurrentPreviewReceipt } from './code008.ts';
import { routeVerifiedDocument } from './v1-routing.ts';

export interface CurrentPrintEvidence {
  schema: 'ai0.print_evidence.v1';
  order_id: string;
  revision: number;
  request_hash: string;
  evidence_sha256: string;
}

export type PreviewReviewStatus = 'unavailable' | 'missing' | 'matching' | 'stale';
export interface CurrentPreviewReview {
  status: PreviewReviewStatus;
  order_id?: string;
  revision?: number;
  request_hash?: string;
  evidence_sha256?: string;
  reviewer_id?: string;
  reviewed_at?: string;
  receipt_id?: string;
}

export interface PreviewReviewReadModel {
  print_evidence: CurrentPrintEvidence | null;
  preview_review: CurrentPreviewReview;
}

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
const digest = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const positiveInt = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const exactScope = (raw: Record<string, unknown>, order: Pick<OrderView, 'order_id'|'revision'|'request_hash'>,
  evidenceSha: string): boolean => raw.order_id === order.order_id && raw.revision === order.revision &&
    raw.request_hash === order.request_hash && raw.evidence_sha256 === evidenceSha;

/** Parse only the authenticated, active read model. Client values never create evidence or a receipt. */
export function parsePreviewReviewReadModel(currentValue: unknown,
  order: Pick<OrderView, 'order_id'|'revision'|'request_hash'>): PreviewReviewReadModel {
  const current = object(currentValue);
  const unavailable: PreviewReviewReadModel = { print_evidence: null, preview_review: { status: 'unavailable' } };
  if (current.revision !== order.revision || current.request_hash !== order.request_hash) return unavailable;
  const evidence = object(current.print_evidence);
  if (evidence.schema !== 'ai0.print_evidence.v1' || evidence.order_id !== order.order_id ||
      evidence.revision !== order.revision || evidence.request_hash !== order.request_hash ||
      !digest(evidence.evidence_sha256)) return unavailable;
  const print_evidence: CurrentPrintEvidence = {
    schema: 'ai0.print_evidence.v1', order_id: order.order_id, revision: order.revision,
    request_hash: order.request_hash, evidence_sha256: evidence.evidence_sha256,
  };
  const rawReview = object(current.preview_review);
  const base = { print_evidence, preview_review: { status: 'unavailable' as const } };
  if (!['missing', 'matching', 'stale'].includes(String(rawReview.status))) return base;
  if (rawReview.status === 'stale') {
    if (rawReview.order_id !== order.order_id || !positiveInt(rawReview.revision) ||
        typeof rawReview.request_hash !== 'string' || !rawReview.request_hash || !digest(rawReview.evidence_sha256)) return base;
    return { print_evidence, preview_review: {
      status: 'stale', order_id: order.order_id, revision: rawReview.revision,
      request_hash: rawReview.request_hash, evidence_sha256: rawReview.evidence_sha256,
      ...(typeof rawReview.reviewer_id === 'string' ? { reviewer_id: rawReview.reviewer_id } : {}),
      ...(typeof rawReview.reviewed_at === 'string' ? { reviewed_at: rawReview.reviewed_at } : {}),
      ...(typeof rawReview.receipt_id === 'string' ? { receipt_id: rawReview.receipt_id } : {}),
    } };
  }
  if (!exactScope(rawReview, order, print_evidence.evidence_sha256)) {
    return rawReview.status === 'matching' && rawReview.order_id === order.order_id
      ? { print_evidence, preview_review: { status: 'stale', order_id: order.order_id,
          ...(positiveInt(rawReview.revision) ? { revision: rawReview.revision } : {}),
          ...(typeof rawReview.request_hash === 'string' ? { request_hash: rawReview.request_hash } : {}),
          ...(digest(rawReview.evidence_sha256) ? { evidence_sha256: rawReview.evidence_sha256 } : {}) } }
      : base;
  }
  return { print_evidence, preview_review: {
    status: rawReview.status as 'missing'|'matching', order_id: order.order_id,
    revision: order.revision, request_hash: order.request_hash,
    evidence_sha256: print_evidence.evidence_sha256,
    ...(typeof rawReview.reviewer_id === 'string' ? { reviewer_id: rawReview.reviewer_id } : {}),
    ...(typeof rawReview.reviewed_at === 'string' ? { reviewed_at: rawReview.reviewed_at } : {}),
    ...(typeof rawReview.receipt_id === 'string' ? { receipt_id: rawReview.receipt_id } : {}),
  } };
}

export type PreviewReviewBlock = 'allowed'|'unauthenticated'|'permission'|'api'|'evidence'|'preview'|'manual_hold'|'already_reviewed'|'acknowledgement'|'busy';
export function previewReviewBlock(input: {
  order: OrderView;
  staff: StaffSession | null;
  apiHealthy: boolean;
  simulation: boolean;
  previewVerified: boolean;
  previewPages: number;
  previewFiles: readonly VerifiedFileFact[];
  checked: boolean;
  busy: boolean;
}): PreviewReviewBlock {
  const { order, staff } = input;
  if (!staff || !staff.actor_id || !['staff', 'owner'].includes(staff.role)) return 'unauthenticated';
  if (!staff.can_approve) return 'permission';
  if (input.simulation || !input.apiHealthy || order.detail_loaded !== true) return 'api';
  if (!order.print_evidence || order.print_evidence.schema !== 'ai0.print_evidence.v1' ||
      order.print_evidence.order_id !== order.order_id || order.print_evidence.revision !== order.revision ||
      order.print_evidence.request_hash !== order.request_hash || !digest(order.print_evidence.evidence_sha256) ||
      !['missing','matching','stale'].includes(String(order.preview_review?.status))) return 'evidence';
  if (!input.previewVerified || input.previewPages < 1 || input.previewFiles.length < 1 ||
      input.previewFiles.some(file => routeVerifiedDocument(file) === 'staff_only')) return 'preview';
  if (!hasClearPendingInbound(order) || order.v1_manual_queue || order.manual_lock ||
      order.print_state !== 'NOT_SENT' || !canEditPrintRequest(order)) return 'manual_hold';
  if (order.preview_review?.status === 'matching') return 'already_reviewed';
  if (!input.checked) return 'acknowledgement';
  if (input.busy) return 'busy';
  return 'allowed';
}

export function previewReviewBlockMessage(reason: PreviewReviewBlock): string {
  const labels: Record<PreviewReviewBlock, string> = {
    allowed: '', unauthenticated: 'Đăng nhập bằng tài khoản nhân viên để kiểm tra preview.',
    permission: 'Tài khoản hiện tại không có quyền kiểm tra preview.',
    api: 'API/chi tiết đơn chưa được xác minh; thao tác đang khóa.',
    evidence: 'Máy chủ chưa cung cấp bằng chứng in hợp lệ cho đúng revision/hash hiện hành.',
    preview: 'Preview hoặc thông số file chưa xác minh đầy đủ; giữ đơn để nhân viên xử lý thủ công.',
    manual_hold: 'Đơn đang bị giữ: cần đối soát tin/file và gỡ trạng thái chuyển nhân viên trước khi ghi nhận kiểm preview.',
    already_reviewed: 'Đã có biên nhận kiểm tra khớp bằng chứng hiện hành.',
    acknowledgement: 'Đánh dấu đã xem các trang preview và thông số in trước khi ghi nhận.',
    busy: 'Đang lưu biên nhận kiểm tra preview…',
  };
  return labels[reason];
}

export type PreviewFlowStep = 'blocked'|'next'|'complete'|'ready'|'separate';
export function previewReviewSequence(order: OrderView): {
  staff_preview: PreviewFlowStep;
  customer_confirmation: PreviewFlowStep;
  staff_approval: PreviewFlowStep;
} {
  const reviewed = hasCurrentPreviewReceipt(order);
  const confirmed = order.confirmed_revision === order.revision;
  const approved = order.order_state === 'approved';
  const reviewStateKnown = ['missing', 'matching', 'stale'].includes(String(order.preview_review?.status));
  return {
    staff_preview: reviewed ? 'complete' : order.print_evidence && reviewStateKnown ? 'next' : 'blocked',
    customer_confirmation: confirmed ? 'complete' : reviewed ? 'next' : 'blocked',
    staff_approval: approved ? 'complete' : canApproveAfterInboundReview(order) ? 'ready' : 'separate',
  };
}

export function previewReviewErrorMessage(code: string, fallback: string): string {
  const messages: Record<string, string> = {
    PREVIEW_REVIEW_STALE: 'Bằng chứng preview đã đổi hoặc receipt đã cũ. Đơn được giữ; tải lại revision/hash và kiểm tra preview hiện hành.',
    PRINT_EVIDENCE_UNAVAILABLE: 'Máy chủ không xác minh được bằng chứng in hiện hành. Giữ đơn, không ghi receipt.',
    PREVIEW_REVIEW_REQUIRED: 'Chưa có receipt kiểm preview khớp revision/hash; giữ đơn, không thể tiếp tục xác nhận hoặc duyệt.',
    PENDING_INBOUND_REVIEW: 'Đơn đang bị giữ vì còn tin/file cần nhân viên đối soát. Chưa ghi receipt kiểm preview.',
    MANUAL_HOLD: 'Đơn đang bị giữ để xử lý thủ công. Chưa ghi receipt kiểm preview.',
    ORDER_PRINT_LOCKED: 'Đơn đã khóa hoặc có lệnh in; giữ nguyên trạng thái và đối soát với nhân viên.',
    FORBIDDEN: 'Tài khoản không có quyền kiểm tra preview.',
    NETWORK: 'Mất kết nối khi lưu receipt; chưa rõ kết quả. Tải lại đơn để đối soát, không tự gửi lại bằng khóa mới.',
  };
  return messages[code] ?? fallback;
}
