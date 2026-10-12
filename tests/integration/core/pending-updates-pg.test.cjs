const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const root=process.env.AI1_BUILD_DIR||path.resolve(__dirname,'../../../.ai1-build/backend');
const {PgStore}=require(path.join(root,'storage/database.js'));
const {OrderService}=require(path.join(root,'core/service.js'));
const {createAiOrderPort}=require(path.join(root,'core/ai-order-port.js'));
const {createOrderSupplementPort}=require(path.join(root,'core/order-supplement-port.js'));
let pg;try{pg=require('pg')}catch{/* installed on real CI */}
const url=process.env.TEST_DATABASE_URL,k=p=>p+'-'+randomUUID();
async function inbound(pool,oa,conv,customer,id,kind='text',received=null){
 await pool.query(
  "INSERT INTO zalo_inbound_events(oa_id,event_id,conversation_id,customer_id,occurred_at,received_at,payload_json) "+
  "VALUES($1,$2,$3,$4,now()+interval '90 seconds',COALESCE($5::timestamptz,now()),$6::jsonb)",
  [oa,id,conv,customer,received,JSON.stringify({kind,text:'PRIVATE-CUSTOMER-SECRET',file_name:'private-file.pdf',
    file_url:'https://private.invalid/doc',fixture:true})]);
}
async function count(pool,table,order){
 return (await pool.query('SELECT count(*)::int AS n FROM '+table+' WHERE order_id=$1',[order])).rows[0].n;
}
test('REAL PostgreSQL: current.pending_updates trustworthy journal, boundaries, 409 and two independent pools',
 {skip:!(pg&&url)&&'Requires isolated TEST_DATABASE_URL and pg'},async()=>{
 const a=new pg.Pool({connectionString:url,max:5}),b=new pg.Pool({connectionString:url,max:5});
 try{
  assert.match((await a.query('SELECT current_database() db')).rows[0].db,/test/i);
  const [pa,pb]=await Promise.all([a.query('SELECT pg_backend_pid() pid'),b.query('SELECT pg_backend_pid() pid')]);
  assert.notEqual(pa.rows[0].pid,pb.rows[0].pid);
  // CI applies migrations before tests; never run DDL concurrently with legacy core fixture.
  const journal=(await a.query("SELECT to_regclass('public.core_order_inbound_reviews')::text AS table_name")).rows[0];
  assert.ok(journal.table_name,'Migration 007 must be present before this test');
  const shop=k('pending-shop'),oa=k('pending-oa'),conv=k('pending-chat'),customer=k('pending-customer'),staffId=randomUUID();
  await a.query('INSERT INTO core_shop_settings(shop_id) VALUES($1)',[shop]);
  await a.query("INSERT INTO core_users(id,shop_id,username,password_hash,role) VALUES($1,$2,'staff','fixture-only','staff')",[staffId,shop]);
  const staff={id:staffId,shop_id:shop,role:'staff',verified:true};
  const processor={id:'verified-processor',shop_id:shop,role:'processor',verified:true};
  const customerPrincipal={id:'synthetic-customer-credential',shop_id:shop,role:'customer',customer_id:customer,verified:true};
  const store=new PgStore(a),service=new OrderService(store);
  const drafts=createAiOrderPort({store,trusted:{shop_id:shop,oa_id:oa}});
  const supplements=createOrderSupplementPort({store,trusted:{shop_id:shop,oa_id:oa}});
  const first=k('first-event');
  await inbound(a,oa,conv,customer,first);
  const proposal=await drafts.suggest_draft({conversation_id:conv,customer_id:customer,event_ids:[first],
   text:'In tài liệu',idempotency_key:k('init'),expected_generation:0});
  assert.equal(proposal.status,'created');const id=proposal.order_id;
  let read=await service.getOrder(staff,id);
  assert.deepEqual(read.current.pending_updates,{
   order_id:id,revision:1,request_hash:read.current.request_hash,status:'processing',
   unresolved_count:0,items:[]},'no verified plan is not CLEAR');
  const firstHash=read.current.request_hash;
  const plan={request_hash:firstHash,physical_sheets:1,document_pages:1,printed_faces:1,ready:true,
   printer_id:'RMP7000',artifact_ref:'fixture-public-preview',verified_by:processor.id};
  await service.publishVerifiedPlan(processor,id,{expected_revision:1,plan,idempotency_key:k('plan')});
  read=await service.getOrder(staff,id);
  assert.equal(read.current.pending_updates.status,'clear');
  assert.equal(read.current.pending_updates.unresolved_count,0);
  assert.equal(read.current.pending_updates.revision,2);
  assert.equal(read.current.pending_updates.request_hash,firstHash);
  // Same chat but wrong OA/customer/conversation must not bleed into this order.
  await Promise.all([
   inbound(a,k('other-oa'),conv,customer,k('wrong-oa'),'text'),
   inbound(a,oa,conv,k('wrong-customer'),k('wrong-customer-event'),'text'),
   inbound(a,oa,k('wrong-conv'),customer,k('wrong-conversation-event'),'image')
  ]);
  assert.equal((await service.getOrder(staff,id)).current.pending_updates.status,'clear');
  const wrongShop={...staff,shop_id:k('unauthorized-shop')};
  await assert.rejects(service.getOrder(wrongShop,id));

  // An event may claim provider time in the future: server received_at determines the gate.
  const unreviewed=k('pending-file');await inbound(b,oa,conv,customer,unreviewed,'file');
  read=await service.getOrder(staff,id);
  assert.equal(read.current.pending_updates.status,'processing');
  assert.equal(read.current.pending_updates.unresolved_count,1);
  assert.equal(read.current.pending_updates.items.length,1);
  assert.equal(read.current.pending_updates.items[0].kind,'file');
  assert.ok(read.current.pending_updates.items[0].received_at);
  const serialized=JSON.stringify(read.current.pending_updates);
  assert.ok(!serialized.includes(unreviewed));
  assert.ok(!serialized.includes('PRIVATE-CUSTOMER-SECRET'));
  assert.ok(!serialized.includes('private-file.pdf'));
  assert.ok(!serialized.includes('private.invalid'));
  await service.confirm(customerPrincipal,id,{expected_revision:2,kind:'request',idempotency_key:k('confirm')});
  await assert.rejects(service.approve(staff,id,{expected_revision:2,
   acknowledge_deposit_shortage:true,idempotency_key:k('approve-before-review')}),
   e=>e.code==='PENDING_INBOUND_REVIEW'&&e.status===409);
  assert.equal(await count(a,'core_print_jobs',id),0);

  // Same event enters a REAL core journal revision. No batch DONE shortcuts.
  const added=await supplements.append_verified_events(processor,{order_id:id,
   conversation_id:conv,customer_id:customer,event_ids:[unreviewed],
   expected_revision:2,idempotency_key:k('supplement')});
  assert.equal(added.status,'appended');
  read=await service.getOrder(staff,id);
  assert.equal(read.current.pending_updates.revision,3);
  assert.equal(read.current.pending_updates.request_hash,added.request_hash);
  assert.equal(read.current.pending_updates.unresolved_count,0);
  assert.equal(read.current.pending_updates.status,'processing','revision plan NULL until processor verifies it');
  // A journal pointing at a revision without the event is invalid evidence.
  await a.query('UPDATE core_order_inbound_reviews SET revision=2 WHERE event_id=$1 AND oa_id=$2',
   [unreviewed,oa]);
  read=await service.getOrder(staff,id);
  assert.equal(read.current.pending_updates.status,'processing');
  assert.equal(read.current.pending_updates.unresolved_count,1);
  await a.query('UPDATE core_order_inbound_reviews SET revision=3 WHERE event_id=$1 AND oa_id=$2',
   [unreviewed,oa]);
  await service.publishVerifiedPlan(processor,id,{
   expected_revision:3,plan:{...plan,request_hash:added.request_hash},
   idempotency_key:k('new-plan')});
  read=await service.getOrder(staff,id);
  assert.equal(read.current.pending_updates.status,'clear');
  assert.equal(read.current.pending_updates.unresolved_count,0);
  assert.equal(read.current.pending_updates.revision,4);
  assert.equal(read.current.pending_updates.request_hash,added.request_hash);
  await assert.rejects(service.approve(staff,id,{expected_revision:4,
   acknowledge_deposit_shortage:true,idempotency_key:k('approve-with-old-confirm')}),
   e=>e.code==='CUSTOMER_NOT_CONFIRMED');
  await service.confirm(customerPrincipal,id,{expected_revision:4,kind:'request',idempotency_key:k('fresh-confirmation')});

  // A staff approval and read share the order row lock. Pending ingress is not masked.
  const racing=k('race-inbound');
  const client=await b.connect();let transactionOpen=false;
  try{
   await client.query('BEGIN');transactionOpen=true;
   await inbound(client,oa,conv,customer,racing,'text');
   let readSettled=false;
   const reading=service.getOrder(staff,id).then(value=>{readSettled=true;return value});
   await new Promise(resolve=>setTimeout(resolve,65));
   assert.equal(readSettled,false,'read must wait for signed ingress order row lock');
   await client.query('COMMIT');transactionOpen=false;
   const raced=await reading;
   assert.equal(raced.current.pending_updates.status,'processing');
   assert.equal(raced.current.pending_updates.unresolved_count,1);
  }finally{
   if(transactionOpen)await client.query('ROLLBACK');
   client.release();
  }
  const attempt=()=>service.approve(staff,id,{expected_revision:4,
   acknowledge_deposit_shortage:true,idempotency_key:k('concurrent-approve')});
  const approvals=await Promise.allSettled([attempt(),attempt()]);
  assert.deepEqual(approvals.map(x=>x.status),['rejected','rejected']);
  assert.ok(approvals.every(x=>x.reason?.code==='PENDING_INBOUND_REVIEW'));
  assert.equal(await count(a,'core_print_jobs',id),0);
  // Count every pending event without exposing raw payloads; response items are capped.
  for(let i=0;i<15;i++)await inbound(b,oa,conv,customer,k('extra-pending'),'text');
  const many=(await service.getOrder(staff,id)).current.pending_updates;
  assert.equal(many.status,'processing');
  assert.equal(many.unresolved_count,16);
  assert.equal(many.items.length,12);
  assert.ok(many.items.every(x=>x.kind==='file'||x.kind==='message'));
  assert.ok(!JSON.stringify(many).includes('PRIVATE-CUSTOMER-SECRET'));

  // Multiple concurrent open orders create ambiguity even with valid journal.
  const manual=await service.createDraft(staff,{customer_id:customer,conversation_id:conv,
   request_data:{source:'staff',text:'different staff order'},idempotency_key:k('manual')});
  assert.notEqual(manual.order_id,id);
  read=await service.getOrder(staff,id);
  assert.equal(read.current.pending_updates.status,'needs_human');
  assert.equal(read.current.pending_updates.order_id,id);
  assert.equal(read.current.pending_updates.revision,4);
  assert.equal(read.current.pending_updates.request_hash,added.request_hash);

  // A staff-approved order ignores LATER receipt for its historical read model.
  const closedConv=k('approved-conv'),closedEvent=k('approved-initial');
  await inbound(a,oa,closedConv,customer,closedEvent);
  const closed=await drafts.suggest_draft({conversation_id:closedConv,customer_id:customer,
   event_ids:[closedEvent],text:'Print verified',expected_generation:0,idempotency_key:k('other-init')});
  const closedHash=(await a.query('SELECT request_hash FROM core_revisions WHERE order_id=$1 AND revision=1',
   [closed.order_id])).rows[0].request_hash;
  await service.publishVerifiedPlan(processor,closed.order_id,{expected_revision:1,
   plan:{...plan,request_hash:closedHash},idempotency_key:k('approved-plan')});
  await service.confirm(customerPrincipal,closed.order_id,{expected_revision:2,kind:'request',
   idempotency_key:k('approved-confirm')});
  await service.approve(staff,closed.order_id,{expected_revision:2,
   acknowledge_deposit_shortage:true,idempotency_key:k('approved-final')});
  await inbound(b,oa,closedConv,customer,k('after-approval'),'file');
  const historical=(await service.getOrder(staff,closed.order_id)).current.pending_updates;
  assert.equal(historical.status,'clear');
  assert.equal(historical.unresolved_count,0);
  // Inserted after staff approval, but its trusted received_at proves it belongs
  // before approval. Never silently hide such a late-persisted old event.
  const cutoff=(await a.query('SELECT created_at FROM core_approvals WHERE order_id=$1',
   [closed.order_id])).rows[0].created_at;
  const lateId=k('delayed-old-receipt');
  await inbound(b,oa,closedConv,customer,lateId,'file',
   new Date(new Date(cutoff).getTime()-20000));
  const late=(await service.getOrder(staff,closed.order_id)).current.pending_updates;
  assert.equal(late.status,'processing');
  assert.equal(late.unresolved_count,1);
  // Missing source provenance is not CLEAR even when current JSON claims it.
  await b.query('DELETE FROM zalo_inbound_events WHERE oa_id=$1 AND event_id=$2',[oa,closedEvent]);
  const missing=(await service.getOrder(staff,closed.order_id)).current.pending_updates;
  assert.equal(missing.status,'needs_human');
  assert.equal(missing.order_id,closed.order_id);
 }finally{await Promise.all([a.end(),b.end()]);}
});
