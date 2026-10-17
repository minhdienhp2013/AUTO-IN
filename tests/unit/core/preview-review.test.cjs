const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const root=process.env.AI1_BUILD_DIR||path.resolve(__dirname,'../../../.ai1-build/backend');
const {previewReviewMatches,requirePreviewReview,previewReviewReadModel,internalReviewReceipt}=require(path.join(root,'core/preview-review.js'));
const {sha}=require(path.join(root,'core/model.js'));
const scope={shop_id:'shop-a',order_id:'order-a',revision:2,request_hash:sha('request')};
const digest=sha('evidence');
const receipt={...scope,id:'receipt-a',evidence_sha256:digest,reviewer_id:'staff-a',decision:'checked',reviewed_at:new Date('2026-10-18T00:00:00Z')};
const fakeDb=(rows)=>({query:async(sql)=>({rows:sql.includes('evidence_sha256=$5')?rows.matching:rows.latest,rowCount:0}),release(){}});

test('preview receipt requires exact shop/order/revision/request/evidence tuple',()=>{
 assert.equal(previewReviewMatches(receipt,scope,digest),true);
 assert.equal(previewReviewMatches(null,scope,digest),false);
 assert.equal(previewReviewMatches(receipt,scope,null),false);
 for(const change of [
  {shop_id:'shop-b'},{order_id:'order-b'},{revision:3},
  {request_hash:sha('other-request')},{evidence_sha256:sha('other-evidence')}
 ])assert.equal(previewReviewMatches({...receipt,...change},scope,digest),false);
});

test('missing or wrong-scope receipt fails closed; matching exact receipt is accepted',async()=>{
 await assert.rejects(requirePreviewReview(fakeDb({matching:[],latest:[]}),scope,digest),
  error=>error.code==='PREVIEW_REVIEW_REQUIRED');
 await assert.rejects(requirePreviewReview(fakeDb({matching:[{...receipt,shop_id:'shop-b'}],latest:[]}),scope,digest),
  error=>error.code==='PREVIEW_REVIEW_REQUIRED');
 assert.deepEqual(await requirePreviewReview(fakeDb({matching:[receipt],latest:[]}),scope,digest),receipt);
});

test('staff read model reports missing, stale and matching receipts',async()=>{
 const missing=await previewReviewReadModel(fakeDb({matching:[],latest:[]}),scope,digest);
 assert.equal(missing.status,'missing');
 const stale=await previewReviewReadModel(fakeDb({matching:[],latest:[{...receipt,evidence_sha256:sha('old')}]}),scope,digest);
 assert.equal(stale.status,'stale');
 const matching=await previewReviewReadModel(fakeDb({matching:[receipt],latest:[]}),scope,digest);
 assert.equal(matching.status,'matching');
 assert.equal(matching.receipt_id,receipt.id);
 assert.equal(matching.reviewer_id,receipt.reviewer_id);
});

test('internal ticket is an exact nine-field receipt projection',()=>{
 const ticket=internalReviewReceipt(receipt);
 assert.deepEqual(Object.keys(ticket).sort(),[
  'receipt_id','shop_id','order_id','revision','request_hash','evidence_sha256',
  'reviewer_id','reviewed_at','decision'
 ].sort());
 assert.equal(ticket.receipt_id,receipt.id);
 assert.equal(ticket.reviewed_at,'2026-10-18T00:00:00.000Z');
 assert.equal(ticket.decision,'checked');
});
