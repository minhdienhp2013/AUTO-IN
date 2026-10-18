import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiFault, HttpPrintPort, mapCoreOrderDetail } from '../../web/src/api.ts';
import { demoOrders, demoSession } from '../../web/src/fixtures.ts';
import type { OrderView, VerifiedFileFact } from '../../web/src/domain.ts';
import { canApproveAfterInboundReview } from '../../web/src/code008.ts';
import { parsePreviewReviewReadModel, previewReviewBlock, previewReviewBlockMessage,
  previewReviewErrorMessage, previewReviewSequence } from '../../web/src/preview-review.ts';

const id='00000000-0000-4000-8000-000000000151';
const requestHash='request-hash-current';
const evidenceSha='a'.repeat(64);
const evidence={schema:'ai0.print_evidence.v1' as const,order_id:id,revision:2,
  request_hash:requestHash,evidence_sha256:evidenceSha};
const missing={status:'missing' as const,order_id:id,revision:2,
  request_hash:requestHash,evidence_sha256:evidenceSha};
const matching={status:'matching' as const,order_id:id,revision:2,
  request_hash:requestHash,evidence_sha256:evidenceSha,reviewer_id:'staff-01',
  reviewed_at:'2026-10-18T09:00:00.000Z',receipt_id:'receipt-01'};
const fact:VerifiedFileFact={index:0,label:'Tài liệu 1',format:'DOCX',document_pages:2,
  printed_faces:2,physical_sheets:2,copies:1,paper:'A4',duplex:false,
  orientation:'portrait',warnings:['WORD_FONT_SUBSTITUTION_NOT_EXCLUDED']};
const baseOrder=():OrderView=>({
  ...structuredClone(demoOrders[0]),order_id:id,revision:2,request_hash:requestHash,
  order_state:'awaiting_customer',confirmed_revision:null,print_state:'NOT_SENT',
  detail_loaded:true,manual_lock:false,
  pending_updates:{state:'clear',unresolved_count:0,items:[]},
  documents:[{...structuredClone(demoOrders[0].documents[0]),format:'DOCX',pages:2,physical_sheets:2,preview_trusted:true}],
  print_evidence:evidence,preview_review:missing,
});
const controlInput=(patch:Partial<Parameters<typeof previewReviewBlock>[0]>={})=>({
  order:baseOrder(),staff:demoSession,apiHealthy:true,simulation:false,
  previewVerified:true,previewPages:2,previewFiles:[fact],checked:true,busy:false,...patch,
});
const rawDetail=(review:unknown)=>({
  order:{id,shop_id:'shop-01',customer_id:'customer-01',conversation_id:'chat-01',
    active_revision:2,manual_lock:false,print_closed:false,delivered_sheets:0,
    created_at:'2026-10-18T08:00:00.000Z'},
  revisions:[{revision:2,request_hash:requestHash,plan:null}],jobs:[],quote:null,received_vnd:0,
  current:{revision:2,request_hash:requestHash,pending_updates:{order_id:id,revision:2,
    request_hash:requestHash,status:'clear',unresolved_count:0,items:[]},verified_plan:null,
    preview_ref:null,request_confirmation:null,price_confirmation:null,approval:null,
    print_evidence:evidence,preview_review:review},
});

test('read model exposes only matching current evidence and marks old receipt stale',()=>{
  const parsed=parsePreviewReviewReadModel({revision:2,request_hash:requestHash,
    print_evidence:evidence,preview_review:missing},{order_id:id,revision:2,request_hash:requestHash});
  assert.equal(parsed.print_evidence?.evidence_sha256,evidenceSha);
  assert.equal(parsed.preview_review.status,'missing');
  const stale=parsePreviewReviewReadModel({revision:2,request_hash:requestHash,
    print_evidence:evidence,preview_review:{...matching,status:'matching',revision:1,
      request_hash:'request-hash-old',evidence_sha256:'b'.repeat(64)}},
    {order_id:id,revision:2,request_hash:requestHash});
  assert.equal(stale.preview_review.status,'stale');
  assert.equal(stale.print_evidence?.evidence_sha256,evidenceSha);
  assert.equal(parsePreviewReviewReadModel({revision:2,request_hash:requestHash,
    print_evidence:evidence,preview_review:null},{order_id:id,revision:2,request_hash:requestHash})
    .preview_review.status,'unavailable');
  assert.equal(parsePreviewReviewReadModel({revision:2,request_hash:requestHash,
    print_evidence:{...evidence,order_id:'another-order'},preview_review:missing},
    {order_id:id,revision:2,request_hash:requestHash}).print_evidence,null);
});

test('review control is fail-closed for missing preview/evidence/API/permission and manual holds',()=>{
  assert.equal(previewReviewBlock(controlInput()),'allowed');
  assert.equal(previewReviewBlock(controlInput({order:{...baseOrder(),print_evidence:undefined}})),'evidence');
  assert.equal(previewReviewBlock(controlInput({previewVerified:false,previewPages:0,previewFiles:[]})),'preview');
  assert.equal(previewReviewBlock(controlInput({apiHealthy:false})),'api');
  assert.equal(previewReviewBlock(controlInput({staff:null})),'unauthenticated');
  assert.equal(previewReviewBlock(controlInput({staff:{...demoSession,can_approve:false}})),'permission');
  assert.equal(previewReviewBlock(controlInput({order:{...baseOrder(),pending_updates:{state:'needs_human',unresolved_count:1,items:[]}}})),'manual_hold');
  assert.equal(previewReviewBlock(controlInput({order:{...baseOrder(),preview_review:matching}})),'already_reviewed');
  assert.equal(previewReviewBlock(controlInput({checked:false})),'acknowledgement');
  assert.match(previewReviewBlockMessage('manual_hold'),/giữ/);
  assert.match(previewReviewErrorMessage('PENDING_INBOUND_REVIEW','x'),/đối soát/);
});

test('ordering requires staff preview receipt, then customer confirmation, then separate approval',()=>{
  const order=baseOrder();
  let flow=previewReviewSequence(order);
  assert.equal(flow.staff_preview,'next');
  assert.equal(flow.customer_confirmation,'blocked');
  assert.equal(flow.staff_approval,'separate');
  assert.equal(previewReviewSequence({...order,preview_review:undefined}).staff_preview,'blocked');
  order.preview_review=matching;
  flow=previewReviewSequence(order);
  assert.equal(flow.staff_preview,'complete');
  assert.equal(flow.customer_confirmation,'next');
  assert.equal(flow.staff_approval,'separate');
  order.order_state='confirmed';order.confirmed_revision=2;
  flow=previewReviewSequence(order);
  assert.equal(flow.customer_confirmation,'complete');
  assert.equal(flow.staff_approval,'ready');
  assert.equal(canApproveAfterInboundReview(order),true);
  order.preview_review={...matching,evidence_sha256:'b'.repeat(64)};
  assert.equal(canApproveAfterInboundReview(order),false);
  order.preview_review={...matching,revision:1};
  assert.equal(canApproveAfterInboundReview(order),false);
  order.preview_review={...matching,request_hash:'old-hash'};
  assert.equal(canApproveAfterInboundReview(order),false);
});
test('V1 stale preview evidence makes same-revision confirmation visibly stale and blocks approval',()=>{
 const order=baseOrder();order.order_state='confirmed';order.confirmed_revision=2;
 order.preview_review={...matching,evidence_sha256:'b'.repeat(64)};
 const flow=previewReviewSequence(order);
 assert.equal(flow.staff_preview,'next');
 assert.equal(flow.customer_confirmation,'stale');
 assert.equal(flow.staff_approval,'separate');
 assert.equal(canApproveAfterInboundReview(order),false);
});

test('POST records only the expected snapshot preconditions and trusts matching GET readback',async()=>{
  const calls:Array<{url:string;options:RequestInit}> = [];
  const fetcher=async(url:RequestInfo|URL,options?:RequestInit)=>{
    const address=String(url),opts=options??{};calls.push({url:address,options:opts});
    if(address.endsWith('/api/v1/auth/login'))return new Response(JSON.stringify({token:'staff-token',principal:{id:'staff-01',shop_id:'shop-01',verified:true,role:'staff'}}),{status:200});
    if(address.endsWith('/api/v1/auth/me'))return new Response(JSON.stringify({principal:{id:'staff-01',shop_id:'shop-01',verified:true,role:'staff'}}),{status:200});
    if(address.endsWith('/preview-reviews'))return new Response(JSON.stringify({order_id:id,receipt_id:'receipt-01'}),{status:201});
    if(address.endsWith(`/api/v1/orders/${id}`))return new Response(JSON.stringify(rawDetail(matching)),{status:200});
    return new Response('{}',{status:404});
  };
  const port=new HttpPrintPort('',fetcher as typeof fetch);
  await port.login('shop-01','staff-01','not-a-real-password');
  const order=mapCoreOrderDetail(rawDetail(missing));
  const fresh=await port.reviewPreview(order,evidenceSha,'00000000-0000-4000-8000-000000000abc');
  const write=calls.find(c=>c.url.endsWith('/preview-reviews'));
  assert.ok(write);
  assert.equal(write.options.method,'POST');
  assert.equal(new Headers(write.options.headers).get('Authorization'),'Bearer staff-token');
  assert.equal(new Headers(write.options.headers).get('Idempotency-Key'),'00000000-0000-4000-8000-000000000abc');
  assert.deepEqual(JSON.parse(String(write.options.body)),{
    expected_revision:2,expected_request_hash:requestHash,expected_evidence_sha256:evidenceSha,
    decision:'checked',idempotency_key:'00000000-0000-4000-8000-000000000abc',
  });
  assert.equal(fresh.preview_review?.status,'matching');
  assert.equal(fresh.order_state,'draft');
  assert.equal(fresh.print_state,'NOT_SENT');
});

test('review write refuses unauthenticated calls and stale readback never becomes success',async()=>{
  const calls:string[]=[];
  const noSession=new HttpPrintPort('',async(url)=>{calls.push(String(url));return new Response('{}',{status:200});});
  await assert.rejects(()=>noSession.reviewPreview(baseOrder(),evidenceSha,'key'),
    (error:unknown)=>error instanceof ApiFault&&error.code==='UNAUTHENTICATED');
  assert.equal(calls.length,0);
  const fetcher=async(url:RequestInfo|URL)=>{
    const address=String(url);
    if(address.endsWith('/api/v1/auth/login'))return new Response(JSON.stringify({token:'staff-token',principal:{id:'staff-01',shop_id:'shop-01',verified:true,role:'staff'}}),{status:200});
    if(address.endsWith('/api/v1/auth/me'))return new Response(JSON.stringify({principal:{id:'staff-01',shop_id:'shop-01',verified:true,role:'staff'}}),{status:200});
    if(address.endsWith('/preview-reviews'))return new Response(JSON.stringify({order_id:id}),{status:201});
    if(address.endsWith(`/api/v1/orders/${id}`))return new Response(JSON.stringify(rawDetail(missing)),{status:200});
    return new Response('{}',{status:404});
  };
  const port=new HttpPrintPort('',fetcher as typeof fetch);
  await port.login('shop-01','staff-01','not-a-real-password');
  await assert.rejects(()=>port.reviewPreview(mapCoreOrderDetail(rawDetail(missing)),evidenceSha,'key'),
    (error:unknown)=>error instanceof ApiFault&&error.code==='PREVIEW_REVIEW_STALE');
});
