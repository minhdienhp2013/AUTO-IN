import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareFirstPageSuggestedIntent} from '../../../backend/conversation/first-page-delivery-intent.ts';
import {
 gateFirstPageEnqueue,gateFirstPageDelivery
} from '../../../backend/conversation/first-page-core-cas.ts';
import {SAFE_FIRST_PAGE_QUESTION} from '../../../backend/conversation/first-page-question.ts';
import {ConversationProcessor} from '../../../backend/conversation/processor.ts';

// SYNTHETIC PostgreSQL-style row/CAS fixture and fake provider. No real OA,
// customer record, outbox SQL, provider I/O, printer or production credentials.
const shop='shop-synthetic',order='12345678-1234-4123-8123-123456789abc';
const hash='a'.repeat(64),source='b'.repeat(64);
const scope={shop_id:shop,order_id:order,revision:2,oa_id:'oa-synthetic',
 customer_id:'customer-synthetic',conversation_id:'conversation-synthetic'};
const gate={conversation_id:scope.conversation_id,mode:'AI',generation:5};
const snapshot=()=>({
 current:{...scope,active_revision:2,request_hash:hash,source_sha256:source,
  sealed_source_verified:true},
 advisory:{shop_id:shop,order_id:order,revision:2,request_hash:hash,
  artifact_sha256:source,metadata:{schema_version:'tn005.first_page.v1',
   status:'SUGGESTED',category:'WORKSHEET',confidence_label:'high',
   analyzed_page_count:1,method:'pymupdf_page0_text',reason_code:'NONE'}}
});
const intent=()=>{
 const p=prepareFirstPageSuggestedIntent(scope,snapshot(),gate);
 assert.equal(p.status,'suggested');return p.intent;
};
const id='tn005:synthetic:1';
const stale={status:'generic_rebind_required',text:SAFE_FIRST_PAGE_QUESTION};
const blocked={status:'blocked',text:SAFE_FIRST_PAGE_QUESTION};

function fakeCore(){
 const rows={...scope,request_hash:hash,source_sha256:source,
   generation:5,mode:'AI'};
 const outbox=new Map();
 let inserts=0,checks=0,sendCalls=0,printJobs=0,approvals=0;
 const reason=proof=>{
  if(proof.shop_id!==rows.shop_id||proof.order_id!==rows.order_id||
   proof.conversation_id!==rows.conversation_id||
   proof.oa_id!==rows.oa_id||proof.customer_id!==rows.customer_id)
    return 'cross_shop';
  if(rows.mode!=='AI'||proof.generation!==rows.generation)return 'handover';
  if(proof.revision!==rows.revision)return 'stale_revision';
  if(proof.request_hash!==rows.request_hash)return 'stale_request_hash';
  if(proof.source_sha256!==rows.source_sha256)return 'stale_source_sha';
  return null;
 };
 const core={
  async compare_and_enqueue_suggested({outbound_id,intent}){
   checks++;
   const bad=reason(intent.evidence);
   if(bad)return {status:bad};
   // Fake transaction's CAS+insert boundary; no API/outbox is called by AI2.
   const prior=outbox.get(outbound_id);
   if(prior&&!Object.is(prior,intent))return {status:'tampered'};
   if(!prior){outbox.set(outbound_id,intent);inserts++;}
   return {status:'queued',outbound_id};
  },
  async compare_reserved_before_provider_io({outbound_id,intent}){
   checks++;
   const prior=outbox.get(outbound_id);
   if(!prior||prior!==intent)return {status:'tampered'};
   const bad=reason(intent.evidence);
   return bad?{status:bad}:{status:'current',outbound_id};
  }
 };
 return {core,rows,outbox,stats:()=>({inserts,checks,sendCalls,printJobs,approvals})};
}

function processorWithFirstPage({core,read=async()=>snapshot(),currentGate=gate,
  trustedShop=shop,trustedOa=scope.oa_id}={}){
 let ordinaryEnqueueCalls=0,questionReads=0;
 const processor=new ConversationProcessor(
  {async read(){return currentGate}},
  {async inspect(){assert.fail('unused document inspection')}},
  {async suggest_draft(){assert.fail('unused order draft')},
   async route_human(){assert.fail('unused handover')}},
  {async enqueue(){ordinaryEnqueueCalls++;assert.fail('TN005 must never use ordinary enqueue')}},
  undefined,undefined,
  core===undefined?undefined:{trusted_shop_id:trustedShop,trusted_oa_id:trustedOa,
   questions:{async read_bound(value){questionReads++;return read(value)}},core}
 );
 return {processor,stats:()=>({ordinaryEnqueueCalls,questionReads})};
}

test('conversation TN005 integration reads trusted binding then enqueues only through Core CAS',async()=>{
 const f=fakeCore(),p=processorWithFirstPage({core:f.core});
 const result=await p.processor.queueFirstPageSuggestedQuestion({outbound_id:id,scope});
 assert.deepEqual(result,{status:'queued',outbound_id:id,
  text:'Trang đầu có vẻ là phiếu học tập. '+SAFE_FIRST_PAGE_QUESTION});
 assert.deepEqual(p.stats(),{ordinaryEnqueueCalls:0,questionReads:1});
 assert.equal(f.stats().checks,1);assert.equal(f.stats().inserts,1);
 assert.equal(f.stats().sendCalls,0);
});

test('conversation TN005 integration blocks absent, wrong-shop, unreadable or handed-over bindings',async()=>{
 const missing=processorWithFirstPage();
 assert.deepEqual(await missing.processor.queueFirstPageSuggestedQuestion({outbound_id:id,scope}),blocked);
 assert.deepEqual(missing.stats(),{ordinaryEnqueueCalls:0,questionReads:0});

 const f=fakeCore(),wrong=processorWithFirstPage({core:f.core});
 assert.deepEqual(await wrong.processor.queueFirstPageSuggestedQuestion({outbound_id:id,
  scope:{...scope,shop_id:'other-shop'}}),blocked);
 assert.deepEqual(wrong.stats(),{ordinaryEnqueueCalls:0,questionReads:0});

 const unavailable=processorWithFirstPage({core:f.core,read:async()=>{throw Error('PRIVATE SOURCE')}});
 assert.deepEqual(await unavailable.processor.queueFirstPageSuggestedQuestion({outbound_id:id,scope}),blocked);
 assert.deepEqual(unavailable.stats(),{ordinaryEnqueueCalls:0,questionReads:1});

 const handed=processorWithFirstPage({core:f.core,currentGate:{...gate,mode:'HUMAN',generation:6}});
 assert.deepEqual(await handed.processor.queueFirstPageSuggestedQuestion({outbound_id:id,scope}),blocked);
 assert.equal(f.stats().checks,0);assert.equal(f.stats().inserts,0);
});

test('conversation TN005 integration stale Core CAS asks for rebind without ordinary enqueue',async()=>{
 const f=fakeCore();
 f.core.compare_and_enqueue_suggested=async()=>({status:'stale_source_sha'});
 const p=processorWithFirstPage({core:f.core});
 assert.deepEqual(await p.processor.queueFirstPageSuggestedQuestion({outbound_id:id,scope}),stale);
 assert.deepEqual(p.stats(),{ordinaryEnqueueCalls:0,questionReads:1});
 assert.equal(f.stats().sendCalls,0);assert.equal(f.stats().printJobs,0);
});

test('TN005 missing Core CAS port is fail-closed at both boundaries, never enqueue',async()=>{
 const proof=intent();
 assert.deepEqual(await gateFirstPageEnqueue(id,proof,scope,snapshot(),gate),blocked);
 assert.deepEqual(await gateFirstPageDelivery(id,proof,scope,snapshot(),gate),blocked);
 assert.deepEqual(await gateFirstPageEnqueue(id,proof,scope,snapshot(),gate,{}),blocked);
 assert.deepEqual(await gateFirstPageDelivery(id,proof,scope,snapshot(),gate,{}),blocked);
});

test('TN005 synthetically-bound CAS: current enqueue and delivery verify exact evidence',async()=>{
 const f=fakeCore(),proof=intent();
 const queued=await gateFirstPageEnqueue(id,proof,scope,snapshot(),gate,f.core);
 assert.equal(queued.status,'queued');
 assert.equal(queued.outbound_id,id);
 assert.equal(queued.text,proof.text);
 const delivery=await gateFirstPageDelivery(id,proof,scope,snapshot(),gate,f.core);
 assert.equal(delivery.status,'ready');
 assert.equal(delivery.text,proof.text);
 assert.deepEqual(f.stats(),{inserts:1,checks:2,sendCalls:0,printJobs:0,approvals:0});
});

test('TN005 revised order before enqueue requires generic rebind, not an outbox write',async()=>{
 const f=fakeCore(),proof=intent();f.rows.revision=3;
 assert.deepEqual(await gateFirstPageEnqueue(id,proof,scope,snapshot(),gate,f.core),stale);
 assert.equal(f.stats().inserts,0);
 assert.equal(f.stats().sendCalls,0);
});
test('TN005 changed request hash or sealed SHA at Core transaction requires generic rebind',async()=>{
 for(const field of ['request_hash','source_sha256']){
  const f=fakeCore();f.rows[field]='c'.repeat(64);
  const result=await gateFirstPageEnqueue(id,intent(),scope,snapshot(),gate,f.core);
  assert.deepEqual(result,stale,field);
  assert.equal(f.stats().inserts,0);
 }
});
test('TN005 handover or returned generation during Core CAS blocks any enqueue',async()=>{
 for(const mutate of [
  row=>{row.mode='HUMAN';row.generation=6},
  row=>{row.mode='AI';row.generation=7}
 ]){
  const f=fakeCore();mutate(f.rows);
  assert.deepEqual(await gateFirstPageEnqueue(id,intent(),scope,snapshot(),gate,f.core),blocked);
  assert.equal(f.stats().inserts,0);
 }
});
test('TN005 local trusted snapshot changed before Core CAS: no Port call',async()=>{
 const f=fakeCore(),proof=intent(),change=snapshot();
 change.current.active_revision=3;
 assert.deepEqual(await gateFirstPageEnqueue(id,proof,scope,change,gate,f.core),stale);
 assert.equal(f.stats().checks,0);
});
test('TN005 cross-shop/OA/customer or tampered intent blocks before Core CAS',async()=>{
 for(const altered of [
  {...scope,shop_id:'other-shop'}, {...scope,oa_id:'other-oa'},
  {...scope,customer_id:'other-customer'}
 ]){
  const f=fakeCore();
  assert.deepEqual(await gateFirstPageEnqueue(id,intent(),altered,snapshot(),gate,f.core),blocked);
  assert.equal(f.stats().checks,0);
 }
 const f=fakeCore(),proof=intent();
 assert.deepEqual(await gateFirstPageEnqueue(id,{...proof,text:'OCR PRIVATE FILE'},
  scope,snapshot(),gate,f.core),blocked);
 assert.deepEqual(await gateFirstPageEnqueue(id,{...proof,
  text:'Trang đầu có vẻ là đề kiểm tra hoặc đề thi. '+SAFE_FIRST_PAGE_QUESTION},
  scope,snapshot(),gate,f.core),blocked);
 assert.equal(f.stats().checks,0);
});
test('TN005 queued suggestion cancelled by revision/hash/source changes before delivery',async()=>{
 for(const field of ['revision','request_hash','source_sha256']){
  const f=fakeCore(),proof=intent();
  assert.equal((await gateFirstPageEnqueue(id,proof,scope,snapshot(),gate,f.core)).status,'queued');
  f.rows[field]=field==='revision'?3:'c'.repeat(64);
  assert.deepEqual(await gateFirstPageDelivery(id,proof,scope,snapshot(),gate,f.core),stale);
  assert.equal(f.stats().sendCalls,0);
 }
});
test('TN005 queued suggestion cancelled by handover before delivery (not generic send)',async()=>{
 const f=fakeCore(),proof=intent();
 assert.equal((await gateFirstPageEnqueue(id,proof,scope,snapshot(),gate,f.core)).status,'queued');
 f.rows.mode='HUMAN';f.rows.generation=6;
 assert.deepEqual(await gateFirstPageDelivery(id,proof,scope,snapshot(),gate,f.core),blocked);
 assert.equal(f.stats().sendCalls,0);
});
test('TN005 malformed, failed, or replayed Core response cannot authorize sending',async()=>{
 const proof=intent();
 for(const response of [undefined,null,{status:'current',outbound_id:id},
  {status:'queued',outbound_id:'unrelated'},{status:'queued',outbound_id:id,extra:'x'}]){
  const f={async compare_and_enqueue_suggested(){return response}};
  const result=await gateFirstPageEnqueue(id,proof,scope,snapshot(),gate,f);
  assert.deepEqual(result,blocked); // malformed/extra fields never authorize
 }
 const failing={async compare_and_enqueue_suggested(){throw Error('PRIVATE DOCUMENT')},
  async compare_reserved_before_provider_io(){throw Error('PRIVATE DOCUMENT')}};
 assert.deepEqual(await gateFirstPageEnqueue(id,proof,scope,snapshot(),gate,failing),blocked);
 assert.deepEqual(await gateFirstPageDelivery(id,proof,scope,snapshot(),gate,failing),blocked);
});
test('TN005 generic prose never upgrades UNKNOWN/NEEDS_HUMAN to a queue authorization',async()=>{
 for(const status of ['UNKNOWN','NEEDS_HUMAN']){
  const changed=snapshot();changed.advisory.metadata.status=status;
  const f=fakeCore();
  assert.deepEqual(await gateFirstPageEnqueue(id,intent(),scope,changed,gate,f.core),stale);
  assert.equal(f.stats().checks,0);assert.equal(f.stats().inserts,0);
 }
});
