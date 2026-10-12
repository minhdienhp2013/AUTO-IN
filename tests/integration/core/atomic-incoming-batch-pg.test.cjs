const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const build=process.env.AI1_BUILD_DIR||path.resolve(__dirname,'../../../.ai1-build/backend');
const {PgStore}=require(path.join(build,'storage/database.js'));
const {OrderService}=require(path.join(build,'core/service.js'));
const {createIncomingBatchPort}=require(path.join(build,'core/incoming-batch-port.js'));
let pg;try{pg=require('pg');}catch{/* CI provides pg */}
const url=process.env.TEST_DATABASE_URL;
const k=p=>p+'-'+randomUUID();
const createEvent=(pool,oa,customer,conversation,eventId,kind='text',txt='')=>
 pool.query("INSERT INTO zalo_inbound_events(oa_id,event_id,customer_id,conversation_id,occurred_at,payload_json) VALUES($1,$2,$3,$4,now(),$5::jsonb)",
 [oa,eventId,customer,conversation,JSON.stringify({kind,text:txt})]);
const count=(pool,t,orderId)=>pool.query('SELECT count(*)::int AS n FROM '+t+' WHERE order_id=$1',[orderId]).then(x=>x.rows[0].n);
test('CODE-008 real PG: atomic same chat across batches, duplicate ACK and explicit separate with 2 workers',
 {skip:!pg||!url?'Requires isolated TEST_DATABASE_URL/pg':false},async()=>{
 const a=new pg.Pool({connectionString:url,max:5}),b=new pg.Pool({connectionString:url,max:5});
 try{
  const db=(await a.query('SELECT current_database() name')).rows[0].name;
  assert.match(db,/test/i);const [pa,pb]=await Promise.all([a.query('SELECT pg_backend_pid() pid'),b.query('SELECT pg_backend_pid() pid')]);
  assert.notEqual(pa.rows[0].pid,pb.rows[0].pid);
  await a.query(fs.readFileSync(path.resolve(__dirname,'../../../backend/storage/migrations/007_active_order_inbound.sql'),'utf8'));
  const shop=k('code008-atomic'),oa=k('oa'),customer=k('cust'),conversation=k('chat'),staffId=randomUUID();
  await a.query('INSERT INTO core_shop_settings(shop_id) VALUES($1)',[shop]);
  await a.query("INSERT INTO core_users(id,shop_id,username,password_hash,role) VALUES($1,$2,'staff','fixture-test-only','staff')",[staffId,shop]);
  const processor={id:'verified-fixture-processor',shop_id:shop,role:'processor',verified:true};
  const trusted={shop_id:shop,oa_id:oa},svc=new OrderService(new PgStore(a));
  const x=createIncomingBatchPort({store:new PgStore(a),trusted,processor});
  const y=createIncomingBatchPort({store:new PgStore(b),trusted,processor});
  const first=k('event');await createEvent(a,oa,customer,conversation,first,'text','In tài liệu');
  const input={scope:{oa_id:oa,customer_id:customer,conversation_id:conversation},
   expected_generation:0,event_ids:[first],text:'In tài liệu',idempotency_key:k('init'),
   intent:'append_or_create',changes:['print_request']};
  const [r1,r2]=await Promise.all([x.apply_incoming_batch(input),y.apply_incoming_batch({...input,idempotency_key:k('retry')})]);
  assert.deepEqual([r1.status,r2.status].sort(),['created','existing']);
  assert.equal(r1.order_id,r2.order_id);const orderId=r1.order_id;
  assert.equal(await count(a,'core_print_jobs',orderId),0);
  assert.equal(await count(a,'core_approvals',orderId),0);
  const next=k('file');
  await createEvent(a,oa,customer,conversation,next,'file');
  const append={...input,event_ids:[next],text:'Gửi thêm file',changes:['attachment'],idempotency_key:k('append')};
  const [s1,s2]=await Promise.all([x.apply_incoming_batch(append),y.apply_incoming_batch({...append,idempotency_key:k('replay')})]);
  assert.deepEqual([s1.status,s2.status].sort(),['appended','existing']);
  assert.equal(s1.order_id,orderId);assert.equal(s2.order_id,orderId);
  const active=(await a.query('SELECT active_revision FROM core_orders WHERE id=$1',[orderId])).rows[0].active_revision;
  assert.equal(active,2,'same order; one revision bump only');
  assert.equal(await count(a,'core_order_supplement_batches',orderId),1);
  const newer=(await a.query('SELECT plan,request_data,request_hash FROM core_revisions WHERE order_id=$1 AND revision=$2',[orderId,2])).rows[0];
  assert.equal(newer.plan,null,'must require processor to verify new files');
  assert.ok(newer.request_data.event_ids.includes(first)&&newer.request_data.event_ids.includes(next));
  const pending=await x.pending_updates({order_id:orderId});
  assert.equal(pending.status,'PENDING');assert.equal(pending.revision,2);
  assert.equal(pending.request_hash,newer.request_hash);
  assert.equal((await svc.getOrder({id:staffId,shop_id:shop,verified:true,role:'staff'},orderId)).current.pending_updates.status,'PENDING');
  const third=k('late');await createEvent(a,oa,customer,conversation,third,'text','Đổi khổ A4');
  const added=await y.apply_incoming_batch({...input,event_ids:[third],changes:['paper'],text:'Đổi khổ A4',
   idempotency_key:k('late')});
  assert.equal(added.status,'appended');assert.equal(added.active_revision,3);
  assert.equal(added.order_id,orderId);
  assert.equal(await count(a,'core_order_supplement_batches',orderId),2);
  // Genuine explicit second order: text must come from verified inbound, not classifier alone.
  const explicit=k('separate');await createEvent(a,oa,customer,conversation,explicit,'text','Cho một đơn riêng');
  const second=await x.apply_incoming_batch({...input,event_ids:[explicit],text:'Cho một đơn riêng',
   intent:'explicit_separate',idempotency_key:k('separate')});
  assert.equal(second.status,'created');assert.notEqual(second.order_id,orderId);
  const ambiguous=k('ambiguous');await createEvent(a,oa,customer,conversation,ambiguous,'text','In thêm');
  const amb=await y.apply_incoming_batch({...input,event_ids:[ambiguous],text:'In thêm',idempotency_key:k('amb')});
  assert.deepEqual(amb,{status:'ambiguous'});
  assert.equal((await a.query('SELECT count(*)::int n FROM core_orders WHERE shop_id=$1',[shop])).rows[0].n,2);
  const stale=k('stale');await createEvent(a,oa,customer,conversation,stale,'text','In tiếp');
  const control=await a.query("UPDATE core_conversation_controls SET generation=1,status='HUMAN',claimed_by=NULL WHERE shop_id=$1 AND conversation_id=$2",[shop,conversation]);
  assert.equal(control.rowCount,1);
  assert.deepEqual(await x.apply_incoming_batch({...input,event_ids:[stale],idempotency_key:k('stale')}),{status:'stale_generation'});
  assert.equal((await a.query('SELECT count(*)::int n FROM core_order_inbound_reviews WHERE oa_id=$1 AND event_id=$2',[oa,stale])).rows[0].n,0);
  await assert.rejects(y.apply_incoming_batch({...input,scope:{...input.scope,oa_id:'wrong'}}),e=>e.code==='INCOMING_OA_SCOPE_DENIED');
 }finally{await Promise.all([a.end(),b.end()]);}
});
