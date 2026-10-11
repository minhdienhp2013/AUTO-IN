const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
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
  const sql=fs.readFileSync(path.resolve(__dirname,'../../../backend/storage/migrations/001_core.sql'),'utf8');
  await pool.query(sql);
  const store=new PgStore(pool),auth=new AuthService(store),svc=new OrderService(store,()=>new Date('2026-10-12T04:00:00.000Z'));
  const shop='test-shop-'+uuid();
  await auth.bootstrapOwner({shop_id:shop,username:'owner',password:'long-owner-password-2026',bootstrap_enabled:true});
  const owner=(await auth.login(shop,'owner','long-owner-password-2026')).principal;
  const staffId=uuid();await pool.query("INSERT INTO core_users(id,shop_id,username,password_hash,role) VALUES($1,$2,'staff',$3,'staff')",[staffId,shop,await passwordHash('long-staff-password-2026')]);
  const staff=(await auth.login(shop,'staff','long-staff-password-2026')).principal;
  const agent1={id:'agent1',shop_id:shop,role:'print_agent',verified:true};
  const agent2={id:'agent2',shop_id:shop,role:'print_agent',verified:true};
  const processor={id:'processor1',shop_id:shop,role:'processor',verified:true};
  const customerId='cust'+uuid();const customer={id:'zalo-verified',shop_id:shop,role:'customer',customer_id:customerId,verified:true};
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
  await pool.query('UPDATE core_shop_settings SET holiday_dates=$2 WHERE shop_id=$1',[shop,['2026-10-12']]);
  await assert.rejects(svc.claim(agent1,{printer_id:'RMP7000',idempotency_key:key('holiday')}),e=>e.code==='PRINT_CLOSED');
  return {shop,passed:true};
 }finally{await pool.end();}
};
test('PostgreSQL actual transaction/locks: approval, double-claim, UNKNOWN, quote, exceptions', {skip:ready?false:'Requires isolated TEST_DATABASE_URL and pg dependency; NOT run as in-memory simulation'},async()=>{
 const result=await run();assert.equal(result.passed,true);
});
