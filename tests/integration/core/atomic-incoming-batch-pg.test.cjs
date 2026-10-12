const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const root=process.env.AI1_BUILD_DIR||path.resolve(__dirname,'../../../.ai1-build/backend');
const {PgStore}=require(path.join(root,'storage/database.js'));
const {OrderService}=require(path.join(root,'core/service.js'));
const {createAiOrderPort}=require(path.join(root,'core/ai-order-port.js'));
const {createOrderSupplementPort}=require(path.join(root,'core/order-supplement-port.js'));
let pg;try{pg=require('pg');}catch{/* installed by CI */}
const url=process.env.TEST_DATABASE_URL;
const k=name=>name+'-'+randomUUID();
async function event(pool,oa,conversation,customer,id,kind='text',offset=0){
 await pool.query("INSERT INTO zalo_inbound_events(oa_id,event_id,conversation_id,customer_id,occurred_at,payload_json) VALUES($1,$2,$3,$4,now()+($5::integer * interval '1 second'),$6::jsonb)",
  [oa,id,conversation,customer,offset,JSON.stringify({kind,text:'fixture-only'})]);
}
test('REAL PostgreSQL CODE-008: atomic batch two-worker replay, separate, ambiguity, pending and takeover',
 {skip:!(pg&&url)&&'Requires actual TEST_DATABASE_URL and pg'},async()=>{
 const a=new pg.Pool({connectionString:url,max:5}),b=new pg.Pool({connectionString:url,max:5});
 try{
  const name=(await a.query('SELECT current_database() AS name')).rows[0].name;
  assert.match(name,/test/i,'Never touch production DB');
  const [pa,pb]=await Promise.all([a.query('SELECT pg_backend_pid() pid'),b.query('SELECT pg_backend_pid() pid')]);
  assert.notEqual(pa.rows[0].pid,pb.rows[0].pid);
  await a.query(fs.readFileSync(path.resolve(__dirname,'../../../backend/storage/migrations/007_active_order_inbound.sql'),'utf8'));
  const shop=k('atomic-shop'),oa=k('oa'),customer=k('customer'),conv=k('chat');
  const actor={id:'backend-verified-processor',shop_id:shop,role:'processor',verified:true};
  await a.query('INSERT INTO core_shop_settings(shop_id) VALUES($1)',[shop]);
  const storeA=new PgStore(a),storeB=new PgStore(b);
  const draftPort=createAiOrderPort({store:storeA,trusted:{shop_id:shop,oa_id:oa}});
  const authorized=scope=>createOrderSupplementPort({store:scope,trusted:{shop_id:shop,oa_id:oa},
   processor:actor,verifyExplicitSeparate:async()=>true});
  const portA=authorized(storeA),portB=authorized(storeB);
  const first=k('first');await event(a,oa,conv,customer,first);
  const initial={conversation_id:conv,customer_id:customer,event_ids:[first],
   text:'In tài liệu đầu',expected_generation:0,idempotency_key:k('original')};
  const firstDraft=await draftPort.suggest_draft(initial);
  assert.equal(firstDraft.status,'created');
  const id=firstDraft.order_id;
  const sameFirst=await portB.apply_incoming_batch({...initial,intent:'append_or_create',materialized:true,
   expected_revision:1});
  assert.equal(sameFirst.status,'existing','first draft lost ACK must not append its initial event');
  assert.equal(sameFirst.order_id,id);
  assert.equal((await a.query('SELECT active_revision FROM core_orders WHERE id=$1',[id])).rows[0].active_revision,1);

  const supplemental=k('supplement');await event(a,oa,conv,customer,supplemental,'text',90);
  const update={conversation_id:conv,customer_id:customer,event_ids:[supplemental],
   text:'In thêm tài liệu thứ hai',idempotency_key:k('update'),expected_generation:0,
   expected_revision:1,intent:'append_or_create',materialized:true};
  const [u,v]=await Promise.all([
   portA.apply_incoming_batch(update),portB.apply_incoming_batch({...update,idempotency_key:k('lost-ack')})
  ]);
  assert.deepEqual([u.status,v.status].sort(),['appended','existing']);
  assert.equal(u.order_id,id);assert.equal(v.order_id,id);
  assert.equal(u.revision,2);assert.equal(v.revision,2);
  const revision=(await a.query('SELECT plan,request_data FROM core_revisions WHERE order_id=$1 AND revision=2',[id])).rows[0];
  assert.equal(revision.plan,null,'no plan is ready until processor independently verifies files');
  assert.ok(revision.request_data.event_ids.includes(first));
  assert.ok(revision.request_data.event_ids.includes(supplemental));
  assert.equal((await a.query('SELECT count(*)::int AS n FROM core_order_supplement_batches WHERE order_id=$1',[id])).rows[0].n,1);
  const old=k('stale');await event(a,oa,conv,customer,old,'text',120);
  const stale=await portA.apply_incoming_batch({...update,event_ids:[old],
    idempotency_key:k('stale-rev'),expected_revision:1});
  assert.equal(stale.status,'stale_revision');
  assert.equal((await a.query('SELECT active_revision FROM core_orders WHERE id=$1',[id])).rows[0].active_revision,2);

  const missing=k('file');await event(a,oa,conv,customer,missing,'file',180);
  const fileReq={...update,event_ids:[missing],text:'Gửi thêm file PDF',
   expected_revision:2,idempotency_key:k('file')};
  const pending=await portA.apply_incoming_batch(fileReq);
  assert.equal(pending.status,'needs_review','file without immutable artifact must remain pending');
  assert.equal((await a.query('SELECT count(*)::int AS n FROM core_order_inbound_reviews WHERE order_id=$1 AND event_id=$2',
   [id,missing])).rows[0].n,0);
  assert.equal((await a.query('SELECT active_revision FROM core_orders WHERE id=$1',[id])).rows[0].active_revision,2);

  const other=k('new-order');await event(a,oa,conv,customer,other);
  const separate=await portA.apply_incoming_batch({...update,event_ids:[other],text:'Đơn khác, in riêng',
   expected_revision:undefined,intent:'explicit_separate',idempotency_key:k('new-order')});
  assert.equal(separate.status,'created');
  assert.notEqual(separate.order_id,id);
  assert.equal((await a.query('SELECT count(*)::int AS n FROM core_orders WHERE shop_id=$1 AND conversation_id=$2',
   [shop,conv])).rows[0].n,2);
  const ambiguity=k('ambiguous');await event(a,oa,conv,customer,ambiguity);
  const ambiguous=await portB.apply_incoming_batch({...update,event_ids:[ambiguity],
   expected_revision:undefined,idempotency_key:k('ambiguous')});
  assert.equal(ambiguous.status,'ambiguous');
  assert.equal((await a.query('SELECT count(*)::int AS n FROM core_orders WHERE shop_id=$1 AND conversation_id=$2',
   [shop,conv])).rows[0].n,2);

  // Another OA cannot hijack the selected order, even with the same conversation/customer.
  const otherPort=createOrderSupplementPort({store:storeB,trusted:{shop_id:shop,oa_id:k('wrong-oa')},processor:actor});
  await assert.rejects(otherPort.apply_incoming_batch({...update,event_ids:[supplemental]}),
   e=>e.code==='SUPPLEMENT_EVENTS_UNVERIFIED');
  const staffId=randomUUID();
  await a.query("INSERT INTO core_users(id,shop_id,username,password_hash,role) VALUES($1,$2,'staff','fixture-only','staff')",[staffId,shop]);
  const staff={id:staffId,role:'staff',shop_id:shop,verified:true};
  const core=new OrderService(storeA);
  const takeover=await core.handover(staff,conv,{expected_generation:0,idempotency_key:k('handover')});
  assert.equal(takeover.generation,1);
  const afterTakeover=await portB.apply_incoming_batch({...update,event_ids:[ambiguity],idempotency_key:k('after-takeover')});
  assert.equal(afterTakeover.status,'stale_generation');
  assert.equal((await a.query('SELECT count(*)::int AS n FROM core_order_supplement_batches WHERE order_id=$1',[id])).rows[0].n,1);
 }finally{await Promise.all([a.end(),b.end()]);}
});
