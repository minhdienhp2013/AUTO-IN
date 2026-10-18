import React from 'react';

/** Browser projection only. Never accepts source bytes or private storage references. */
export interface WordReviewPreviewV1 {
  schema: 'ai0.word_review_preview.v1';
  shop_id: string;
  order_id: string;
  revision: number;
  request_hash: string;
  source_sha256: string;
  manifest_sha256: string;
  status: 'REVIEW_REQUIRED' | 'NEEDS_HUMAN';
  reason_code?: string;
  pages: readonly { index: number; url: string; content_type: string; sha256: string; bytes: number }[];
  document_pages?: number;
  printed_faces?: number;
  physical_sheets?: number;
  settings?: Readonly<Record<string, string | number | boolean>>;
  ready: false;
  allowed_to_print: false;
  requires_staff_review: true;
  physical_print_verified: false;
}

export interface WordReviewIdentity {
  shopId: string;
  orderId: string;
  revision: number;
  requestHash: string;
  sourceSha256: string;
  manifestSha256: string;
  authenticatedStaff: boolean;
}
export type WordReviewStatus = 'NOT_WIRED' | 'LOADING' | 'MISSING' | 'FAILED' | 'STALE' | 'CURRENT';
export interface WordReviewPanelState { status: WordReviewStatus; projection?: WordReviewPreviewV1; message?: string }
export type PreviewReceiptStatus = 'unavailable' | 'missing' | 'matching' | 'stale';

const digest = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
function appRelativeUrl(value: string): boolean {
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return false;
  try {
    const u = new URL(value, 'https://ui.invalid');
    const rawPath = value.split(/[?#]/, 1)[0];
    const segments = rawPath.split('/').map(segment => decodeURIComponent(segment));
    return u.origin === 'https://ui.invalid' && u.pathname === rawPath && !segments.some(segment => segment === '.' || segment === '..');
  }
  catch { return false; }
}

/** Fail closed unless the authenticated projection matches all active scope and hashes. */
export function currentWordReviewProjection(state: WordReviewPanelState, expected: WordReviewIdentity): WordReviewPreviewV1 | null {
  if (!expected.authenticatedStaff || state.status !== 'CURRENT' || !state.projection) return null;
  const p = state.projection;
  const allowedProjectionKeys = new Set(['schema','shop_id','order_id','revision','request_hash','source_sha256',
    'manifest_sha256','status','reason_code','pages','document_pages','printed_faces','physical_sheets','settings',
    'ready','allowed_to_print','requires_staff_review','physical_print_verified']);
  if (p.schema !== 'ai0.word_review_preview.v1' || p.shop_id !== expected.shopId || p.order_id !== expected.orderId ||
      p.revision !== expected.revision || p.request_hash !== expected.requestHash ||
      !digest(p.request_hash) || !digest(expected.sourceSha256) || p.source_sha256 !== expected.sourceSha256 ||
      !digest(expected.manifestSha256) || p.manifest_sha256 !== expected.manifestSha256 ||
      Object.keys(p).some(key => !allowedProjectionKeys.has(key)) ||
      !['REVIEW_REQUIRED', 'NEEDS_HUMAN'].includes(p.status) || p.ready !== false || p.allowed_to_print !== false ||
      p.requires_staff_review !== true || p.physical_print_verified !== false || !Array.isArray(p.pages) ||
      p.pages.some(page => Object.keys(page).some(key => !['index','url','content_type','sha256','bytes'].includes(key)) ||
        !Number.isSafeInteger(page.index) || page.index < 1 || !appRelativeUrl(page.url) ||
        page.content_type !== 'image/png' || !digest(page.sha256) || !Number.isSafeInteger(page.bytes) || page.bytes <= 0)) return null;
  if (p.status === 'NEEDS_HUMAN' && p.pages.length !== 0) return null;
  return p;
}

const receiptText: Record<PreviewReceiptStatus, string> = {
  unavailable: 'Chưa đọc được biên nhận nhân viên từ máy chủ.',
  missing: 'Chưa có biên nhận nhân viên cho preview hiện hành.',
  matching: 'Máy chủ ghi nhận nhân viên đã xem snapshot hiện hành.',
  stale: 'Biên nhận cũ; cần kiểm tra lại snapshot hiện hành.',
};

export function WordReviewPanel({ identity, state, receipt = 'unavailable' }: {
  identity: WordReviewIdentity; state: WordReviewPanelState; receipt?: PreviewReceiptStatus;
}) {
  const projection = currentWordReviewProjection(state, identity);
  const stale = state.status === 'CURRENT' && !projection;
  const status = stale ? 'STALE' : state.status;
  const waiting = status !== 'CURRENT' || projection?.status !== 'REVIEW_REQUIRED';
  const e = React.createElement;
  const titles: Record<WordReviewStatus, string> = {
    NOT_WIRED: 'Chưa nối API preview Word', LOADING: 'Đang tải preview Word', MISSING: 'Chưa có preview Word hiện hành',
    FAILED: 'Không xác minh được preview Word', STALE: 'Preview Word đã cũ hoặc scope không khớp', CURRENT: 'Nhân viên kiểm tra preview Word',
  };
  const receiptBox = e('div', { className: 'word-review-receipt', 'data-testid': 'word-review-receipt', 'data-receipt-status': receipt },
    e('strong', null, 'Biên nhận xem preview'), e('p', null, receiptText[receipt]),
    e('small', null, 'Biên nhận này tách biệt với thao tác “Duyệt lệnh in”.'));
  const pages = projection && !waiting ? e('div', { className: 'word-review-pages', 'data-testid': 'word-review-pages' },
    ...projection.pages.map(page => e('figure', { key: `${page.index}:${page.sha256}` },
      e('img', { src: page.url, alt: `Preview Word, trang ${page.index}` }),
      e('figcaption', null, `Trang ${page.index} · ${page.bytes} byte · chỉ để nhân viên kiểm tra`)))) : null;
  const body = status === 'NOT_WIRED' ? 'API preview Word chưa được AI0 nối. Giữ đơn để nhân viên xử lý; không dùng preview cũ.'
    : status === 'LOADING' ? 'Đang chờ phản hồi API có staff bearer; preview cũ bị ẩn.'
    : status === 'MISSING' ? 'Máy chủ chưa cấp snapshot của order/revision hiện hành. Giữ đơn và chuyển nhân viên.'
    : status === 'STALE' ? 'Shop, order, revision, request hash hoặc digest không khớp. Preview cũ đã bị ẩn; giữ đơn và chuyển nhân viên.'
    : status === 'FAILED' ? `${state.message ?? 'Lỗi xác thực hoặc mạng (401/409/503).'} Preview cũ đã bị ẩn; giữ đơn và chuyển nhân viên.`
    : projection?.status === 'NEEDS_HUMAN' ? `Worker yêu cầu nhân viên xử lý (${projection.reason_code ?? 'NEEDS_HUMAN'}). Giữ đơn; không có preview được xác minh.`
    : 'Preview chỉ dùng để kiểm tra. Word/DOCX gốc vẫn là nguồn in theo TN-034.';
  return e('section', { className: 'word-review-panel', 'data-testid': 'word-review-panel', 'data-status': status, 'aria-label': 'Preview Word và receipt nhân viên' },
    e('div', { className: 'word-review-heading' }, e('strong', null, titles[status]),
      e('span', { className: 'word-review-required' }, 'REVIEW_REQUIRED · Không phải quyền in')),
    e('p', null, body),
    projection && status === 'CURRENT' && e('dl', { className: 'word-review-source-facts' },
      e('div', null, e('dt', null, 'Order / revision'), e('dd', null, `${projection.order_id} / ${projection.revision}`)),
      e('div', null, e('dt', null, 'Request hash'), e('dd', null, projection.request_hash)),
      e('div', null, e('dt', null, 'Source SHA-256'), e('dd', null, projection.source_sha256)),
      e('div', null, e('dt', null, 'Manifest SHA-256'), e('dd', null, projection.manifest_sha256)),
      e('div', null, e('dt', null, 'ready / allowed_to_print'), e('dd', null, 'false / false'))),
    pages, receiptBox,
    e('p', { className: 'word-review-disclaimer' }, 'Ảnh, CCCD, TEMhoa, màu, Excel và ZIP tiếp tục theo nhãn tuyến do server xác thực; giao diện không phân loại theo tên file. Màn hình này không xác nhận khách, không duyệt lệnh và không gửi lệnh in.'));
}
