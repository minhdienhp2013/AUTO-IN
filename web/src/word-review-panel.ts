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
  sourceSha256?: string;
  manifestSha256?: string;
  authenticatedStaff: boolean;
}
/** Ephemeral URLs created from staff-authenticated, verified PNG bytes only. */
export interface WordReviewPageObjectUrl { index:number; sha256:string; url:string }
export type WordReviewStatus = 'NOT_WIRED' | 'LOADING' | 'MISSING' | 'FAILED' | 'STALE' | 'CURRENT';
export interface WordReviewPanelState { status: WordReviewStatus; projection?: unknown; message?: string }
export type PreviewReceiptStatus = 'unavailable' | 'missing' | 'matching' | 'stale';

const digest = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
const safeId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const positiveInt = (value: unknown, max: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= max;
const isRecord = (value: unknown): value is Record<string, unknown> => {
  if(value===null||typeof value!=='object'||Array.isArray(value))return false;
  const prototype=Object.getPrototypeOf(value);
  return prototype===Object.prototype||prototype===null;
};
const exactKeys=(value:Record<string,unknown>,required:readonly string[],optional:readonly string[]=[]):boolean=>{
  const allowed=new Set([...required,...optional]);
  return required.every(key=>Object.hasOwn(value,key))&&Object.keys(value).every(key=>allowed.has(key));
};

function appRelativeUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return false;
  try {
    const u = new URL(value, 'https://ui.invalid');
    const rawPath = value.split(/[?#]/, 1)[0];
    const segments = rawPath.split('/').map(segment => decodeURIComponent(segment));
    return u.origin === 'https://ui.invalid' && u.pathname === rawPath &&
      !segments.some(segment => segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\\'));
  }
  catch { return false; }
}

function expectedPagePath(orderId:string,index:number):string {
  return `/api/v1/orders/${encodeURIComponent(orderId)}/word-preview/pages/${index}`;
}

function parseSettings(value:unknown):Readonly<Record<string,string|number|boolean>>|null {
  if(!isRecord(value)||!exactKeys(value,[],['copies','paper','duplex','orientation','flip_edge','binding','page_range']))return null;
  const out:Record<string,string|number|boolean>={};
  if(Object.hasOwn(value,'copies')){if(!positiveInt(value.copies,999))return null;out.copies=value.copies;}
  if(Object.hasOwn(value,'paper')){if(value.paper!=='A4'&&value.paper!=='A3')return null;out.paper=value.paper;}
  if(Object.hasOwn(value,'duplex')){if(typeof value.duplex!=='boolean')return null;out.duplex=value.duplex;}
  if(Object.hasOwn(value,'orientation')){if(value.orientation!=='portrait'&&value.orientation!=='landscape')return null;out.orientation=value.orientation;}
  if(Object.hasOwn(value,'flip_edge')){if(value.flip_edge!=='long'&&value.flip_edge!=='short')return null;out.flip_edge=value.flip_edge;}
  if(Object.hasOwn(value,'binding')){if(typeof value.binding!=='string'||value.binding.length>40||/[\u0000-\u001f\u007f]/.test(value.binding))return null;out.binding=value.binding;}
  if(Object.hasOwn(value,'page_range')){if(typeof value.page_range!=='string'||value.page_range.length>64||/[\u0000-\u001f\u007f]/.test(value.page_range))return null;out.page_range=value.page_range;}
  return out;
}

/** Parse only a bounded current staff projection; server-provided page URLs are never rendered or fetched unvalidated. */
export function parseWordReviewPreview(value:unknown,expected:WordReviewIdentity):WordReviewPreviewV1|null {
  if(!expected.authenticatedStaff||!safeId(expected.shopId)||!safeId(expected.orderId)||
      !positiveInt(expected.revision,Number.MAX_SAFE_INTEGER)||!digest(expected.requestHash)||
      (expected.sourceSha256!==undefined&&!digest(expected.sourceSha256))||
      (expected.manifestSha256!==undefined&&!digest(expected.manifestSha256))||!isRecord(value))return null;
  const required=['schema','shop_id','order_id','revision','request_hash','source_sha256','manifest_sha256','status','pages',
    'ready','allowed_to_print','requires_staff_review','physical_print_verified'];
  const optional=['reason_code','document_pages','printed_faces','physical_sheets','settings'];
  if(!exactKeys(value,required,optional)||value.schema!=='ai0.word_review_preview.v1'||
      value.shop_id!==expected.shopId||value.order_id!==expected.orderId||value.revision!==expected.revision||
      value.request_hash!==expected.requestHash||!digest(value.request_hash)||!digest(value.source_sha256)||
      !digest(value.manifest_sha256)||(expected.sourceSha256!==undefined&&value.source_sha256!==expected.sourceSha256)||
      (expected.manifestSha256!==undefined&&value.manifest_sha256!==expected.manifestSha256)||
      (value.status!=='REVIEW_REQUIRED'&&value.status!=='NEEDS_HUMAN')||value.ready!==false||
      value.allowed_to_print!==false||value.requires_staff_review!==true||value.physical_print_verified!==false||
      !Array.isArray(value.pages)||value.pages.length>3)return null;
  if(Object.hasOwn(value,'reason_code')&&(typeof value.reason_code!=='string'||! /^[A-Z][A-Z0-9_]{0,79}$/.test(value.reason_code)))return null;
  if(Object.hasOwn(value,'document_pages')&&!positiveInt(value.document_pages,500))return null;
  if(Object.hasOwn(value,'printed_faces')&&!positiveInt(value.printed_faces,5000))return null;
  if(Object.hasOwn(value,'physical_sheets')&&!positiveInt(value.physical_sheets,5000))return null;
  if(typeof value.printed_faces==='number'&&typeof value.physical_sheets==='number'&&value.physical_sheets>value.printed_faces)return null;
  let settings:Readonly<Record<string,string|number|boolean>>|undefined;
  if(Object.hasOwn(value,'settings')){const parsed=parseSettings(value.settings);if(!parsed)return null;settings=parsed;}
  const pages:WordReviewPreviewV1['pages'][number][]=[];
  let previousIndex=0;
  for(const raw of value.pages){
    if(!isRecord(raw)||!exactKeys(raw,['index','url','content_type','sha256','bytes'])||
        !positiveInt(raw.index,500)||raw.index<=previousIndex||!appRelativeUrl(raw.url)||
        raw.url!==expectedPagePath(expected.orderId,raw.index)||raw.content_type!=='image/png'||
        !digest(raw.sha256)||!positiveInt(raw.bytes,10*1024*1024)||
        (typeof value.document_pages==='number'&&raw.index>value.document_pages))return null;
    previousIndex=raw.index;
    pages.push({index:raw.index,url:raw.url,content_type:'image/png',sha256:raw.sha256,bytes:raw.bytes});
  }
  if(value.status==='REVIEW_REQUIRED'?pages.length<1:pages.length!==0)return null;
  const parsed:WordReviewPreviewV1={schema:'ai0.word_review_preview.v1',shop_id:expected.shopId,order_id:expected.orderId,
    revision:expected.revision,request_hash:expected.requestHash,source_sha256:value.source_sha256,manifest_sha256:value.manifest_sha256,
    status:value.status,pages,ready:false,allowed_to_print:false,requires_staff_review:true,physical_print_verified:false};
  if(Object.hasOwn(value,'reason_code'))parsed.reason_code=value.reason_code as string;
  if(Object.hasOwn(value,'document_pages'))parsed.document_pages=value.document_pages as number;
  if(Object.hasOwn(value,'printed_faces'))parsed.printed_faces=value.printed_faces as number;
  if(Object.hasOwn(value,'physical_sheets'))parsed.physical_sheets=value.physical_sheets as number;
  if(settings)parsed.settings=settings;
  return parsed;
}

/** Fail closed unless the authenticated projection matches all active scope and hashes. */
export function currentWordReviewProjection(state: WordReviewPanelState, expected: WordReviewIdentity): WordReviewPreviewV1 | null {
  return state.status==='CURRENT'?parseWordReviewPreview(state.projection,expected):null;
}

function validObjectUrls(projection:WordReviewPreviewV1,urls:readonly WordReviewPageObjectUrl[]|undefined):urls is readonly WordReviewPageObjectUrl[]{
  if(projection.status==='NEEDS_HUMAN')return !urls||urls.length===0;
  if(!urls||urls.length!==projection.pages.length)return false;
  return projection.pages.every((page,index)=>{
    const loaded=urls[index];
    if(!loaded||loaded.index!==page.index||loaded.sha256!==page.sha256||typeof loaded.url!=='string')return false;
    try{return new URL(loaded.url).protocol==='blob:';}catch{return false;}
  });
}

const receiptText: Record<PreviewReceiptStatus, string> = {
  unavailable: 'Chưa đọc được biên nhận nhân viên từ máy chủ.',
  missing: 'Chưa có biên nhận nhân viên cho preview hiện hành.',
  matching: 'Máy chủ ghi nhận nhân viên đã xem snapshot hiện hành.',
  stale: 'Biên nhận cũ; cần kiểm tra lại snapshot hiện hành.',
};

export function WordReviewPanel({ identity, state, receipt = 'unavailable', verifiedPageObjectUrls }: {
  identity: WordReviewIdentity; state: WordReviewPanelState; receipt?: PreviewReceiptStatus;
  verifiedPageObjectUrls?:readonly WordReviewPageObjectUrl[];
}) {
  if (!identity.authenticatedStaff) return null;
  const projection = currentWordReviewProjection(state, identity);
  const stale = state.status === 'CURRENT' && (!projection||!validObjectUrls(projection,verifiedPageObjectUrls));
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
    ...projection.pages.map((page,index) => e('figure', { key: `${page.index}:${page.sha256}` },
      e('img', { src: verifiedPageObjectUrls?.[index]?.url, alt: `Preview Word, trang ${page.index}` }),
      e('figcaption', null, `Trang ${page.index} · ${page.bytes} byte · chỉ để nhân viên kiểm tra`)))) : null;
  const statusBadge = status === 'CURRENT' && projection?.status === 'REVIEW_REQUIRED' ? 'REVIEW_REQUIRED · Không phải quyền in'
    : status === 'CURRENT' && projection?.status === 'NEEDS_HUMAN' ? 'NEEDS_HUMAN · Giữ đơn'
    : 'Chưa có preview được xác minh';
  const body = status === 'NOT_WIRED' ? 'API preview Word chưa được AI0 nối. Giữ đơn để nhân viên xử lý; không dùng preview cũ.'
    : status === 'LOADING' ? 'Đang chờ phản hồi API có staff bearer; preview cũ bị ẩn.'
    : status === 'MISSING' ? 'Máy chủ chưa cấp snapshot của order/revision hiện hành. Giữ đơn và chuyển nhân viên.'
    : status === 'STALE' ? 'Shop, order, revision, request hash hoặc digest không khớp. Preview cũ đã bị ẩn; giữ đơn và chuyển nhân viên.'
    : status === 'FAILED' ? 'Không tải hoặc xác minh được preview Word. Preview cũ đã bị ẩn; giữ đơn và chuyển nhân viên.'
    : projection?.status === 'NEEDS_HUMAN' ? `Worker yêu cầu nhân viên xử lý (${projection.reason_code ?? 'NEEDS_HUMAN'}). Giữ đơn; không có preview được xác minh.`
    : 'Preview chỉ dùng để kiểm tra. Word/DOCX gốc vẫn là nguồn in theo TN-034.';
  return e('section', { className: 'word-review-panel', 'data-testid': 'word-review-panel', 'data-status': status, 'aria-label': 'Preview Word và receipt nhân viên' },
    e('div', { className: 'word-review-heading' }, e('strong', null, titles[status]),
      e('span', { className: 'word-review-required' }, statusBadge)),
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
