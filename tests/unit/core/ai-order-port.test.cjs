const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const root=process.env.AI1_BUILD_DIR||path.resolve(__dirname,'../../../.ai1-build/backend');
const {createAiOrderPort}=require(path.join(root,'core/ai-order-port.js'));

const trusted={shop_id:'trusted-shop',oa_id:'trusted-oa'};
function fakeStore(){let transactions=0;return {store:{tx:async()=>{transactions++;throw Error('unexpected transaction');}},count:()=>transactions};}

test('AI order port requires server trusted shop/OA config',()=>{
 const db=fakeStore();
 assert.throws(()=>createAiOrderPort({store:db.store,trusted:{shop_id:'',oa_id:'x'}}),e=>e.code==='AI_PORT_NOT_CONFIGURED');
 assert.throws(()=>createAiOrderPort({store:db.store,trusted:{shop_id:'x',oa_id:''}}),e=>e.code==='AI_PORT_NOT_CONFIGURED');
 assert.equal(db.count(),0);
});
test('AI draft proposal blocks invalid idempotency, duplicate events and generation before DB',async()=>{
 const db=fakeStore();const port=createAiOrderPort({store:db.store,trusted});
 const input={conversation_id:'conversation',customer_id:'cust',event_ids:['event1'],text:'In 1 ban',idempotency_key:'key',expected_generation:0};
 await assert.rejects(port.suggest_draft({...input,event_ids:['event1','event1']}),e=>e.code==='DUPLICATE_AI_EVENTS');
 await assert.rejects(port.suggest_draft({...input,idempotency_key:''}),e=>e.code==='INVALID_AI_INPUT');
 await assert.rejects(port.suggest_draft({...input,expected_generation:-1}),e=>e.code==='INVALID_AI_GENERATION');
 await assert.rejects(port.suggest_draft({...input,text:''}),e=>e.code==='INVALID_AI_INPUT');
 assert.equal(db.count(),0);
});
test('routing only accepts bounded reason and verified event identifiers',async()=>{
 const db=fakeStore();const port=createAiOrderPort({store:db.store,trusted});
 const req={conversation_id:'conversation',reason:'Need staff',event_ids:['one'],expected_generation:0};
 await assert.rejects(port.route_human({...req,reason:' '}),e=>e.code==='INVALID_AI_INPUT');
 await assert.rejects(port.route_human({...req,event_ids:[]}),e=>e.code==='INVALID_AI_EVENTS');
 await assert.rejects(port.route_human({...req,expected_generation:Number.MAX_SAFE_INTEGER+1}),e=>e.code==='INVALID_AI_GENERATION');
 assert.equal(db.count(),0);
});
