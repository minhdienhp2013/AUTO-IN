const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const path=require('node:path');
const root=process.env.AI1_BUILD_DIR||path.resolve(__dirname,'../../../.ai1-build/backend');
const load=name=>require(path.join(root,name+'.js'));
const {PgStore}=load('storage/database');
const {AuthService,passwordHash}=load('core/auth');
const {ShopScheduleService}=load('core/shop-schedule');
const {OrderService}=load('core/service');
const {registerCoreRoutes}=load('api/routes');
let Pg,Fastify;
try{Pg=require('pg');Fastify=require('fastify');}catch{}
const url=process.env.TEST_DATABASE_URL;
const enabled=Boolean(Pg&&Fastify&&url);
const id=()=>randomUUID();
const key=tag=>tag+'-'+id();
const err=code=>e=>e.code===code;
test('CODE501 real PostgreSQL 18 two pools and Fastify owner/shop/race contract',
 {skip:enabled?false:'PostgreSQL/Fastify TEST_DATABASE_URL missing: NOT RUN'},
 async t=>{
 const parsed=new URL(url);
 assert.ok(['localhost','127.0.0.1','[::1]'].includes(parsed.hostname));
 assert.match(decodeURIComponent(parsed.pathname),/test/i);
 const poolA=new Pg.Pool({connectionString:url,max:8});
 const poolB=new Pg.Pool({connectionString:url,max:8});
 let app;
 try {
  const migrated=(await poolA.query(
    "SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='core_shop_settings' AND column_name='schedule_version') AS version,"+
    "to_regclass('public.core_shop_schedule_audit') IS NOT NULL AS audit")).rows[0];
  assert.deepEqual(migrated,{version:true,audit:true},'Run Core migration 008 in CI first');
  const storeA=new PgStore(poolA),storeB=new PgStore(poolB);
  const auth=new AuthService(storeA),sa=new ShopScheduleService(storeA),sb=new ShopScheduleService(storeB);
  const core=new OrderService(storeB);
  const shopA='autoin-test-schedule-'+id(),shopB='autoin-test-schedule-'+id();
  await auth.bootstrapOwner({shop_id:shopA,username:'owner',password:'owner-password-2026!',bootstrap_enabled:true});
  await auth.bootstrapOwner({shop_id:shopB,username:'owner',password:'owner-password-2026!',bootstrap_enabled:true});
  const la=await auth.login(shopA,'owner','owner-password-2026!');
  const lb=await auth.login(shopB,'owner','owner-password-2026!');
  const owner=la.principal,other=lb.principal;
  const staffId=id();
  await poolA.query("INSERT INTO core_users(id,shop_id,username,password_hash,role) VALUES($1,$2,'staff',$3,'staff')",[staffId,shopA,await passwordHash('staff-password-2026!')]);
  const staffLogin=await auth.login(shopA,'staff','staff-password-2026!');
  const staff=staffLogin.principal;
  app=Fastify({logger:false});
  const registry={
   get:(p,h)=>app.get(p,(request,reply)=>h(request,reply)),
   post:(p,h)=>app.post(p,(request,reply)=>h(request,reply)),
   patch:(p,h)=>app.patch(p,(request,reply)=>h(request,reply))
  };
  registerCoreRoutes(registry,{auth,service:core,schedule:sa,
    resolveVerifiedCustomer:async()=>{throw Error('not a customer test')},
    resolvePrintAgent:async()=>{throw Error('not an agent test')}
  });
  await app.ready();
  const http=(method,token,body)=>app.inject({method,url:'/api/v1/settings/schedule',
    headers:token?{authorization:'Bearer '+token}:{},...(body===undefined?{}:{payload:body})});
  const json=response=>JSON.parse(response.payload);
  const qCount=async()=>Number((await poolA.query('SELECT count(*)::int AS n FROM core_shop_schedule_audit WHERE shop_id=$1',[shopA])).rows[0].n);
  await t.test('401/403 no cross-shop disclosure, valid GET and no-store',async()=>{
   assert.equal((await http('GET','')).statusCode,401);
   assert.equal((await http('PATCH','',{expected_version:1,idempotency_key:'x',manual_lock:true})).statusCode,401);
   assert.equal((await http('PATCH',staffLogin.token,{expected_version:1,idempotency_key:'staff',manual_lock:true})).statusCode,403);
   await assert.rejects(sa.get({id:'fake',role:'customer',shop_id:shopA,verified:true}),err('FORBIDDEN'));
   await assert.rejects(sa.patch({id:'fake',role:'print_agent',shop_id:shopA,verified:true},{expected_version:1,idempotency_key:'a',manual_lock:true}),err('FORBIDDEN'));
   const get=await http('GET',staffLogin.token);
   assert.equal(get.statusCode,200);
   assert.equal(get.headers['cache-control'],'no-store');
   assert.equal(json(get).version,1);
   assert.equal(json(get).shop_id,shopA);
   const otherGet=await http('GET',lb.token);
   assert.equal(json(otherGet).shop_id,shopB);
   assert.equal((await http('PATCH',la.token,{expected_version:1,idempotency_key:key('spoof'),manual_lock:true,shop_id:shopB})).statusCode,422);
   assert.equal((await sb.get(other)).version,1);
  });
  await t.test('invalid clock/calendar, no-op, CAS and idempotency replay',async()=>{
   for(const edit of [{mode:'production'},{printing_enabled:true},{open_at:'24:00'},{close_at:'07:00'},
      {holiday_dates:['2026-02-29']},{holiday_dates:['2026-01-01','2026-01-01']},{timezone:'UTC'}]){
    const response=await http('PATCH',la.token,{expected_version:1,idempotency_key:key('bad'),...edit});
    assert.equal(response.statusCode,422,JSON.stringify({edit,response:json(response)}));
   }
   assert.equal((await sa.get(owner)).version,1);assert.equal(await qCount(),0);
   const noOp=await sa.patch(owner,{expected_version:1,idempotency_key:key('noop'),open_at:'07:00'});
   assert.equal(noOp.changed,false);assert.equal(noOp.version,1);assert.equal(await qCount(),0);
   const payload={expected_version:1,idempotency_key:key('change'),open_at:'00:00',close_at:'24:00',
    holiday_dates:['2028-02-29','2026-10-20']};
   const updated=await http('PATCH',la.token,payload);
   assert.equal(updated.statusCode,200,updated.payload);
   assert.equal(json(updated).version,2);assert.equal(json(updated).changed,true);
   assert.deepEqual(json(updated).holiday_dates,['2026-10-20','2028-02-29']);
   const replay=await http('PATCH',la.token,payload);
   assert.equal(replay.statusCode,200);assert.deepEqual(json(replay),json(updated));
   assert.equal(await qCount(),1);
   const conflict=await http('PATCH',la.token,{...payload,manual_lock:true});
   assert.equal(conflict.statusCode,409);assert.equal(json(conflict).error.code,'IDEMPOTENCY_CONFLICT');
   const stale=await http('PATCH',la.token,{expected_version:1,idempotency_key:key('stale'),manual_lock:true});
   assert.equal(stale.statusCode,409);assert.equal(json(stale).error.code,'STALE_SETTINGS_VERSION');
   assert.equal((await sa.get(owner)).operational_guard.mode,'simulation');
   assert.equal((await sa.get(owner)).operational_guard.printing_enabled,false);
   assert.equal(await qCount(),1);
  });
  await t.test('two independent PG pools serialize writes to one version',async()=>{
   const before=(await sa.get(owner)).version;
   const one=sa.patch(owner,{expected_version:before,idempotency_key:key('poolA'),manual_lock:false});
   const two=sb.patch(owner,{expected_version:before,idempotency_key:key('poolB'),manual_lock:true});
   const results=await Promise.allSettled([one,two]);
   assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
   assert.equal(results.filter(r=>r.status==='rejected'&&r.reason.code==='STALE_SETTINGS_VERSION').length,1);
   assert.equal((await sa.get(owner)).version,before+1);
   assert.equal(await qCount(),2);
  });
  // New approved jobs use the existing genuine Core customer confirmation/approval.
  const agent={id:'agent-'+id(),shop_id:shopA,role:'print_agent',verified:true,printer_ids:['RMP7000']};
  const processor={id:'processor-'+id(),shop_id:shopA,role:'processor',verified:true};
  const customerId='customer-'+id();
  const customer={id:'customer-credential-'+id(),shop_id:shopA,role:'customer',verified:true,customer_id:customerId};
  const makeJob=async()=>{
   const created=await core.createDraft(owner,{customer_id:customerId,request_data:{files:[{file_id:key('public'),copies:1}]},idempotency_key:key('create')});
   const revision=await core.publishVerifiedPlan(processor,created.order_id,{expected_revision:1,
    plan:{request_hash:created.request_hash,physical_sheets:1,document_pages:1,printed_faces:1,ready:true,
    printer_id:'RMP7000',artifact_ref:'fixture/public/sample.png',verified_by:processor.id},
    idempotency_key:key('plan')});
   await core.confirm(customer,created.order_id,{expected_revision:revision.revision,kind:'request',idempotency_key:key('confirm')});
   const approval=await core.approve(owner,created.order_id,{expected_revision:revision.revision,
    acknowledge_deposit_shortage:false,idempotency_key:key('approve')});
   return {orderId:created.order_id,jobId:approval.job_id,revision:revision.revision};
  };
  const patchLock=async value=>{
   const version=(await sa.get(owner)).version;
   return sa.patch(owner,{expected_version:version,idempotency_key:key('lock'),manual_lock:value});
  };
  await patchLock(false);
  await t.test('PATCH before mark_sending rejects old lease; order→job→settings gate remains',async()=>{
   const job=await makeJob();
   const lease=(await core.claim(agent,{printer_id:'RMP7000',idempotency_key:key('lease')})).job;
   assert.equal(lease.job_id,job.jobId);
   await patchLock(true);
   await assert.rejects(core.preflight(agent,job.jobId,{expected_revision:job.revision,lease_token:lease.lease_token}),err('PRINT_CLOSED'));
   await assert.rejects(core.markSending(agent,job.jobId,{expected_revision:job.revision,lease_token:lease.lease_token,idempotency_key:key('sending')}),err('PRINT_CLOSED'));
   const db=(await poolA.query('SELECT state,mode_at_send FROM core_print_jobs WHERE id=$1',[job.jobId])).rows[0];
   assert.equal(db.state,'NOT_SENT');assert.equal(db.mode_at_send,null);
   await patchLock(false);
   const sent=await core.markSending(agent,job.jobId,{expected_revision:job.revision,lease_token:lease.lease_token,idempotency_key:key('send2')});
   assert.equal(sent.state,'SENDING');
   await patchLock(true);
   assert.equal((await poolA.query('SELECT state,mode_at_send FROM core_print_jobs WHERE id=$1',[job.jobId])).rows[0].mode_at_send,'simulation');
   await core.markUnknownForReconciliation(owner,job.jobId,{reason:'test synthetic lost ACK',idempotency_key:key('unknown')});
   assert.equal((await poolA.query('SELECT state FROM core_print_jobs WHERE id=$1',[job.jobId])).rows[0].state,'UNKNOWN');
   await patchLock(false);
   assert.equal((await core.claim(agent,{printer_id:'RMP7000',idempotency_key:key('noclaim')})).job,null);
  });
  await t.test('real two-pool row lock enforces PATCH vs mark_sending race fail closed',async()=>{
   const job=await makeJob();
   const lease=(await core.claim(agent,{printer_id:'RMP7000',idempotency_key:key('claim-race')})).job;
   assert.equal(lease.job_id,job.jobId);
   const hold=await poolA.connect();
   let inTx=false;
   try{
    await hold.query('BEGIN');inTx=true;
    await hold.query('SELECT shop_id FROM core_shop_settings WHERE shop_id=$1 FOR UPDATE',[shopA]);
    const v=(await sb.get(owner)).version; // nonlocking read of previous committed version
    const change=sb.patch(owner,{expected_version:v,idempotency_key:key('patch-race'),manual_lock:true});
    await new Promise(resolve=>setTimeout(resolve,45));
    const sending=core.markSending(agent,job.jobId,{expected_revision:job.revision,lease_token:lease.lease_token,idempotency_key:key('sending-race')});
    await new Promise(resolve=>setTimeout(resolve,45));
    await hold.query('COMMIT');inTx=false;
    const changed=await change;
    assert.equal(changed.manual_lock,true);
    await assert.rejects(sending,err('PRINT_CLOSED'));
    const state=(await poolB.query('SELECT state FROM core_print_jobs WHERE id=$1',[job.jobId])).rows[0].state;
    assert.equal(state,'NOT_SENT');
   }finally{if(inTx)await hold.query('ROLLBACK');hold.release();}
   await patchLock(false);
  });
  await t.test('settings only: other shop remains independent and no operator escalation',async()=>{
   const first=(await sb.get(other)).version;
   const changed=await sb.patch(other,{expected_version:first,idempotency_key:key('other-shop'),manual_lock:true});
   assert.equal(changed.version,first+1);
   assert.equal((await sa.get(owner)).manual_lock,false);
   assert.equal((await poolA.query('SELECT mode FROM core_shop_settings WHERE shop_id=$1',[shopA])).rows[0].mode,'simulation');
   assert.equal((await poolB.query('SELECT printing_enabled FROM core_shop_settings WHERE shop_id=$1',[shopB])).rows[0].printing_enabled,false);
  });
  console.log('PASS CODE501 REAL TWO-POOL PostgreSQL+Fastify: permission, schedule CAS/idempotency, 409, mark_sending, UNKNOWN, cross-shop; NO live printer');
 }finally{if(app)await app.close();await poolB.end();await poolA.end();}
});
