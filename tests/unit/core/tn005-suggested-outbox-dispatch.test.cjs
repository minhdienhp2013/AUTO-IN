const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const root=process.env.AI1_BUILD_DIR||path.resolve(__dirname,'../../../.ai1-build/backend');
const {TN005_DISPATCH_BATCH_MAX,createSyntheticTn005SuggestedOutboxTick}=require(
 path.join(root,'jobs/tn005-suggested-outbox-dispatch.js'));

test('TN005 synthetic dispatch enforces hard batch cap and only calls Core boundaries',async()=>{
 let queryArgs, reserved=0, delivered=0, sends=0;
 const pool={async query(sql,args){
  assert.match(sql,/status='QUEUED'/);
  queryArgs=args;
  return {rows:Array.from({length:50},(_,n)=>({outbound_id:`outbound-${n}`})),rowCount:50};
 }};
 const core={
  async reserve(outbound_id){reserved++;return {outbound_id,token:`lease-${outbound_id}`};},
  async deliverReserved(lease,sender){
   delivered++;
   await sender.send_text(`conversation-${lease.outbound_id}`,'synthetic question');
   return 'sent';
  }
 };
 const tick=createSyntheticTn005SuggestedOutboxTick({pool,trusted:{shop_id:'shop',oa_id:'oa'},core,
  sender:{kind:'synthetic_test',async send_text(){sends++;}}});
 assert.deepEqual(await tick.tick(),{selected:TN005_DISPATCH_BATCH_MAX,
  sent:TN005_DISPATCH_BATCH_MAX,blocked:0,unknown:0});
 assert.equal(queryArgs[2],TN005_DISPATCH_BATCH_MAX);
 assert.equal(reserved,TN005_DISPATCH_BATCH_MAX);
 assert.equal(delivered,TN005_DISPATCH_BATCH_MAX);
 assert.equal(sends,TN005_DISPATCH_BATCH_MAX);
});

test('TN005 synthetic dispatch rejects an untagged sender before reading the queue',()=>{
 let queries=0;
 assert.throws(()=>createSyntheticTn005SuggestedOutboxTick({
  pool:{async query(){queries++;return {rows:[],rowCount:0};}},
  trusted:{shop_id:'shop',oa_id:'oa'},core:{async reserve(){return null;},async deliverReserved(){return 'blocked';}},
  sender:{async send_text(){}}
 }),/synthetic test sender/);
 assert.equal(queries,0);
});
