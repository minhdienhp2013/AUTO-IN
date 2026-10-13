const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const root=process.env.AI1_BUILD_DIR||path.resolve(__dirname,'../../../.ai1-build/backend');
const {createVerifiedConfirmationPort}=require(path.join(root,'core/verified-confirmation-port.js'));
const {sha}=require(path.join(root,'core/model.js'));
const trusted={shop_id:'trusted-test-shop',oa_id:'trusted-test-oa'};
const valid={order_id:'a7eac614-b9cd-47cd-bb87-9cb63cb9baf1',expected_revision:2,request_hash:sha('example'),kind:'request',expected_generation:0};
const mock={tx:async()=>{throw Error('Unexpected database access');}};
test('CODE-401: trusted scope is mandatory; untrusted config never constructs a Port',()=>{
 assert.throws(()=>createVerifiedConfirmationPort({store:mock,trusted:{shop_id:'',oa_id:'x'}}),e=>e.code==='CONFIRMATION_PORT_NOT_CONFIGURED');
 assert.throws(()=>createVerifiedConfirmationPort({store:mock,trusted:{shop_id:'shop',oa_id:''}}),e=>e.code==='CONFIRMATION_PORT_NOT_CONFIGURED');
 assert.doesNotThrow(()=>createVerifiedConfirmationPort({store:mock,trusted}));
});
test('CODE-401: malformed revision/hash/quote/challenge event rejects BEFORE transaction',async()=>{
 const port=createVerifiedConfirmationPort({store:mock,trusted});
 for(const change of [
  {expected_revision:0},{expected_generation:-1},{request_hash:'not-hash'},
  {kind:'quote'},{kind:'request',quote_revision:1},{kind:'unknown'},
 ]){
  await assert.rejects(port.issue_challenge({...valid,...change}),e=>e.code==='INVALID_CONFIRMATION_INPUT');
 }
 await assert.rejects(port.confirm_verified_event({...valid,event_id:''}),e=>e.code==='INVALID_CONFIRMATION_INPUT');
});
