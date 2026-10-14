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
let pg;try{pg=require('pg');}catch{/* pg installed by root CI */}
const url=process.env.TEST_DATABASE_URL,ready=Boolean(pg&&url);
const k=p=>p+'-'+randomUUID();
async function inbound(pool,oa,conv,customer,id,kind='text',future=false){
 await pool.query("INSERT INTO zalo_inbound_events(oa_id,event_id,conversation_id,customer_id,occurred_at,payload_json) VALUES($1,$2,$3,$4,now()+($5::int*interval '1 second'),$6::jsonb)",
 [oa,id,conv,customer,future?60:0,JSON.stringify({kind,fixture:true})]);
}
const n=async(pool,table,order)=>Number((await pool.query(
 'SELECT count(*)::int AS n FROM '+table+' WHERE order_id=$1',[order])).rows[0].n);
test('REAL PostgreSQL CODE-008: pending inbound blocks approval; append same order with 2 pools',
 {skip:!ready&&'Requires isolated TEST_DATABASE_URL and pg'},async()=>{
 const a=new pg.Pool({connectionString:url,max:5}),b=new pg.Pool({connectionString:url,max:5});
 try{
  const name=(await a.query('SELECT current_database() AS name')).rows[0].name;
  assert.match(name,/test/i,'Refuse non-test database');
  const [pa,pb]=await Promise.all([a.query('SELECT pg_backend_pid() pid'),b.query('SELECT pg_backend_pid() pid')]);
  assert.notEqual(pa.rows[0].pid,pb.rows[0].pid,'two independent DB connections');
  await a.query(fs.readFileSync(path.resolve(__dirname,'../../../backend/storage/migrations/005_ai_order_port.sql'),'utf8'));
  await a.query(fs.readFileSync(path.resolve(__dirname,'../../../backend/storage/migrations/007_active_order_inbound.sql'),'utf8'));
  const shop=k('code008-shop'),oa=k('code008-oa'),conv=k('chat'),customer=k('customer'),staffId=randomUUID();
  await a.query('INSERT INTO core_shop_settings(shop_id) VALUES($1)',[shop]);
  await a.query("INSERT INTO core_users(id,shop_id,username,password_hash,role) VALUES($1,$2,'staff','fixture-only','staff')",[staffId,shop]);
  const staff={id:staffId,shop_id:shop,role:'staff',verified:true};
  const processor={id:'verified-processor',shop_id:shop,role:'processor',verified:true};
  const customerPrincipal={id:'verified-test-only',shop_id:shop,role:'customer',customer_id:customer,verified:true};
  const storeA=new PgStore(a),storeB=new PgStore(b);
  const svcA=new OrderService(storeA),svcB=new OrderService(storeB);
  const draftA=createAiOrderPort({store:storeA,trusted:{shop_id:shop,oa_id:oa}});
  const supplementA=createOrderSupplementPort({store:storeA,trusted:{shop_id:shop,oa_id:oa}});
  const supplementB=createOrderSupplementPort({store:storeB,trusted:{shop_id:shop,oa_id:oa}});
  const firstEvent=k('start');await inbound(a,oa,conv,customer,firstEvent);
  const draft=await draftA.suggest_draft({conversation_id:conv,customer_id:customer,event_ids:[firstEvent],
   text:'In trang đầu',expected_generation:0,idempotency_key:k('initial')});
  assert.equal(draft.status,'created');
  const orderId=draft.order_id;
  const plan={request_hash:'',physical_sheets:1,document_pages:1,printed_faces:1,ready:true,
   printer_id:'RMP7000',artifact_ref:'public-fixture/preview',verified_by:processor.id};
  const initial=(await a.query('SELECT request_hash FROM core_revisions WHERE order_id=$1 AND revision=1',[orderId])).rows[0];
  await svcA.publishVerifiedPlan(processor,orderId,{expected_revision:1,
   plan:{...plan,request_hash:initial.request_hash},idempotency_key:k('plan')});
  await svcA.confirm(customerPrincipal,orderId,{expected_revision:2,kind:'request',idempotency_key:k('confirm-old')});

  const file=k('file');await inbound(a,oa,conv,customer,file,'file',true);
  await assert.rejects(svcA.approve(staff,orderId,{
   expected_revision:2,acknowledge_deposit_shortage:true,idempotency_key:k('approve-pending')}),
   e=>e.code==='PENDING_INBOUND_REVIEW','file committed in DB blocks approval even with future provider timestamp');
  const append={order_id:orderId,conversation_id:conv,customer_id:customer,
   event_ids:[file],expected_revision:2,idempotency_key:k('append')};
  const [u,v]=await Promise.all([
   supplementA.append_verified_events(processor,append),
   supplementB.append_verified_events(processor,{...append,idempotency_key:k('duplicate-retry')})
  ]);
  assert.deepEqual([u.status,v.status].sort(),['appended','existing']);
  assert.equal(u.revision,3);assert.equal(v.revision,3);
  assert.equal(await n(a,'core_order_supplement_batches',orderId),1);
  assert.equal(await n(a,'core_order_inbound_reviews',orderId),1);
  assert.equal(await n(a,'core_print_jobs',orderId),0);
  assert.equal((await a.query('SELECT active_revision FROM core_orders WHERE id=$1',[orderId])).rows[0].active_revision,3);
  const r3=(await a.query('SELECT * FROM core_revisions WHERE order_id=$1 AND revision=3',[orderId])).rows[0];
  assert.equal(r3.plan,null);
  assert.ok(r3.request_data.event_ids.includes(firstEvent)&&r3.request_data.event_ids.includes(file));
  await assert.rejects(svcB.approve(staff,orderId,{expected_revision:2,
   acknowledge_deposit_shortage:true,idempotency_key:k('old-approval')}),e=>e.code==='STALE_REVISION');
  await assert.rejects(svcA.approve(staff,orderId,{expected_revision:3,
   acknowledge_deposit_shortage:true,idempotency_key:k('without-plan')}),e=>e.code==='PRINT_NOT_READY');
  const late=k('late-batch');await inbound(a,oa,conv,customer,late,'text',true);
  const second=await supplementB.append_verified_events(staff,{...append,event_ids:[late],
   expected_revision:3,idempotency_key:k('batch-later')});
  assert.equal(second.status,'appended');assert.equal(second.order_id,orderId);assert.equal(second.revision,4);
  assert.equal(await n(a,'core_order_supplement_batches',orderId),2);
  const r4=(await a.query('SELECT request_hash FROM core_revisions WHERE order_id=$1 AND revision=4',[orderId])).rows[0];
  await svcA.publishVerifiedPlan(processor,orderId,{expected_revision:4,
   plan:{...plan,request_hash:r4.request_hash},idempotency_key:k('new-plan')});
  await assert.rejects(svcB.approve(staff,orderId,{expected_revision:5,
   acknowledge_deposit_shortage:true,idempotency_key:k('stale-confirmation')}),
   e=>e.code==='CUSTOMER_NOT_CONFIRMED');
  await svcA.confirm(customerPrincipal,orderId,{expected_revision:5,kind:'request',
   idempotency_key:k('fresh-confirmation')});
  const approval=await svcA.approve(staff,orderId,{expected_revision:5,
   acknowledge_deposit_shortage:true,idempotency_key:k('approved')});
  assert.ok(approval.job_id);assert.equal(await n(a,'core_approvals',orderId),1);
  const afterApprove=k('post-approval');await inbound(a,oa,conv,customer,afterApprove,'image');
  await assert.rejects(supplementA.append_verified_events(processor,{
   ...append,event_ids:[afterApprove],expected_revision:5,idempotency_key:k('after-approve')}),
   e=>e.code==='ORDER_ALREADY_FINALIZED');
  assert.equal((await a.query('SELECT active_revision FROM core_orders WHERE id=$1',[orderId])).rows[0].active_revision,5);
  assert.equal(await n(a,'core_print_jobs',orderId),1);

  const otherConv=k('other-chat'),otherEvent=k('first');
  await inbound(a,oa,otherConv,customer,otherEvent);
  const other=await draftA.suggest_draft({conversation_id:otherConv,customer_id:customer,
   event_ids:[otherEvent],text:'In đơn thứ hai',idempotency_key:k('second-draft'),expected_generation:0});
  const initial2=(await a.query('SELECT request_hash FROM core_revisions WHERE order_id=$1 AND revision=1',[other.order_id])).rows[0];
  await svcA.publishVerifiedPlan(processor,other.order_id,{expected_revision:1,
   plan:{...plan,request_hash:initial2.request_hash},idempotency_key:k('second-plan')});
  await svcA.confirm(customerPrincipal,other.order_id,{expected_revision:2,kind:'request',idempotency_key:k('second-confirm')});
  const pending=k('race-file');await inbound(a,oa,otherConv,customer,pending,'image',true);
  const [approvalRace,appendRace]=await Promise.allSettled([
   svcA.approve(staff,other.order_id,{expected_revision:2,acknowledge_deposit_shortage:true,idempotency_key:k('race-approve')}),
   supplementB.append_verified_events(processor,{order_id:other.order_id,
    conversation_id:otherConv,customer_id:customer,event_ids:[pending],
    expected_revision:2,idempotency_key:k('race-append')})
  ]);
  assert.equal(approvalRace.status,'rejected');
  assert.ok(['PENDING_INBOUND_REVIEW','STALE_REVISION'].includes(approvalRace.reason.code));
  assert.equal(appendRace.status,'fulfilled');assert.equal(appendRace.value.status,'appended');
  assert.equal(await n(a,'core_approvals',other.order_id),0);
  assert.equal(await n(a,'core_print_jobs',other.order_id),0);
  await assert.rejects(supplementA.append_verified_events(staff,{
    order_id:other.order_id,conversation_id:otherConv,customer_id:customer,
    event_ids:[k('missing')],expected_revision:3,idempotency_key:k('unknown')}),
   e=>e.code==='SUPPLEMENT_EVENTS_UNVERIFIED');
 }finally{await Promise.all([a.end(),b.end()]);}
});
