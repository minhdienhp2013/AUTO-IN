const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const root=process.env.AI1_BUILD_DIR||path.resolve(__dirname,'../../../.ai1-build/backend');
const {createOrderSupplementPort}=require(path.join(root,'core/order-supplement-port.js'));
const trusted={shop_id:'trusted-shop',oa_id:'trusted-oa'};
const actor={id:'real-processor',shop_id:'trusted-shop',role:'processor',verified:true};
function fakeStore(){let called=0;return {tx:async()=>{called++;throw Error('unexpected DB transaction');},count:()=>called};}
const input={order_id:'00000000-0000-4000-8000-000000000001',conversation_id:'conversation',
 customer_id:'customer',event_ids:['event-1'],expected_revision:1,idempotency_key:'stable'};
test('CODE-008 Port refuses missing trusted server OA/shop',()=>{
 const store=fakeStore();
 assert.throws(()=>createOrderSupplementPort({store,trusted:{shop_id:'',oa_id:'oa'}}),
  e=>e.code==='SUPPLEMENT_PORT_UNCONFIGURED');
 assert.throws(()=>createOrderSupplementPort({store,trusted:{shop_id:'shop',oa_id:''}}),
  e=>e.code==='SUPPLEMENT_PORT_UNCONFIGURED');
 assert.equal(store.count(),0);
});
test('CODE-008 Port rejects fabricated actor, foreign shop, malformed event and revision before database mutation',async()=>{
 const store=fakeStore(),port=createOrderSupplementPort({store,trusted});
 await assert.rejects(port.append_verified_events({...actor,verified:false},input),
  e=>e.code==='PROCESSOR_REQUIRED');
 await assert.rejects(port.append_verified_events({...actor,shop_id:'another-shop'},input),
  e=>e.code==='SUPPLEMENT_SHOP_FORBIDDEN');
 await assert.rejects(port.append_verified_events({...actor,role:'customer'},input),
  e=>e.code==='FORBIDDEN');
 await assert.rejects(port.append_verified_events(actor,{...input,event_ids:['event-1','event-1']}),
  e=>e.code==='DUPLICATE_INBOUND_EVENTS');
 await assert.rejects(port.append_verified_events(actor,{...input,event_ids:[]}),
  e=>e.code==='INVALID_INBOUND_EVENTS');
 await assert.rejects(port.append_verified_events(actor,{...input,expected_revision:-1}),
  e=>e.code==='INVALID_SUPPLEMENT_REVISION');
 await assert.rejects(port.append_verified_events(actor,{...input,idempotency_key:''}),
  e=>e.code==='INVALID_INBOUND_SUPPLEMENT');
 assert.equal(store.count(),0);
});

test('CODE-008 atomic batch requires server-bound verified processor and rejects untrusted request before DB',async()=>{
 const store=fakeStore();
 const shape={conversation_id:'conversation',customer_id:'customer',event_ids:['event-1'],
   text:'Print one',idempotency_key:'batch-idem',expected_generation:0,
   intent:'append_or_create',materialized:true};
 const without=createOrderSupplementPort({store,trusted});
 await assert.rejects(without.apply_incoming_batch(shape),
   e=>e.code==='VERIFIED_PROCESSOR_REQUIRED');
 const port=createOrderSupplementPort({store,trusted,processor:actor});
 await assert.rejects(port.apply_incoming_batch({...shape,event_ids:['event-1','event-1']}),
   e=>e.code==='DUPLICATE_INBOUND_EVENTS');
 await assert.rejects(port.apply_incoming_batch({...shape,expected_generation:-1}),
   e=>e.code==='INVALID_AI_GENERATION');
 await assert.rejects(port.apply_incoming_batch({...shape,intent:'AI_guessed_separate'}),
   e=>e.code==='UNVERIFIED_SEPARATE_INTENT');
 await assert.rejects(port.apply_incoming_batch({...shape,expected_revision:0}),
   e=>e.code==='INVALID_SUPPLEMENT_REVISION');
 assert.equal(store.count(),0);
});
