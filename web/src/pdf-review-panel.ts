import React from 'react';

export type PdfReviewStatus = 'NOT_WIRED'|'LOADING'|'MISSING'|'FAILED'|'STALE'|'CURRENT';
export interface PdfReviewIdentity {
  shopId: string;
  orderId: string;
  revision: number;
  requestHash: string;
  sourceSha256?: string;
  manifestSha256?: string;
  authenticatedStaff: boolean;
}
/** Ephemeral page URLs created only from staff-authenticated, hash-checked Blobs. */
export interface PdfReviewPageObjectUrl { index:number; sha256:string; url:string }
export interface PdfReviewPageV1 {
  index: number;
  url: string;
  content_type: 'image/png';
  sha256: string;
  bytes: number;
}
export interface PdfReviewSettingsV1 {
  copies?: number;
  paper?: 'A4'|'A3';
  duplex?: boolean;
  orientation?: 'portrait'|'landscape';
  flip_edge?: 'long'|'short';
}
/** Browser-only projection. Source bytes and private storage locators are excluded. */
export interface PdfReviewPreviewV1 {
  schema: 'ai0.pdf_review_preview.v1';
  shop_id: string;
  order_id: string;
  revision: number;
  request_hash: string;
  source_sha256: string;
  manifest_sha256: string;
  source_format: 'PDF';
  status: 'REVIEW_REQUIRED'|'NEEDS_HUMAN';
  reason_code?: string;
  pages: readonly PdfReviewPageV1[];
  document_pages?: number;
  printed_faces?: number;
  physical_sheets?: number;
  settings?: Readonly<PdfReviewSettingsV1>;
  ready: false;
  allowed_to_print: false;
  requires_staff_review: true;
  physical_print_verified: false;
}
export interface PdfReviewPanelState {
  status: PdfReviewStatus;
  /** Untrusted wire data; validated only for CURRENT state and current identity. */
  projection?: unknown;
  message?: string;
}

const hash = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const safeId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const isRecord = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
const exactKeys = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean => {
  const allowed = new Set([...required, ...optional]);
  return required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => allowed.has(key));
};
const positiveInteger = (value: unknown, max: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= max;

function parseSettings(value: unknown): PdfReviewSettingsV1 | null {
  if (!isRecord(value) || !exactKeys(value, [], ['copies','paper','duplex','orientation','flip_edge'])) return null;
  const out: PdfReviewSettingsV1 = {};
  if (Object.hasOwn(value,'copies')) {
    if (!positiveInteger(value.copies,999)) return null;
    out.copies = value.copies;
  }
  if (Object.hasOwn(value,'paper')) {
    if (value.paper !== 'A4' && value.paper !== 'A3') return null;
    out.paper = value.paper;
  }
  if (Object.hasOwn(value,'duplex')) {
    if (typeof value.duplex !== 'boolean') return null;
    out.duplex = value.duplex;
  }
  if (Object.hasOwn(value,'orientation')) {
    if (value.orientation !== 'portrait' && value.orientation !== 'landscape') return null;
    out.orientation = value.orientation;
  }
  if (Object.hasOwn(value,'flip_edge')) {
    if (value.flip_edge !== 'long' && value.flip_edge !== 'short') return null;
    out.flip_edge = value.flip_edge;
  }
  return out;
}

function expectedPagePath(orderId: string, revision: number, index: number): string {
  return `/api/v1/orders/${encodeURIComponent(orderId)}/revisions/${revision}/previews/${index}`;
}

/** Parse a PDF DTO only when its authenticated shop/order/revision/hash scope matches. */
export function parsePdfReviewPreview(value: unknown, expected: PdfReviewIdentity): PdfReviewPreviewV1 | null {
  if (!expected.authenticatedStaff || !safeId(expected.shopId) || !safeId(expected.orderId) ||
      !positiveInteger(expected.revision, Number.MAX_SAFE_INTEGER) || !hash(expected.requestHash) ||
      (expected.sourceSha256 !== undefined && !hash(expected.sourceSha256)) ||
      (expected.manifestSha256 !== undefined && !hash(expected.manifestSha256)) || !isRecord(value)) return null;

  const required = ['schema','shop_id','order_id','revision','request_hash','source_sha256','manifest_sha256',
    'source_format','status','pages','ready','allowed_to_print','requires_staff_review','physical_print_verified'];
  const optional = ['reason_code','document_pages','printed_faces','physical_sheets','settings'];
  if (!exactKeys(value,required,optional) || value.schema !== 'ai0.pdf_review_preview.v1' ||
      value.shop_id !== expected.shopId || value.order_id !== expected.orderId || value.revision !== expected.revision ||
      value.request_hash !== expected.requestHash || !hash(value.request_hash) ||
      !hash(value.source_sha256) || (expected.sourceSha256 !== undefined && value.source_sha256 !== expected.sourceSha256) ||
      !hash(value.manifest_sha256) || (expected.manifestSha256 !== undefined && value.manifest_sha256 !== expected.manifestSha256) ||
      value.source_format !== 'PDF' || (value.status !== 'REVIEW_REQUIRED' && value.status !== 'NEEDS_HUMAN') ||
      value.ready !== false || value.allowed_to_print !== false || value.requires_staff_review !== true ||
      value.physical_print_verified !== false || !Array.isArray(value.pages) || value.pages.length > 15) return null;

  if (Object.hasOwn(value,'reason_code') &&
      (typeof value.reason_code !== 'string' || !/^[A-Z][A-Z0-9_]{0,79}$/.test(value.reason_code))) return null;
  if (Object.hasOwn(value,'document_pages') && !positiveInteger(value.document_pages,500)) return null;
  if (Object.hasOwn(value,'printed_faces') && !positiveInteger(value.printed_faces,5000)) return null;
  if (Object.hasOwn(value,'physical_sheets') && !positiveInteger(value.physical_sheets,5000)) return null;
  if (typeof value.printed_faces === 'number' && typeof value.physical_sheets === 'number' &&
      value.physical_sheets > value.printed_faces) return null;

  let settings: PdfReviewSettingsV1|undefined;
  if (Object.hasOwn(value,'settings')) {
    const parsed = parseSettings(value.settings);
    if (!parsed) return null;
    settings = parsed;
  }

  const pages: PdfReviewPageV1[] = [];
  for (let slot = 0; slot < value.pages.length; slot++) {
    const page = value.pages[slot];
    if (!isRecord(page) || !exactKeys(page,['index','url','content_type','sha256','bytes']) ||
        page.index !== slot || !Number.isSafeInteger(page.index) ||
        page.url !== expectedPagePath(expected.orderId,expected.revision,slot) ||
        page.content_type !== 'image/png' || !hash(page.sha256) || !positiveInteger(page.bytes,20_000_000)) return null;
    pages.push({index:slot,url:page.url,content_type:'image/png',sha256:page.sha256,bytes:page.bytes});
  }
  if (value.status === 'REVIEW_REQUIRED' ? pages.length < 1 : pages.length !== 0) return null;

  const projection: PdfReviewPreviewV1 = {
    schema:'ai0.pdf_review_preview.v1', shop_id:value.shop_id as string, order_id:expected.orderId,
    revision:expected.revision, request_hash:expected.requestHash, source_sha256:value.source_sha256 as string,
    manifest_sha256:value.manifest_sha256 as string, source_format:'PDF', status:value.status,
    pages, ready:false, allowed_to_print:false, requires_staff_review:true, physical_print_verified:false,
  };
  if (Object.hasOwn(value,'reason_code')) projection.reason_code = value.reason_code as string;
  if (Object.hasOwn(value,'document_pages')) projection.document_pages = value.document_pages as number;
  if (Object.hasOwn(value,'printed_faces')) projection.printed_faces = value.printed_faces as number;
  if (Object.hasOwn(value,'physical_sheets')) projection.physical_sheets = value.physical_sheets as number;
  if (settings) projection.settings = settings;
  return projection;
}

export function currentPdfReviewProjection(state: PdfReviewPanelState, expected: PdfReviewIdentity): PdfReviewPreviewV1 | null {
  return state.status === 'CURRENT' ? parsePdfReviewPreview(state.projection,expected) : null;
}

function validObjectUrls(projection:PdfReviewPreviewV1, urls:readonly PdfReviewPageObjectUrl[]|undefined): urls is readonly PdfReviewPageObjectUrl[] {
  if (projection.status === 'NEEDS_HUMAN') return !urls || urls.length === 0;
  if (!urls || urls.length !== projection.pages.length) return false;
  return projection.pages.every((page,index)=>{
    const loaded=urls[index];
    if (!loaded || loaded.index!==page.index || loaded.sha256!==page.sha256 || typeof loaded.url!=='string') return false;
    try { return new URL(loaded.url).protocol==='blob:'; } catch { return false; }
  });
}

export function PdfReviewPanel({identity,state,verifiedPageObjectUrls}: {
  identity:PdfReviewIdentity;state:PdfReviewPanelState;verifiedPageObjectUrls?:readonly PdfReviewPageObjectUrl[]
}) {
  if (!identity.authenticatedStaff) return null;
  const projection = currentPdfReviewProjection(state,identity);
  const stale = state.status === 'CURRENT' && (!projection || !validObjectUrls(projection,verifiedPageObjectUrls));
  const status = stale ? 'STALE' : state.status;
  const e = React.createElement;
  const titles: Record<PdfReviewStatus,string> = {
    NOT_WIRED:'Chưa nối API preview PDF', LOADING:'Đang tải preview PDF', MISSING:'Chưa có preview PDF hiện hành',
    FAILED:'Không xác minh được preview PDF', STALE:'Preview PDF đã cũ hoặc scope không khớp',
    CURRENT:'Nhân viên kiểm tra preview PDF',
  };
  const statusBadge = status === 'CURRENT' && projection?.status === 'REVIEW_REQUIRED'
    ? 'REVIEW_REQUIRED · Không phải quyền in'
    : status === 'CURRENT' && projection?.status === 'NEEDS_HUMAN' ? 'NEEDS_HUMAN · Giữ đơn'
      : 'Chưa có preview được xác minh';
  const body = status === 'NOT_WIRED' ? 'API preview PDF chưa được nối. Giữ đơn; không dùng preview cũ.'
    : status === 'LOADING' ? 'Đang chờ phản hồi API có staff bearer; preview cũ bị ẩn.'
      : status === 'MISSING' ? 'Máy chủ chưa cấp preview cho order/revision hiện hành hoặc endpoint chưa sẵn sàng. Giữ đơn và chuyển nhân viên.'
        : status === 'FAILED' ? 'Không tải hoặc xác minh được preview PDF. Preview cũ đã bị ẩn; giữ đơn và chuyển nhân viên.'
          : status === 'STALE' ? 'Shop, order, revision, request hash hoặc digest không khớp. Preview cũ đã bị ẩn; giữ đơn và chuyển nhân viên.'
            : projection?.status === 'NEEDS_HUMAN'
              ? `Worker yêu cầu nhân viên xử lý (${projection.reason_code ?? 'NEEDS_HUMAN'}). Giữ đơn; không hiển thị trang preview.`
              : 'Preview chỉ dùng để kiểm tra. Tệp PDF gốc vẫn là nguồn in theo TN-034.';
  const facts = projection && status === 'CURRENT' ? e('dl',{className:'word-review-source-facts'},
    e('div',null,e('dt',null,'Order / revision'),e('dd',null,`${projection.order_id} / ${projection.revision}`)),
    e('div',null,e('dt',null,'Request hash'),e('dd',null,projection.request_hash)),
    e('div',null,e('dt',null,'Source SHA-256'),e('dd',null,projection.source_sha256)),
    e('div',null,e('dt',null,'Manifest SHA-256'),e('dd',null,projection.manifest_sha256)),
    e('div',null,e('dt',null,'Định dạng gốc'),e('dd',null,projection.source_format)),
    e('div',null,e('dt',null,'Số trang / mặt in / tờ'),e('dd',null,
      `${projection.document_pages ?? '—'} / ${projection.printed_faces ?? '—'} / ${projection.physical_sheets ?? '—'}`)),
    e('div',null,e('dt',null,'ready / allowed_to_print'),e('dd',null,'false / false')),
    projection.settings && e('div',null,e('dt',null,'Thông số preflight'),e('dd',null,
      Object.entries(projection.settings).map(([key,value])=>`${key}: ${String(value)}`).join(' · ')))) : null;
  const pages = projection && projection.status === 'REVIEW_REQUIRED' && status === 'CURRENT' && validObjectUrls(projection,verifiedPageObjectUrls)
    ? e('div',{className:'word-review-pages pdf-review-pages','data-testid':'pdf-review-pages'},
    ...projection.pages.map((page,index)=>e('figure',{key:`${page.index}:${page.sha256}`},
      e('img',{src:verifiedPageObjectUrls[index]?.url,alt:`Preview PDF, trang ${page.index+1}`}),
      e('figcaption',null,`Trang ${page.index+1} · ${page.bytes} byte · chỉ để nhân viên kiểm tra`)))) : null;
  return e('section',{className:'word-review-panel pdf-review-panel','data-testid':'pdf-review-panel',
    'data-status':status,'aria-label':'Preview PDF cho nhân viên'},
    e('div',{className:'word-review-heading'},e('strong',null,titles[status]),
      e('span',{className:'word-review-required'},statusBadge)),
    e('p',null,body),facts,pages,
    e('p',{className:'word-review-disclaimer'},
      'Preview không xác nhận yêu cầu của khách, không thay thao tác duyệt nhân viên và không chứng minh giấy đã in.'));
}
