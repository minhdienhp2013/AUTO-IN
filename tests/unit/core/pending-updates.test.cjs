const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const root=process.env.AI1_BUILD_DIR||path.resolve(__dirname,'../../../.ai1-build/backend');
const {readPendingUpdates,safePendingItem,emptyPending}=require(path.join(root,'core/pending-updates.js'));
const scope={order_id:'order-1',shop_id:'shop-1',customer_id:'customer-1',
 conversation_id:'chat-1',revision:3,request_hash:'hash-3',verified_plan_ready:true};
const db=handler=>({query:async(sql,args)=>({rows:await handler(sql,args),rowCount:1}),release(){}});
test('CODE-008 pending metadata is safe, bounded, and pinned to current order/revision/hash',()=>{
 const file=safePendingItem({kind:'file',received_at:'2026-10-13T00:00:00Z',
  event_id:'do-not-leak',text:'SECRET',filename:'private.pdf',url:'https://private.invalid'});
 const text=safePendingItem({kind:'text',received_at:'invalid-date'});
 assert.deepEqual(file,{kind:'file',label:'Tệp tin cần đối soát',
  summary:'Chưa được xác minh trong phiên bản đơn hiện hành',received_at:'2026-10-13T00:00:00.000Z'});
 assert.equal(text.received_at,null);
 for(const item of [file,text]){
  assert.ok(!JSON.stringify(item).includes('SECRET'));
  assert.ok(!JSON.stringify(item).includes('private'));
  assert.ok(!Object.hasOwn(item,'event_id'));
 }
 assert.deepEqual(emptyPending(scope),{
  order_id:'order-1',revision:3,request_hash:'hash-3',
  status:'needs_human',unresolved_count:0,items:[]
 });
});
test('CODE-008 missing schema, unbound or forged OA identity never returns CLEAR',async()=>{
 const missing=db(async()=>[{proposals:'core_ai_draft_proposals',events:'zalo_inbound_events',
  reviews:null,revisions:'core_revisions',approvals:'core_approvals'}]);
 assert.equal((await readPendingUpdates(missing,scope)).status,'needs_human');
 let steps=0;
 const wrong=db(async()=>{
  steps++;return steps===1?[{proposals:'p',events:'e',reviews:'r',revisions:'rev',approvals:'app'}]:
   [{shop_id:'FOREIGN-SHOP',oa_id:'trusted-oa',customer_id:'customer-1',conversation_id:'chat-1'}];
 });
 assert.equal((await readPendingUpdates(wrong,scope)).status,'needs_human');
 assert.equal(steps,2);
 assert.equal((await readPendingUpdates(missing,{...scope,conversation_id:null})).status,'needs_human');
});
test('CODE-008 SQL errors reject fail closed rather than return false CLEAR',async()=>{
 const broken=db(async()=>{throw new Error('simulated connection error')});
 await assert.rejects(readPendingUpdates(broken,scope),e=>e.code==='PENDING_READ_UNAVAILABLE'&&e.status===503);
});
test('CODE-008 old/mismatched JSON revision history never returns CLEAR',async()=>{
 let step=0;
 const history=db(async()=>{
  step++;
  if(step===1)return [{proposals:'p',events:'e',reviews:'r',revisions:'rv',approvals:'ap'}];
  if(step===2)return [{shop_id:'shop-1',oa_id:'oa-1',customer_id:'customer-1',conversation_id:'chat-1'}];
  return [{initial_ids:['event-1'],current_ids:['event-2'],revision:3,request_hash:'hash-3'}];
 });
 const result=await readPendingUpdates(history,scope);
 assert.equal(result.status,'needs_human');
 assert.equal(step,3);
});

test('manual non-Zalo requires staff audit, no OA binding, valid revision/hash',async()=>{
 const manualScope={...scope,conversation_id:null};
 const manual=(override={})=>{
  let steps=0;
  return db(async()=>{
   steps++;
   return steps===1?[{proposals:'core_ai_draft_proposals',audit:'core_audit',
    users:'core_users',revisions:'core_revisions'}]:
    [{proposal_count:0,staff_creates:1,initial_data:{files:[]},
      current_data:{files:[]},request_hash:'hash-3',...override}];
  });
 };
 assert.equal((await readPendingUpdates(manual(),manualScope)).status,'clear');
 assert.equal((await readPendingUpdates(manual(),{...manualScope,verified_plan_ready:false})).status,'processing');
 for(const bad of [
  {proposal_count:1},{staff_creates:0},{staff_creates:2},{request_hash:'old-hash'},
  {initial_data:{source:'zalo_ai_suggestion',event_ids:[]}},
  {current_data:{event_ids:['unverified']}},
  {current_data:{source:'zalo_oa',files:[]}}
 ]){
  assert.equal((await readPendingUpdates(manual(bad),manualScope)).status,
   'needs_human',JSON.stringify(bad));
 }
});
test('missing manual provenance schema or SQL failure is fail-closed',async()=>{
 const manualScope={...scope,conversation_id:null};
 const missing=db(async()=>[{proposals:'core_ai_draft_proposals',audit:null,
  users:'core_users',revisions:'core_revisions'}]);
 assert.equal((await readPendingUpdates(missing,manualScope)).status,'needs_human');
 const broken=db(async()=>{throw new Error('provenance unavailable')});
 await assert.rejects(readPendingUpdates(broken,manualScope),
  e=>e.code==='PENDING_READ_UNAVAILABLE'&&e.status===503);
});
