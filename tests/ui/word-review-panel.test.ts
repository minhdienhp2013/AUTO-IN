import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const fromWeb=createRequire(new URL('../../web/package.json',import.meta.url));
const React=fromWeb('react');
const {renderToStaticMarkup}=fromWeb('react-dom/server');
import { currentWordReviewProjection, parseWordReviewPreview, WordReviewPanel,
  type WordReviewIdentity, type WordReviewPanelState, type WordReviewPageObjectUrl, type WordReviewPreviewV1 } from '../../web/src/word-review-panel.ts';

const identity:WordReviewIdentity={shopId:'shop-01',orderId:'order-01',revision:7,requestHash:'a'.repeat(64),
  sourceSha256:'b'.repeat(64),manifestSha256:'c'.repeat(64),authenticatedStaff:true};
const good:WordReviewPreviewV1={schema:'ai0.word_review_preview.v1',shop_id:identity.shopId,order_id:identity.orderId,
  revision:identity.revision,request_hash:identity.requestHash,source_sha256:'b'.repeat(64),manifest_sha256:'c'.repeat(64),
  status:'REVIEW_REQUIRED',pages:[{index:1,url:'/api/v1/orders/order-01/word-preview/pages/1',content_type:'image/png',sha256:'d'.repeat(64),bytes:256}],
  document_pages:1,printed_faces:1,physical_sheets:1,settings:{copies:1,duplex:false},ready:false,allowed_to_print:false,
  requires_staff_review:true,physical_print_verified:false};
const verifiedPageObjectUrls:WordReviewPageObjectUrl[]=[{index:1,sha256:'d'.repeat(64),url:'blob:https://staff.invalid/word-page-1'}];
const html=(state:WordReviewPanelState, receipt:'unavailable'|'missing'|'matching'|'stale'='missing',urls?:readonly WordReviewPageObjectUrl[]|null)=>
  renderToStaticMarkup(React.createElement(WordReviewPanel,{identity,state,receipt,
    verifiedPageObjectUrls:urls===undefined?verifiedPageObjectUrls:urls??undefined}));

test('exact authenticated ai0.word_review_preview.v1 projection renders review-only with separate receipt',()=>{
  const state:WordReviewPanelState={status:'CURRENT',projection:good};
  assert.deepEqual(currentWordReviewProjection(state,identity),good);
  const markup=html(state,'matching');
  assert.match(markup,/data-status="CURRENT"/);
  assert.match(markup,/word-review-pages/);
  assert.match(markup,/src="blob:https:\/\/staff\.invalid\/word-page-1"/);
  assert.doesNotMatch(markup,/src="\/api\/v1\/orders\/order-01\/word-preview\/pages\/1"/);
  assert.match(markup,/data-receipt-status="matching"/);
  assert.match(markup,/Biên nhận xem preview/);
  assert.match(markup,/Duyệt lệnh in/);
  assert.match(markup,/ready \/ allowed_to_print/);
  assert.match(markup,/false \/ false/);
  assert.match(markup,/Word\/DOCX gốc vẫn là nguồn in/);
  assert.doesNotMatch(markup,/<(?:button|form|input)\b/i);
});

test('shop/order/revision/request/source/manifest mismatch and unsafe URLs hide all old pages',()=>{
  const altered=[
    {...good,shop_id:'other'}, {...good,order_id:'other'}, {...good,revision:6},
    {...good,request_hash:'e'.repeat(64)}, {...good,source_sha256:'e'.repeat(64)},
    {...good,manifest_sha256:'e'.repeat(64)},
    {...good,pages:[{...good.pages[0],url:'https://outside.invalid/page.png'}]},
    {...good,pages:[{...good.pages[0],url:'//outside.invalid/page.png'}]},
    {...good,pages:[{...good.pages[0],url:'/api/../outside.png'}]},
    {...good,pages:[{...good.pages[0],content_type:'text/html'}]},
  ];
  for(const projection of altered){
    const markup=html({status:'CURRENT',projection});
    assert.match(markup,/data-status="STALE"/);
    assert.match(markup,/đã bị ẩn/);
    assert.doesNotMatch(markup,/word-review-pages|outside\.invalid|page-1/);
  }
});

test('missing endpoint, network/auth/stale errors, and unauthenticated state never render preview',()=>{
  const states:WordReviewPanelState[]=[{status:'NOT_WIRED'},{status:'MISSING'},{status:'LOADING'},
    {status:'FAILED',message:'HTTP 401'},{status:'FAILED',message:'HTTP 409'},{status:'FAILED',message:'HTTP 503'},
    {status:'FAILED',message:'network error'},{status:'STALE',projection:good}];
  for(const state of states){
    const markup=html(state);
    assert.doesNotMatch(markup,/word-review-pages|api\/v1\/orders\/order-01\/word-preview/);
    assert.match(markup,/Giữ đơn|đã bị ẩn|chờ phản hồi|Chưa nối API/);
  }
  assert.doesNotMatch(html({status:'NOT_WIRED'}),/REVIEW_REQUIRED · Không phải quyền in/);
  assert.equal(currentWordReviewProjection({status:'CURRENT',projection:good},{...identity,authenticatedStaff:false}),null);
  const anonymous=renderToStaticMarkup(React.createElement(WordReviewPanel,{
    identity:{...identity,authenticatedStaff:false},state:{status:'CURRENT',projection:good}}));
  assert.equal(anonymous,'');
});

test('malformed projection objects and private source fields fail closed without crashing',()=>{
  const malformed:unknown[]=[null, {...good,pages:[null]}, {...good,pages:[{}]},
    {...good,private_bytes:{source:new Uint8Array([1])}}, {...good,source:{artifact_ref:'/private/source.docx'}},
    {...good,storage_ref:'private/bundle'}, {...good,pages:[{...good.pages[0],url:'/api/v1/orders/other/word-preview/pages/1'}]},
    {...good,pages:[{...good.pages[0],index:0}]}, {...good,pages:[{...good.pages[0],bytes:10*1024*1024+1}]},
    {...good,pages:[...good.pages,...good.pages,...good.pages]}, {...good,reason_code:'<img src=x>'}];
  for(const value of malformed){
    const markup=html({status:'CURRENT',projection:value as WordReviewPreviewV1});
    assert.match(markup,/data-status="STALE"/);
    assert.doesNotMatch(markup,/word-review-pages|private_bytes|source\.docx/);
  }
});

test('NEEDS_HUMAN has no pages and remains held, all authority flags stay false',()=>{
  const needs={...good,status:'NEEDS_HUMAN' as const,reason_code:'FONT_UNCERTAIN',pages:[]};
  const markup=html({status:'CURRENT',projection:needs},'missing',[]);
  assert.match(markup,/FONT_UNCERTAIN/);
  assert.doesNotMatch(markup,/word-review-pages/);
  assert.equal(currentWordReviewProjection({status:'CURRENT',projection:{...needs,ready:true}},identity),null);
});

test('only exact order/revision page routes and matching ephemeral Blob URLs are renderable',()=>{
  const malformed=[
    {...good,pages:[{...good.pages[0],url:'https://outside.invalid/page.png'}]},
    {...good,pages:[{...good.pages[0],url:'/api/v1/orders/order-01/word-preview/pages/1?token=secret'}]},
    {...good,pages:[{...good.pages[0],url:'/api/v1/orders/order-01/word-preview/pages/2'}]},
    {...good,pages:[{...good.pages[0],url:'/api/v1/orders/order-01/word-preview/pages/../1'}]},
  ];
  for(const projection of malformed){
    assert.equal(parseWordReviewPreview(projection,identity),null);
    const markup=html({status:'CURRENT',projection});
    assert.match(markup,/data-status="STALE"/);
    assert.doesNotMatch(markup,/word-review-pages|outside\.invalid|token=secret/);
  }
  for(const urls of [null,[],[{index:1,sha256:'e'.repeat(64),url:verifiedPageObjectUrls[0]!.url}],
    [{index:1,sha256:'d'.repeat(64),url:'/api/v1/orders/order-01/word-preview/pages/1'}]]){
    const markup=html({status:'CURRENT',projection:good},'missing',urls as readonly WordReviewPageObjectUrl[]|null);
    assert.match(markup,/data-status="STALE"/);
    assert.doesNotMatch(markup,/word-review-pages|word-preview\/pages\/1|staff\.invalid/);
  }
});
