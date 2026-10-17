const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const root=process.env.AI1_BUILD_DIR||path.resolve(__dirname,'../../../.ai1-build/backend');
const {PgStore}=require(path.join(root,'storage/database.js'));
const {createTn005SealedOutbox}=require(path.join(root,'core/tn005-sealed-outbox.js'));
test('TN005 no AI0 byte verifier means no outbox Port, never trust an AI2 boolean',()=>{
 const store=new PgStore({connect:async()=>{throw Error('not called')},query:async()=>{throw Error('not called')}});
 assert.throws(()=>createTn005SealedOutbox({store,trusted:{shop_id:'shop',oa_id:'oa'}}),
  e=>e.code==='TN005_PORT_UNCONFIGURED');
 assert.throws(()=>createTn005SealedOutbox({store,trusted:{shop_id:'',oa_id:'oa'},verify_sealed_source:async()=>true}),
  e=>e.code==='TN005_PORT_UNCONFIGURED');
});
