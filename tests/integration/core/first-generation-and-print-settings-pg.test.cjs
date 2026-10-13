const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const path=require('node:path');
const fs=require('node:fs');
const root=process.env.AI1_BUILD_DIR||path.resolve(__dirname,'../../../.ai1-build/backend');
const {PgStore}=require(path.join(root,'storage/database.js'));
const {OrderService}=require(path.join(root,'core/service.js'));
const {createOrderSupplementPort}=require(path.join(root,'core/order-supplement-port.js'));
let pg;try{pg=require('pg')}catch{/* real PG only */}
const url=process.env.TEST_DATABASE_URL;
const key=name=>name+'-'+randomUUID();
async function event(pool,oa,conv,customer,id,text,kind='text',received=null,occurred=null){
 await pool.query("INSERT INTO zalo_inbound_events(oa_id,event_id,conversation_id,customer_id,occurred_at,received_at,payload_json) VALUES($1,$2,$3,$4,COALESCE($5::timestamptz,now()),COALESCE($6::timestamptz,now()),$7::jsonb)",
 [oa,id,conv,customer,occurred,received,JSON.stringify({kind,text})]);
}
test('REAL PostgreSQL CODE-008 P0: first generation, parameter revisions, approved new order, delayed event', 
 {skip:!(pg&&url)&&'Requires isolated PostgreSQL TEST_DATABASE_URL and pg'},async()=>{
 const a=new pg.Pool({connectionString:url,max:5}),b=new pg.Pool({connectionString:url,max:5});
 try{
  assert.match((await a.query('SELECT current_database() db')).rows[0].db,/test/i);
  const [pidA,pidB]=await Promise.all([a.query('SELECT pg_backend_pid() pid'),b.query('SELECT pg_backend_pid() pid')]);
  assert.notEqual(pidA.rows[0].pid,pidB.rows[0].pid);
  await a.query(fs.readFileSync(path.resolve(__dirname,'../../../backend/storage/migrations/007_active_order_inbound.sql'),'utf8'));
  const shop=key('shop'),oa=key('oa'),conv=key('chat'),customer=key('customer');
  const processor={id:'server-verified-processor',role:'processor',shop_id:shop,verified:true};
  await a.query('INSERT INTO core_shop_settings(shop_id) VALUES($1)',[shop]);
  const storeA=new PgStore(a),storeB=new PgStore(b),service=new OrderService(storeA);
  const portA=createOrderSupplementPort({store:storeA,trusted:{shop_id:shop,oa_id:oa},processor});
  const portB=createOrderSupplementPort({store:storeB,trusted:{shop_id:shop,oa_id:oa},processor});
  const staleConv=key('uninitialized'),staleEvent=key('stale-first');
  await event(a,oa,staleConv,customer,staleEvent,'In tài liệu bất kỳ');
  assert.deepEqual(await portA.apply_incoming_batch({
   conversation_id:staleConv,customer_id:customer,event_ids:[staleEvent],
   text:'In tài liệu bất kỳ',idempotency_key:key('wrong-gen'),
   expected_generation:7,intent:'append_or_create',materialized:true
  }),{status:'stale_generation'});
  assert.equal((await a.query('SELECT count(*)::int n FROM core_conversation_controls WHERE shop_id=$1 AND conversation_id=$2',[shop,staleConv])).rows[0].n,0);
  const first=key('initial');
  await event(a,oa,conv,customer,first,'In tài liệu đầu tiên');
  const initial={conversation_id:conv,customer_id:customer,event_ids:[first],
   text:'In tài liệu đầu tiên',idempotency_key:key('first'),expected_generation:0,
   intent:'append_or_create',materialized:true};
  assert.equal((await a.query('SELECT count(*)::int n FROM core_conversation_controls WHERE shop_id=$1 AND conversation_id=$2',[shop,conv])).rows[0].n,0);
  const [one,two]=await Promise.all([
   portA.apply_incoming_batch(initial),
   portB.apply_incoming_batch({...initial,idempotency_key:key('concurrent')})
  ]);
  assert.deepEqual([one.status,two.status].sort(),['created','existing']);
  assert.equal(one.order_id,two.order_id);
  const orderId=one.order_id;
  assert.equal((await a.query('SELECT count(*)::int n FROM core_orders WHERE shop_id=$1 AND conversation_id=$2',[shop,conv])).rows[0].n,1);
  assert.equal((await a.query('SELECT generation::text generation,status FROM core_conversation_controls WHERE shop_id=$1 AND conversation_id=$2',[shop,conv])).rows[0].generation,'0');
  const old=await portB.apply_incoming_batch({...initial,idempotency_key:key('lost-ack')});
  assert.equal(old.status,'existing');

  let revision=1;
  for(const [content,field,want] of [
   ['in 3 bản','copies',3],['đổi khổ giấy sang A3','paper_size','A3'],['in hai mặt','duplex',true]
  ]){
   const evt=key('change');await event(a,oa,conv,customer,evt,content);
   const updated=await portA.apply_incoming_batch({...initial,event_ids:[evt],
    expected_revision:revision,text:content,idempotency_key:key('update')});
   assert.equal(updated.status,'appended',content);
   assert.equal(updated.order_id,orderId);
   revision++;
   assert.equal(updated.revision,revision);
   const row=(await a.query('SELECT request_data,plan FROM core_revisions WHERE order_id=$1 AND revision=$2',[orderId,revision])).rows[0];
   assert.equal(row.request_data[field],want,'trusted text updates required field');
   assert.equal(row.plan,null);
  }
  assert.equal(revision,4);
  const spelled=key('spelled');await event(a,oa,conv,customer,spelled,'in ba bản');
  const unclearCount=await portA.apply_incoming_batch({...initial,event_ids:[spelled],
   expected_revision:4,text:'in ba bản',idempotency_key:key('spoken-unclear')});
  assert.equal(unclearCount.status,'needs_review','uncertain spoken quantities must not ACK');
  await a.query('DELETE FROM zalo_inbound_events WHERE oa_id=$1 AND event_id=$2',[oa,spelled]);
  const ambiguous=key('unclear');await event(a,oa,conv,customer,ambiguous,'in 2 bản khổ A4');
  const hold=await portB.apply_incoming_batch({...initial,event_ids:[ambiguous],
   expected_revision:4,text:'in 2 bản khổ A4',idempotency_key:key('unclear')});
  assert.equal(hold.status,'needs_review');
  assert.equal((await a.query('SELECT active_revision FROM core_orders WHERE id=$1',[orderId])).rows[0].active_revision,4);
  assert.equal((await a.query('SELECT count(*)::int n FROM core_order_inbound_reviews WHERE event_id=$1',[ambiguous])).rows[0].n,0);
  // Remove the held synthetic event from this fixture only, to independently test valid staff approval.
  await a.query('DELETE FROM zalo_inbound_events WHERE oa_id=$1 AND event_id=$2',[oa,ambiguous]);
  const rev4=(await a.query('SELECT request_hash FROM core_revisions WHERE order_id=$1 AND revision=4',[orderId])).rows[0];
  const printPlan={request_hash:rev4.request_hash,physical_sheets:1,document_pages:1,printed_faces:1,
   ready:true,printer_id:'RMP7000',artifact_ref:'verified-fixture',verified_by:processor.id};
  const published=await service.publishVerifiedPlan(processor,orderId,{
   expected_revision:4,plan:printPlan,idempotency_key:key('plan')});
  assert.ok(published);
  const staffId=randomUUID();
  await a.query("INSERT INTO core_users(id,shop_id,username,password_hash,role) VALUES($1,$2,'staff','fixture-only','staff')",[staffId,shop]);
  const staff={id:staffId,shop_id:shop,role:'staff',verified:true};
  const customerPrincipal={id:'fixture-customer-credential',shop_id:shop,role:'customer',customer_id:customer,verified:true};
  const beforeConfirm=await service.getOrder(staff,orderId);
  assert.equal(beforeConfirm.current.request_confirmed,false);
  const approvedRevision=beforeConfirm.current.revision;
  await service.confirm(customerPrincipal,orderId,{
   expected_revision:approvedRevision,kind:'request',idempotency_key:key('customer-confirm')});
  const done=await service.approve(staff,orderId,{
   expected_revision:approvedRevision,acknowledge_deposit_shortage:true,idempotency_key:key('staff-approve')});
  assert.ok(done.job_id);
  const parameterOnly=key('after-approved-parameter');
  await event(a,oa,conv,customer,parameterOnly,'in 2 bản');
  const postApprovalSetting=await portA.apply_incoming_batch({...initial,
   event_ids:[parameterOnly],text:'in 2 bản',idempotency_key:key('post-approval-setting')});
  assert.equal(postApprovalSetting.status,'needs_review','cannot assume a post-approval setting update is a new order');
  assert.equal((await a.query('SELECT count(*)::int n FROM core_orders WHERE shop_id=$1 AND conversation_id=$2',[shop,conv])).rows[0].n,1);
  const newEvent=key('after-approval');await event(a,oa,conv,customer,newEvent,'In thêm tài liệu mới');
  const fresh=await portB.apply_incoming_batch({...initial,event_ids:[newEvent],
   expected_revision:undefined,text:'In thêm tài liệu mới',idempotency_key:key('fresh-order')});
  assert.equal(fresh.status,'created');
  assert.notEqual(fresh.order_id,orderId);
  assert.equal((await a.query('SELECT count(*)::int n FROM core_orders WHERE shop_id=$1 AND conversation_id=$2',[shop,conv])).rows[0].n,2);
  assert.equal((await a.query('SELECT count(*)::int n FROM core_print_jobs WHERE order_id=$1',[fresh.order_id])).rows[0].n,0);
  // A provider-clock-future event whose trusted receipt time predates staff approval
  // is a delayed OLD request, not another new order.
  const lagged=key('delayed');
  const approvedAt=(await a.query('SELECT created_at FROM core_approvals WHERE order_id=$1',[orderId])).rows[0].created_at;
  const before=new Date(new Date(approvedAt).getTime()-30000);
  const after=new Date(new Date(approvedAt).getTime()+60000);
  await event(a,oa,conv,customer,lagged,'In tài liệu cũ','text',before,after);
  const late=await portA.apply_incoming_batch({...initial,event_ids:[lagged],
   expected_revision:undefined,text:'In tài liệu cũ',idempotency_key:key('late')});
  assert.equal(late.status,'needs_review');
  assert.equal((await a.query('SELECT count(*)::int n FROM core_orders WHERE shop_id=$1 AND conversation_id=$2',[shop,conv])).rows[0].n,2);
 }finally{await Promise.all([a.end(),b.end()]);}
});
