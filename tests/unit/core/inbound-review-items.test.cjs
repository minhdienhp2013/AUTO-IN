const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const root=process.env.AI1_BUILD_DIR||path.resolve(__dirname,'../../../dist/backend');
const {createOfficialInboundReviewItems,createInboundReviewReader}=require(path.join(root,'core/inbound-review-items.js'));
const qid='123e4567-e89b-42d3-a456-426614174000';
const sha='a'.repeat(64);
const trusted={shop_id:'shop-a',oa_id:'oa-a'};
const staff={id:'staff-a',shop_id:'shop-a',role:'staff',verified:true};

function fakeStore({known=true,fail=false,trustedScope=trusted}={}){
 const state={items:new Map(),audits:[],quarantine:{id:qid,shop_id:'shop-a',oa_id:'oa-a',raw_sha256:sha,kind:'image',status:'NEEDS_HUMAN',
  customer_id:'customer-a',conversation_id:'conversation-a',received_at:new Date('2026-10-18T00:00:00Z')}};
 const db={async query(sql,args=[]){
  if(fail)throw Error('database unavailable');
  if(sql.includes('to_regclass'))return {rows:[{registry:'registry',quarantine:'quarantine',scopes:'scopes',items:'items'}],rowCount:1};
  if(sql.startsWith('INSERT INTO public.zalo_official_quarantine_scopes'))return {rows:[],rowCount:0};
  if(sql.startsWith('SELECT oa_id FROM public.zalo_official_quarantine_scopes'))return {rows:[{oa_id:trustedScope.oa_id}],rowCount:1};
  if(sql.includes('FROM public.zalo_official_quarantine q'))return {rows:known&&args[0]===state.quarantine.shop_id&&args[1]===state.quarantine.oa_id&&args[2]===qid?[state.quarantine]:[],rowCount:known?1:0};
  if(sql.startsWith('INSERT INTO core_inbound_review_items')){
   const [id,shop_id,oa_id,quarantine_id,raw_event_sha256,kind,customer_id,conversation_id,received_at]=args;
   const key=[shop_id,oa_id,quarantine_id].join(':');
   if(state.items.has(key))return {rows:[],rowCount:0};
   state.items.set(key,{id,shop_id,oa_id,quarantine_id,raw_event_sha256,kind,customer_id,conversation_id,
    status:'NEEDS_HUMAN',media_state:'AWAITING_MEDIA',received_at});
   return {rows:[{id}],rowCount:1};
  }
  if(sql.startsWith('INSERT INTO core_inbound_review_audit_events')){state.audits.push(JSON.parse(args[4]));return {rows:[],rowCount:1};}
  if(sql.startsWith('SELECT id::text,raw_event_sha256')){
   const row=[...state.items.values()].find(x=>x.shop_id===args[0]&&x.oa_id===args[1]&&x.quarantine_id===args[2]);
   return {rows:row?[row]:[],rowCount:row?1:0};
  }
  throw Error('unexpected SQL '+sql);
 },release(){}};
 const store={async tx(fn){return fn(db)},pool:{async query(sql,args){
  const rows=[...state.items.values()].filter(x=>x.shop_id===args[0]).map(x=>({id:x.id,
   raw_event_sha256:x.raw_event_sha256,kind:x.kind,mapped_customer:x.customer_id!==null,
   status:x.status,media_state:x.media_state,received_at:x.received_at}));
  return {rows,rowCount:rows.length};
 }}};
 return {store,state};
}

test('official file/image quarantine becomes one auditable staff item; replay never resolves media or creates an order',async()=>{
 const {store,state}=fakeStore(),port=createOfficialInboundReviewItems({store,trusted}),reader=createInboundReviewReader({store});
 const first=await port.enqueue_quarantined_event(qid);
 const replay=await port.enqueue_quarantined_event(qid);
 assert.equal(first.status,'created');assert.equal(replay.status,'existing');
 assert.equal(replay.item_id,first.item_id);assert.equal(state.items.size,1);assert.equal(state.audits.length,1);
 assert.equal([...state.items.values()][0].raw_event_sha256,sha);
 assert.equal([...state.items.values()][0].media_state,'AWAITING_MEDIA');
 assert.equal(state.quarantine.status,'NEEDS_HUMAN');
 const queued=await reader.list_for_staff(staff);
 assert.equal(queued.length,1);assert.equal(queued[0].id,first.item_id);
 assert.equal(queued[0].kind,'image');
 assert.equal(queued[0].mapped_customer,true);assert.equal(queued[0].status,'NEEDS_HUMAN');
 assert.equal(queued[0].media_state,'AWAITING_MEDIA');
 assert.deepEqual(Object.keys(queued[0]).sort(),['id','kind','mapped_customer','media_state','raw_event_sha256','received_at','status'].sort());
 assert.ok(!('order_id' in [...state.items.values()][0]));
});

test('wrong tenant cannot create an item and staff list is tenant scoped',async()=>{
 const {store}=fakeStore(),port=createOfficialInboundReviewItems({store,trusted}),reader=createInboundReviewReader({store});
 await port.enqueue_quarantined_event(qid);
 const otherStaff={id:'staff-b',shop_id:'shop-b',role:'staff',verified:true};
 assert.deepEqual(await reader.list_for_staff(otherStaff),[]);
 const wrongTrusted={shop_id:'shop-b',oa_id:'oa-b'};
 const wrongScope=createOfficialInboundReviewItems({store:fakeStore({trustedScope:wrongTrusted}).store,trusted:wrongTrusted});
 await assert.rejects(wrongScope.enqueue_quarantined_event(qid),e=>e.code==='QUARANTINE_SOURCE_NOT_PENDING');
 await assert.rejects(reader.list_for_staff({id:'customer',shop_id:'shop-a',role:'customer',verified:true}),
  e=>e.code==='FORBIDDEN');
});

test('missing media/quarantine storage and database failure fail closed',async()=>{
 const missing=fakeStore({known:false}),port=createOfficialInboundReviewItems({store:missing.store,trusted});
 await assert.rejects(port.enqueue_quarantined_event(qid),e=>e.code==='QUARANTINE_SOURCE_NOT_PENDING');
 assert.equal(missing.state.items.size,0);
 const broken=fakeStore({fail:true}),unavailable=createOfficialInboundReviewItems({store:broken.store,trusted});
 await assert.rejects(unavailable.enqueue_quarantined_event(qid),e=>e.code==='INBOUND_REVIEW_UNAVAILABLE');
 assert.equal(broken.state.items.size,0);
 await assert.rejects(port.enqueue_quarantined_event('not-a-uuid'),e=>e.code==='INVALID_QUARANTINE_ID');
});
