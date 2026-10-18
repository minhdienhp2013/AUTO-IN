import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const fromWeb=createRequire(new URL('../../web/package.json',import.meta.url));
const React=fromWeb('react');
const {renderToStaticMarkup}=fromWeb('react-dom/server');
import { currentPdfReviewProjection, parsePdfReviewPreview, PdfReviewPanel,
  type PdfReviewIdentity, type PdfReviewPanelState, type PdfReviewPreviewV1 } from '../../web/src/pdf-review-panel.ts';

const identity:PdfReviewIdentity={shopId:'shop-01',orderId:'order-01',revision:7,requestHash:'a'.repeat(64),
  sourceSha256:'b'.repeat(64),manifestSha256:'c'.repeat(64),authenticatedStaff:true};
const good:PdfReviewPreviewV1={schema:'ai0.pdf_review_preview.v1',shop_id:identity.shopId,order_id:identity.orderId,
  revision:identity.revision,request_hash:identity.requestHash,source_sha256:identity.sourceSha256,
  manifest_sha256:identity.manifestSha256,source_format:'PDF',status:'REVIEW_REQUIRED',
  pages:[{index:0,url:'/api/v1/orders/order-01/revisions/7/previews/0',content_type:'image/png',
    sha256:'d'.repeat(64),bytes:256}],document_pages:1,printed_faces:2,physical_sheets:1,
  settings:{copies:1,paper:'A4',duplex:true,orientation:'portrait',flip_edge:'long'},
  ready:false,allowed_to_print:false,requires_staff_review:true,physical_print_verified:false};
const html=(state:PdfReviewPanelState,who:PdfReviewIdentity=identity)=>
  renderToStaticMarkup(React.createElement(PdfReviewPanel,{identity:who,state}));

test('exact staff-scoped PDF projection renders review-only pages and verified metadata',()=>{
  const parsed=parsePdfReviewPreview(good,identity);
  assert.ok(parsed);
  assert.equal(parsed.schema,'ai0.pdf_review_preview.v1');
  assert.equal(parsed.source_format,'PDF');
  assert.equal(parsed.pages[0]?.url,good.pages[0]?.url);
  const markup=html({status:'CURRENT',projection:good});
  assert.match(markup,/data-status="CURRENT"/);
  assert.match(markup,/data-testid="pdf-review-pages"/);
  assert.match(markup,/src="\/api\/v1\/orders\/order-01\/revisions\/7\/previews\/0"/);
  assert.match(markup,/Định dạng gốc/);
  assert.match(markup,/Số trang \/ mặt in \/ tờ/);
  assert.match(markup,/A4/);
  assert.match(markup,/false \/ false/);
  assert.match(markup,/Tệp PDF gốc vẫn là nguồn in theo TN-034/);
  assert.match(markup,/không thay thao tác duyệt nhân viên/);
  assert.doesNotMatch(markup,/<(?:button|form|input)\b/i);
});

test('shop/order/revision/hash mismatch hides every previous PDF page',()=>{
  const altered:unknown[]=[
    {...good,shop_id:'other-shop'}, {...good,order_id:'other-order'}, {...good,revision:6},
    {...good,request_hash:'e'.repeat(64)}, {...good,source_sha256:'e'.repeat(64)},
    {...good,manifest_sha256:'e'.repeat(64)},
    {...good,pages:[{...good.pages[0],url:'/api/v1/orders/order-02/revisions/7/previews/0'}]},
    {...good,pages:[{...good.pages[0],url:'/api/v1/orders/order-01/revisions/6/previews/0'}]},
  ];
  for(const projection of altered) {
    const markup=html({status:'CURRENT',projection});
    assert.match(markup,/data-status="STALE"/);
    assert.match(markup,/đã bị ẩn/);
    assert.match(markup,/giữ đơn/i);
    assert.doesNotMatch(markup,/pdf-review-pages|previews\/0|e{64}/);
  }
  assert.equal(currentPdfReviewProjection({status:'CURRENT',projection:good},{...identity,shopId:'other-shop'}),null);
  assert.equal(currentPdfReviewProjection({status:'CURRENT',projection:good},{...identity,authenticatedStaff:false}),null);
});

test('absolute, protocol-relative, traversal, query, and non-PNG page routes are rejected',()=>{
  const badPages=[
    {...good.pages[0],url:'https://outside.invalid/page.png'},
    {...good.pages[0],url:'//outside.invalid/page.png'},
    {...good.pages[0],url:'/api/v1/orders/order-01/revisions/7/previews/../0'},
    {...good.pages[0],url:'/api/v1/orders/order-01/revisions/7/previews/0?token=secret'},
    {...good.pages[0],url:'/api/v1/orders/order-01/revisions/7/previews/0#secret'},
    {...good.pages[0],url:'/api/v1/orders/order-01/revisions/7/previews/0',content_type:'text/html'},
    {...good.pages[0],url:'/api/v1/orders/order-01/revisions/7/previews/0',content_type:'image/svg+xml'},
  ];
  for(const page of badPages) {
    const parsed=parsePdfReviewPreview({...good,pages:[page]},identity);
    assert.equal(parsed,null);
    const markup=html({status:'CURRENT',projection:{...good,pages:[page]}});
    assert.match(markup,/data-status="STALE"/);
    assert.doesNotMatch(markup,/pdf-review-pages|outside\.invalid|secret/);
  }
});

test('private bytes/locators, unknown keys, unsafe settings and invalid counts fail closed',()=>{
  const malformed:unknown[]=[
    {...good,private_bytes:{source:new Uint8Array([1])}},
    {...good,artifact_ref:'private/bundle'},
    {...good,pages:[{...good.pages[0],bytes_content:'base64'}]},
    {...good,pages:[{...good.pages[0],locator:'private/page.png'}]},
    {...good,reason_code:'<img src=x>'}, {...good,reason_code:'R'.repeat(81)},
    {...good,document_pages:0}, {...good,document_pages:501}, {...good,printed_faces:5001},
    {...good,physical_sheets:3,printed_faces:2},
    {...good,settings:{...good.settings,source_path:'/private/file.pdf'}},
    {...good,settings:{copies:0}}, {...good,settings:{duplex:'yes'}},
    {...good,ready:true}, {...good,allowed_to_print:true}, {...good,requires_staff_review:false},
    {...good,physical_print_verified:true}, {...good,source_format:'DOCX'},
  ];
  for(const projection of malformed) {
    assert.equal(parsePdfReviewPreview(projection,identity),null);
    const markup=html({status:'CURRENT',projection});
    assert.match(markup,/data-status="STALE"/);
    assert.doesNotMatch(markup,/pdf-review-pages|private\/|base64|source_path/);
  }
});

test('NOT_WIRED, missing data and 401/409/503/network failures hide prior pages and keep the order',()=>{
  const states:PdfReviewPanelState[]=[
    {status:'NOT_WIRED',projection:good}, {status:'LOADING',projection:good}, {status:'MISSING',projection:good},
    {status:'FAILED',projection:good,message:'HTTP 401'}, {status:'FAILED',projection:good,message:'HTTP 409'},
    {status:'FAILED',projection:good,message:'HTTP 503'}, {status:'FAILED',projection:good,message:'network failure'},
    {status:'FAILED',projection:good,message:'<img src="https://private.invalid">'}, {status:'STALE',projection:good},
    {status:'CURRENT'},
  ];
  for(const state of states) {
    const markup=html(state);
    assert.doesNotMatch(markup,/pdf-review-pages|previews\/0|private\.invalid/);
    assert.match(markup,/Giữ đơn|đã bị ẩn|chờ phản hồi|Chưa nối API/);
  }
  assert.doesNotMatch(html({status:'NOT_WIRED',projection:good}),/REVIEW_REQUIRED · Không phải quyền in/);
  assert.equal(html({status:'CURRENT',projection:good},{...identity,authenticatedStaff:false}),'');
});

test('NEEDS_HUMAN has no pages and remains held',()=>{
  const needs={...good,status:'NEEDS_HUMAN' as const,reason_code:'PDF_LAYOUT_UNCERTAIN',pages:[]};
  const markup=html({status:'CURRENT',projection:needs});
  assert.match(markup,/data-status="CURRENT"/);
  assert.match(markup,/NEEDS_HUMAN · Giữ đơn/);
  assert.match(markup,/PDF_LAYOUT_UNCERTAIN/);
  assert.doesNotMatch(markup,/pdf-review-pages|src="\/api\/v1/);
  assert.equal(parsePdfReviewPreview({...needs,pages:[...good.pages]},identity),null);
});
