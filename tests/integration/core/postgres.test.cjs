const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const root=process.env.AI1_BUILD_DIR||path.resolve(__dirname,'../../../.ai1-build/backend');
const load=m=>require(path.join(root,m+'.js'));
let Pg;
try { Pg=require('pg'); } catch (_) { /* AI0 owns root dependencies */ }
const url=process.env.TEST_DATABASE_URL;
const ready=Boolean(Pg&&url);
const {PgStore}=load('storage/database');
const {AuthService,passwordHash}=load('core/auth');
const {OrderService}=load('core/service');
const {sha,canonical}=load('core/model');
const uuid=()=>require('node:crypto').randomUUID();
const req=(n)=>({files:[{file_id:'demo-public',copies:n,format:'pdf'}]});
const key=(s)=>s+uuid();
const run=async()=>{
 const pool=new Pg.Pool({connectionString:url,max:12});
 try {
  // Test database must be isolated/disposable. Never pass the production DATABASE_URL.
  const dbName=(await pool.query('SELECT current_database() AS name')).rows[0].name;
  if(!dbName.includes('test'))throw Error('Refuse migration outside a database with "test" in its name');
  // CI has already migrated this isolated database BEFORE test:core.
  // Never replay DDL here: a concurrent Core worker can hold a row UPDATE
  // while CREATE INDEX IF NOT EXISTS from 001_core.sql waits for a relation
  // lock, yielding PostgreSQL 40P01. Assert prerequisites rather than racing
  // migrations; race/approval/UNKNOWN assertions below are unchanged.
  const schema=(await pool.query(
    "SELECT to_regclass('public.core_orders') IS NOT NULL AS orders,"+
    "to_regclass('public.core_print_jobs') IS NOT NULL AS jobs,"+
    "to_regclass('public.core_conversation_controls') IS NOT NULL AS conversations,"+
    "EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' "+
    "AND table_name='core_print_jobs' AND column_name='mode_at_send') AS send_mode,"+
    "EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' "+
    "AND table_name='core_print_jobs' AND column_name='confirmed_at') AS queue,"+
    "to_regclass('public.core_print_controlled_test_scopes') IS NOT NULL AS controlled_test_scope"
  )).rows[0];
  assert.deepEqual(schema,{orders:true,jobs:true,conversations:true,
   send_mode:true,queue:true,controlled_test_scope:true},'Run npm run db:migrate on the isolated test database before Core tests');
  // Clock must be aligned with the live PostgreSQL lease clock, not a future fixed date.
  const dbNow=(await pool.query('SELECT clock_timestamp() AS moment')).rows[0].moment;
  const local=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Ho_Chi_Minh',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(dbNow);
  const part=k=>local.find(x=>x.type===k).value;
  const holidayDate=`${part('year')}-${part('month')}-${part('day')}`;
  const store=new PgStore(pool),auth=new AuthService(store),svc=new OrderService(store,()=>dbNow);
  const shop='test-shop-'+uuid();
  await auth.bootstrapOwner({shop_id:shop,username:'owner',password:'long-owner-password-2026',bootstrap_enabled:true});
  await pool.query("UPDATE core_shop_settings SET open_at='00:00', close_at='24:00' WHERE shop_id=$1",[shop]);
  const owner=(await auth.login(shop,'owner','long-owner-password-2026')).principal;
  const staffId=uuid();await pool.query("INSERT INTO core_users(id,shop_id,username,password_hash,role) VALUES($1,$2,'staff',$3,'staff')",[staffId,shop,await passwordHash('long-staff-password-2026')]);
  const staff=(await auth.login(shop,'staff','long-staff-password-2026')).principal;
  const agent1={id:'agent1',shop_id:shop,role:'print_agent',verified:true,printer_ids:['RMP7000']};
  const agent2={id:'agent2',shop_id:shop,role:'print_agent',verified:true,printer_ids:['RMP7000']};
  const processor={id:'processor1',shop_id:shop,role:'processor',verified:true};
  const customerId='cust'+uuid();const customer={id:'zalo-verified',shop_id:shop,role:'customer',customer_id:customerId,verified:true};
  await assert.rejects(svc.claim({...agent1,printer_ids:['another-printer']},{printer_id:'RMP7000',idempotency_key:key('wrong-printer')}),e=>e.code==='PRINTER_SCOPE_DENIED');
  const initial=await svc.createDraft(staff,{customer_id:customerId,request_data:req(151),idempotency_key:key('create')});
  const plan={request_hash:initial.request_hash,physical_sheets:151,document_pages:151,printed_faces:151,ready:true,printer_id:'RMP7000',artifact_ref:'fixture/public/print-plan',verified_by:'processor1'};
  const verified=await svc.publishVerifiedPlan(processor,initial.order_id,{expected_revision:1,plan,idempotency_key:key('plan')});
  await assert.rejects(svc.confirm(staff,initial.order_id,{expected_revision:2,kind:'request',idempotency_key:key('fake')}),/khách/i);
  await assert.rejects(svc.confirm({...customer,verified:false},initial.order_id,{expected_revision:2,kind:'request',idempotency_key:key('fake')}),/xác minh/i);
  await svc.confirm(customer,initial.order_id,{expected_revision:2,kind:'request',idempotency_key:key('confirm')});
  await assert.rejects(svc.approve(staff,initial.order_id,{expected_revision:2,acknowledge_deposit_shortage:true,idempotency_key:key('premature')}),/báo giá/i);
  const quote=await svc.setQuote(staff,initial.order_id,{expected_revision:2,amount_vnd:90000,deposit_required_vnd:50000,significant_cost:false,idempotency_key:key('quote')});
  await svc.confirm(customer,initial.order_id,{expected_revision:2,kind:'quote',quote_revision:quote.quote_revision,idempotency_key:key('price')});
  await assert.rejects(svc.approve(staff,initial.order_id,{expected_revision:2,quote_revision:1,acknowledge_deposit_shortage:false,idempotency_key:key('noack')}),/cọc/i);
  const approve=await svc.approve(staff,initial.order_id,{expected_revision:2,quote_revision:1,acknowledge_deposit_shortage:true,idempotency_key:key('approve')});
  assert.equal(approve.deposit_short_vnd,50000);
  // Same idempotency key cannot be reused with changed payload (amount, method, etc).
  const idem=key('payment');
  await svc.recordPayment(staff,initial.order_id,{direction:'received',method:'cash',amount_vnd:10000,idempotency_key:idem});
  await assert.rejects(svc.recordPayment(staff,initial.order_id,{direction:'received',method:'cash',amount_vnd:20000,idempotency_key:idem}),e=>e.code==='IDEMPOTENCY_CONFLICT');
  await assert.rejects(svc.approve(staff,initial.order_id,{expected_revision:2,quote_revision:1,acknowledge_deposit_shortage:true,idempotency_key:key('approve2')}),e=>e.status===409);
  const [a,b]=await Promise.all([svc.claim(agent1,{printer_id:'RMP7000',idempotency_key:key('claim')}),svc.claim(agent2,{printer_id:'RMP7000',idempotency_key:key('claim')})]);
  assert.equal([a,b].filter(x=>x.job).length,1,'one agent only gets the job');
  const claimed=a.job?a.job:b.job;const current=a.job?agent1:agent2;
  await assert.rejects(svc.markSending(current,claimed.job_id,{expected_revision:1,lease_token:claimed.lease_token,idempotency_key:key('stale')}),e=>e.status===409);
  await svc.preflight(current,claimed.job_id,{expected_revision:2,lease_token:claimed.lease_token});
  await svc.markSending(current,claimed.job_id,{expected_revision:2,lease_token:claimed.lease_token,idempotency_key:key('sending')});
  await assert.rejects(svc.revise(staff,initial.order_id,{expected_revision:2,request_data:req(100),idempotency_key:key('revise')}),e=>e.status===409);
  await svc.markUnknownForReconciliation(staff,claimed.job_id,{reason:'mất mạng agent',idempotency_key:key('unknown')});
  await assert.rejects(svc.verifyPaper(staff,claimed.job_id,{evidence_kind:'staff_inspected',physical_sheets:151,note:'must reject simulation',idempotency_key:key('fakepaper')}),e=>e.code==='SIMULATION_NOT_PAPER');
  await assert.rejects(svc.verifyPaper(staff,claimed.job_id,{evidence_kind:'device_verified',physical_sheets:151,note:'fake driver verification',idempotency_key:key('fakedevice')}),e=>e.code==='DEVICE_PROOF_NOT_CONNECTED');
  const second=await svc.claim(agent1,{printer_id:'RMP7000',idempotency_key:key('noclaim')});assert.equal(second.job,null);
  await assert.rejects(svc.closePrintException(staff,initial.order_id,{expected_revision:2,reason:'khách bỏ',idempotency_key:key('staffclose')}),e=>e.status===403);
  const closed=await svc.closePrintException(owner,initial.order_id,{expected_revision:2,reason:'khách bỏ sau in',idempotency_key:key('ownerclose')});
  assert.equal(closed.receivable_vnd,80000);assert.equal(closed.undelivered_sheets,151);assert.equal(closed.delivered_sheets,0);
  const detail=await svc.getOrder(staff,initial.order_id);assert.equal(detail.receivable_vnd,80000);
  // Independent no-paper holiday gate test; must never permit sending in holiday.
  const order2=await svc.createDraft(staff,{customer_id:customerId,request_data:req(1),idempotency_key:key('c2')});
  await svc.publishVerifiedPlan(processor,order2.order_id,{expected_revision:1,plan:{...plan,request_hash:order2.request_hash,physical_sheets:1,document_pages:1,printed_faces:1},idempotency_key:key('p2')});
  await svc.confirm(customer,order2.order_id,{expected_revision:2,kind:'request',idempotency_key:key('req2')});
  await svc.approve(staff,order2.order_id,{expected_revision:2,acknowledge_deposit_shortage:true,idempotency_key:key('app2')});
  await pool.query('UPDATE core_shop_settings SET holiday_dates=$2 WHERE shop_id=$1',[shop,[holidayDate]]);
  await assert.rejects(svc.claim(agent1,{printer_id:'RMP7000',idempotency_key:key('holiday')}),e=>e.code==='PRINT_CLOSED');
  // A genuine pg BIGINT is a STRING. Split deliveries must add numerically, never concatenate.
  await pool.query("UPDATE core_shop_settings SET holiday_dates='{}', mode='controlled_test', printing_enabled=true WHERE shop_id=$1",[shop]);
  const order3=await svc.createDraft(staff,{customer_id:customerId,request_data:req(5),idempotency_key:key('c3')});
  await svc.publishVerifiedPlan(processor,order3.order_id,{expected_revision:1,plan:{...plan,request_hash:order3.request_hash,physical_sheets:5,document_pages:5,printed_faces:5},idempotency_key:key('p3')});
  await svc.confirm(customer,order3.order_id,{expected_revision:2,kind:'request',idempotency_key:key('req3')});
  await svc.approve(staff,order3.order_id,{expected_revision:2,acknowledge_deposit_shortage:true,idempotency_key:key('app3')});
  const newClaim=await svc.claim(agent1,{printer_id:'RMP7000',idempotency_key:key('claim3')});
  // order2 is still waiting, so its earlier approved job may be claimed first.
  const pendingJob=newClaim.job;assert.ok(pendingJob);
  if(pendingJob.order_id===order2.order_id){
    await svc.markSending(agent1,pendingJob.job_id,{expected_revision:2,lease_token:pendingJob.lease_token,idempotency_key:key('send2')});
    await svc.report(agent1,pendingJob.job_id,{expected_revision:2,lease_token:pendingJob.lease_token,result:'sent_unverified',evidence_kind:'spooler',idempotency_key:key('rep2')});
  }
  const deliveryClaim=pendingJob.order_id===order3.order_id?pendingJob:(await svc.claim(agent1,{printer_id:'RMP7000',idempotency_key:key('claim3again')})).job;
  assert.ok(deliveryClaim);assert.equal(deliveryClaim.order_id,order3.order_id);
  await svc.markSending(agent1,deliveryClaim.job_id,{expected_revision:2,lease_token:deliveryClaim.lease_token,idempotency_key:key('send3')});
  // Changing the shop mode after SENDING must NOT rewrite the job's historical evidence mode.
  await pool.query("UPDATE core_shop_settings SET mode='simulation' WHERE shop_id=$1",[shop]);
  await svc.report(agent1,deliveryClaim.job_id,{expected_revision:2,lease_token:deliveryClaim.lease_token,result:'sent_unverified',evidence_kind:'spooler',idempotency_key:key('rep3')});
  await pool.query("UPDATE core_shop_settings SET mode='controlled_test' WHERE shop_id=$1",[shop]);
  await assert.rejects(svc.verifyPaper(staff,deliveryClaim.job_id,{evidence_kind:'staff_inspected',physical_sheets:6,note:'bad count',idempotency_key:key('badpaper')}),e=>e.code==='PAPER_COUNT_EXCEEDS_PLAN');
  await svc.verifyPaper(staff,deliveryClaim.job_id,{evidence_kind:'staff_inspected',physical_sheets:5,note:'counted 5 sheets',idempotency_key:key('paper3')});
  const first=await svc.deliver(staff,order3.order_id,{expected_revision:2,physical_sheets:2,note:'first batch',idempotency_key:key('d1')});
  const secondDelivery=await svc.deliver(staff,order3.order_id,{expected_revision:2,physical_sheets:3,note:'second batch',idempotency_key:key('d2')});
  assert.equal(first.delivered_sheets,2);assert.equal(secondDelivery.delivered_sheets,5);assert.equal(secondDelivery.remaining_sheets,0);
  await assert.rejects(svc.deliver(staff,order3.order_id,{expected_revision:2,physical_sheets:1,idempotency_key:key('overdeliver')}),e=>e.code==='PAPER_NOT_VERIFIED');
  const actual=(await pool.query('SELECT delivered_sheets::text AS count FROM core_orders WHERE id=$1',[order3.order_id])).rows[0].count;
  assert.equal(actual,'5');
  // TN-036: an abandoned, never-printed order with a deposit/refund history
  // remains owner-only to close, even when the net receipt balance returns to zero.
  const depositOrder=await svc.createDraft(staff,{customer_id:customerId,request_data:req(1),idempotency_key:key('deposit-order')});
  await svc.recordPayment(staff,depositOrder.order_id,{direction:'received',method:'cash',amount_vnd:500,idempotency_key:key('deposit-in')});
  await assert.rejects(
    svc.recordPayment(owner,depositOrder.order_id,{direction:'refund_approved',method:'cash',amount_vnd:700,idempotency_key:key('refund-too-large')}),
    e=>e.code==='REFUND_EXCEEDS_RECEIPTS'
  );
  await svc.recordPayment(owner,depositOrder.order_id,{direction:'refund_approved',method:'cash',amount_vnd:500,idempotency_key:key('refund-approve')});
  await assert.rejects(
    svc.recordPayment(owner,depositOrder.order_id,{direction:'refund_approved',method:'cash',amount_vnd:1,idempotency_key:key('refund-double-approve')}),
    e=>e.code==='REFUND_EXCEEDS_RECEIPTS'
  );
  await assert.rejects(
    svc.recordPayment(owner,depositOrder.order_id,{direction:'refunded',method:'cash',amount_vnd:501,idempotency_key:key('refund-unapproved')}),
    e=>e.code==='REFUND_NOT_APPROVED'
  );
  await svc.recordPayment(owner,depositOrder.order_id,{direction:'refunded',method:'cash',amount_vnd:500,idempotency_key:key('refund-paid')});
  await assert.rejects(
    svc.closePrintException(staff,depositOrder.order_id,{expected_revision:1,reason:'abandoned after refund',idempotency_key:key('close-with-refund-history')}),
    e=>e.code==='OWNER_REQUIRED'
  );
  const ownerClosed=await svc.closePrintException(owner,depositOrder.order_id,{expected_revision:1,reason:'refund reconciled; no print',idempotency_key:key('close-owner-refunded')});
  assert.equal(ownerClosed.receivable_vnd,0);
  assert.equal(ownerClosed.refundable_vnd,0);
  // A staff member may close a genuinely empty/unprinted/unpaid abandoned order.
  const emptyOrder=await svc.createDraft(staff,{customer_id:customerId,request_data:req(1),idempotency_key:key('empty-order')});
  const emptyClosed=await svc.closePrintException(staff,emptyOrder.order_id,{expected_revision:1,reason:'unconfirmed abandoned',idempotency_key:key('empty-close')});
  assert.equal(emptyClosed.print_closed,true);
  // TN-007: queue by completed customer confirmation, NOT employee approval time.
  const early=await svc.createDraft(staff,{customer_id:customerId,request_data:req(5),idempotency_key:key('early')});
  const late=await svc.createDraft(staff,{customer_id:customerId,request_data:req(1),idempotency_key:key('late')});
  await svc.publishVerifiedPlan(processor,early.order_id,{expected_revision:1,plan:{...plan,request_hash:early.request_hash,physical_sheets:5,document_pages:5,printed_faces:5},idempotency_key:key('early-plan')});
  await svc.publishVerifiedPlan(processor,late.order_id,{expected_revision:1,plan:{...plan,request_hash:late.request_hash,physical_sheets:1,document_pages:1,printed_faces:1},idempotency_key:key('late-plan')});
  await svc.confirm(customer,early.order_id,{expected_revision:2,kind:'request',idempotency_key:key('early-confirm')});
  await svc.confirm(customer,late.order_id,{expected_revision:2,kind:'request',idempotency_key:key('late-confirm')});
  // Later duplicate confirmations must NOT push the first customer's queue position back.
  await svc.confirm(customer,early.order_id,{expected_revision:2,kind:'request',idempotency_key:key('early-duplicate')});
  await svc.approve(staff,late.order_id,{expected_revision:2,acknowledge_deposit_shortage:true,idempotency_key:key('late-approve-FIRST')});
  await svc.approve(staff,early.order_id,{expected_revision:2,acknowledge_deposit_shortage:true,idempotency_key:key('early-approve-SECOND')});
  const firstClaim=await svc.claim(agent1,{printer_id:'RMP7000',idempotency_key:key('queue-first')});
  assert.equal(firstClaim.job?.order_id,early.order_id,'A confirmed before B must win despite B being approved first');
  const readBefore=await svc.getOrder(staff,early.order_id);
  assert.equal(readBefore.current.request_confirmed,true);
  assert.equal(readBefore.current.staff_approved,true);
  assert.equal(readBefore.current.preview_ref,null,'no fabricated preview');
  assert.ok(readBefore.current.verified_plan?.artifact_ref,'only processor plan may be ready');
  assert.equal(readBefore.current.verified_plan?.physical_sheets,5);
  assert.equal(readBefore.print_progress.planned_sheets,5);
  assert.equal(readBefore.print_progress.verified_sheets,0);
  await svc.markSending(agent1,firstClaim.job.job_id,{expected_revision:2,lease_token:firstClaim.job.lease_token,idempotency_key:key('send-first')});
  await svc.report(agent1,firstClaim.job.job_id,{expected_revision:2,lease_token:firstClaim.job.lease_token,result:'sent_unverified',evidence_kind:'spooler',idempotency_key:key('report-first')});
  const partiallyVerified=await svc.verifyPaper(staff,firstClaim.job.job_id,{evidence_kind:'staff_inspected',physical_sheets:2,note:'2 of 5 real sheets; stop and reconcile',idempotency_key:key('partial-inspection')});
  assert.equal(partiallyVerified.state,'UNKNOWN');
  assert.equal(partiallyVerified.missing_sheets,3);
  assert.equal(partiallyVerified.requires_manual_reconciliation,true);
  const readAfter=await svc.getOrder(staff,early.order_id);
  assert.equal(readAfter.print_progress.fully_verified,false);
  assert.equal(readAfter.print_progress.verified_sheets,2);
  assert.equal(readAfter.print_progress.missing_sheets,3);
  assert.equal(readAfter.print_progress.requires_manual_reconciliation,true);
  await svc.deliver(staff,early.order_id,{expected_revision:2,physical_sheets:2,note:'deliver only counted sheets',idempotency_key:key('partial-delivery')});
  await assert.rejects(svc.deliver(staff,early.order_id,{expected_revision:2,physical_sheets:1,idempotency_key:key('cannot-overdeliver')}),e=>e.code==='PAPER_NOT_VERIFIED');
  // A remains UNKNOWN; it must not be reclaimed or automatically topped up.
  const secondClaim=await svc.claim(agent2,{printer_id:'RMP7000',idempotency_key:key('queue-second')});
  assert.equal(secondClaim.job?.order_id,late.order_id);

  // TN-027: owner/staff generation changes are atomic and prevent stale AI reply.
  const conversationId='test-conversation-'+uuid();
  const convOrder=await svc.createDraft(staff,{customer_id:customerId,conversation_id:conversationId,request_data:req(1),idempotency_key:key('conv-create')});
  const conv0=await svc.getOrder(staff,convOrder.order_id);
  assert.equal(conv0.conversation_control?.generation,0);
  assert.equal(conv0.conversation_control?.status,'AI');
  const takeover=await svc.handover(staff,conversationId,{expected_generation:0,idempotency_key:key('takeover')});
  assert.equal(takeover.generation,1);assert.equal(takeover.status,'HUMAN');
  await assert.rejects(svc.withAiSendGate({shop_id:shop,conversation_id:conversationId,generation:0},async()=>true),e=>e.code==='AI_REPLY_BLOCKED');
  await assert.rejects(svc.returnToAi(staff,conversationId,{expected_generation:0,idempotency_key:key('stale-return')}),e=>e.code==='STALE_REVISION');
  const aiAgain=await svc.returnToAi(staff,conversationId,{expected_generation:1,idempotency_key:key('return')});
  assert.equal(aiAgain.generation,2);assert.equal(aiAgain.status,'AI');
  assert.equal(await svc.withAiSendGate({shop_id:shop,conversation_id:conversationId,generation:2},async()=>42),42);
  await assert.rejects(svc.withAiSendGate({shop_id:'wrong-shop',conversation_id:conversationId,generation:2},async()=>42),e=>e.code==='AI_REPLY_BLOCKED');
  const [ha,hb]=await Promise.allSettled([
    svc.handover(staff,conversationId,{expected_generation:2,idempotency_key:key('race-staff')}),
    svc.handover(owner,conversationId,{expected_generation:2,idempotency_key:key('race-owner')})
  ]);
  assert.equal([ha,hb].filter(r=>r.status==='fulfilled').length,1,'only one takeover wins same generation');
  assert.equal([ha,hb].filter(r=>r.status==='rejected'&&r.reason.code==='STALE_REVISION').length,1);
  return {shop,passed:true};
 }finally{await pool.end();}
};
test('PostgreSQL actual transaction/locks: approval, double-claim, UNKNOWN, quote, exceptions', {skip:ready?false:'Requires isolated TEST_DATABASE_URL and pg dependency; NOT run as in-memory simulation'},async()=>{
 const result=await run();assert.equal(result.passed,true);
});
