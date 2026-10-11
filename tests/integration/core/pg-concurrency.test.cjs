'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const build=process.env.AI1_BUILD_DIR||path.resolve(__dirname,'../../../.ai1-build/backend');
const load=m=>require(path.join(build,m+'.js'));
const {PgStore}=load('storage/database');
const {OrderService}=load('core/service');
const {AuthService}=load('core/auth');
let Pg;try{Pg=require('pg')}catch{}
const url=process.env.TEST_DATABASE_URL;
const key=(prefix)=>prefix+'-'+randomUUID();
const request=n=>({files:[{file_id:'synthetic-fixture',copies:n,format:'pdf'}]});
async function migrate(pool){
  const name=(await pool.query('SELECT current_database() AS name')).rows[0].name;
  if(!/(^|[_-])test([_-]|$)/i.test(name))throw Error('Refusing migrations on non-test PostgreSQL database: '+name);
  for(let i=1;i<=4;i++){
    const file=['001_core.sql','002_send_mode.sql','003_confirmed_queue.sql','004_conversation_generation.sql'][i-1];
    await pool.query(fs.readFileSync(path.resolve(__dirname,'../../../backend/storage/migrations',file),'utf8'));
  }
}
async function prepare(svc,staff,processor,customer,shop,n){
  const draft=await svc.createDraft(staff,{customer_id:customer.customer_id,conversation_id:'conv-'+randomUUID(),request_data:request(n),idempotency_key:key('draft')});
  const plan={request_hash:draft.request_hash,physical_sheets:n,document_pages:n,printed_faces:n,ready:true,printer_id:'RMP7000',artifact_ref:'fixture/public/processor-verified',verified_by:'test-processor'};
  await svc.publishVerifiedPlan(processor,draft.order_id,{expected_revision:1,plan,idempotency_key:key('plan')});
  await svc.confirm(customer,draft.order_id,{expected_revision:2,kind:'request',idempotency_key:key('confirm')});
  return draft.order_id;
}

test('REAL PostgreSQL (two independent pools): FIFO, double approve, claim, send and generation races',{
  skip: !url ? 'TEST_DATABASE_URL unset: PostgreSQL transactions NOT VERIFIED' : false
},async()=>{
  if(!Pg)throw Error('TEST_DATABASE_URL is set but pg dependency is missing (not a SKIP)');
  const poolA=new Pg.Pool({connectionString:url,max:2});
  const poolB=new Pg.Pool({connectionString:url,max:2});
  try{
    await migrate(poolA);
    // Distinct physical backend sessions are mandatory, not two clients sharing one connection.
    const [sessionA,sessionB]=await Promise.all([poolA.connect(),poolB.connect()]);
    try {
      const [a,b]=await Promise.all([
        sessionA.query('SELECT pg_backend_pid() AS pid'),
        sessionB.query('SELECT pg_backend_pid() AS pid')
      ]);
      assert.notEqual(a.rows[0].pid,b.rows[0].pid,'requires distinct PostgreSQL backend sessions');
    }finally{sessionA.release();sessionB.release()}
    const storeA=new PgStore(poolA),storeB=new PgStore(poolB);
    const svcA=new OrderService(storeA),svcB=new OrderService(storeB);
    const auth=new AuthService(storeA),shop='test-'+randomUUID();
    await auth.bootstrapOwner({shop_id:shop,username:'owner',password:'test-owner-strong-password',bootstrap_enabled:true});
    await poolA.query("UPDATE core_shop_settings SET open_at='00:00', close_at='24:00',holiday_dates='{}' WHERE shop_id=$1",[shop]);
    const owner=(await auth.login(shop,'owner','test-owner-strong-password')).principal;
    const staff={...owner,id:owner.id};
    const processor={id:'trusted-test-processor',role:'processor',verified:true,shop_id:shop};
    const customer={id:'provider-verified-test-customer',role:'customer',customer_id:'customer-'+randomUUID(),verified:true,shop_id:shop};
    const agent1={id:'agent1',role:'print_agent',verified:true,shop_id:shop,printer_ids:['RMP7000']};
    const agent2={id:'agent2',role:'print_agent',verified:true,shop_id:shop,printer_ids:['RMP7000']};
    const first=await prepare(svcA,staff,processor,customer,shop,5);
    await new Promise(resolve=>setTimeout(resolve,50));
    const second=await prepare(svcB,staff,processor,customer,shop,2);
    // Approve B first while A has earlier customer completion.
    await svcB.approve(staff,second,{expected_revision:2,acknowledge_deposit_shortage:true,idempotency_key:key('approve-B')});
    const [ok,duplicate]=await Promise.allSettled([
      svcA.approve(staff,first,{expected_revision:2,acknowledge_deposit_shortage:true,idempotency_key:key('approve-A-1')}),
      svcB.approve(staff,first,{expected_revision:2,acknowledge_deposit_shortage:true,idempotency_key:key('approve-A-2')})
    ]);
    assert.equal([ok,duplicate].filter(v=>v.status==='fulfilled').length,1,'atomic double-approval');
    assert.equal([ok,duplicate].filter(v=>v.status==='rejected'&&v.reason.code==='ALREADY_APPROVED').length,1);
    const firstClaim=await svcB.claim(agent2,{printer_id:'RMP7000',idempotency_key:key('claim-1')});
    assert.equal(firstClaim.job.order_id,first,'first completion has priority despite later approval');
    const nextClaim=await svcA.claim(agent1,{printer_id:'RMP7000',idempotency_key:key('claim-2')});
    assert.equal(nextClaim.job.order_id,second,'leased job cannot be claimed twice');
    assert.notEqual(firstClaim.job.job_id,nextClaim.job.job_id);
    await assert.rejects(svcA.revise(staff,second,{expected_revision:1,request_data:request(3),idempotency_key:key('old-revision')}),e=>e.code==='STALE_REVISION');
    // Two independent PostgreSQL pools race for one additional eligible NOT_SENT job.
    const third=await prepare(svcA,staff,processor,customer,shop,1);
    await svcA.approve(staff,third,{expected_revision:2,acknowledge_deposit_shortage:true,idempotency_key:key('approve-third')});
    const [thirdA,thirdB]=await Promise.all([
      svcA.claim(agent1,{printer_id:'RMP7000',idempotency_key:key('parallel-claim-a')}),
      svcB.claim(agent2,{printer_id:'RMP7000',idempotency_key:key('parallel-claim-b')})
    ]);
    const acquired=[thirdA.job,thirdB.job].filter(Boolean);
    assert.equal(acquired.length,1,'two physical database connections cannot claim same NOT_SENT job');
    assert.equal(acquired[0].order_id,third);
    const [send1,send2]=await Promise.allSettled([
      svcA.markSending(agent2,firstClaim.job.job_id,{expected_revision:2,lease_token:firstClaim.job.lease_token,idempotency_key:key('send-A')}),
      svcB.markSending(agent2,firstClaim.job.job_id,{expected_revision:2,lease_token:firstClaim.job.lease_token,idempotency_key:key('send-B')})
    ]);
    assert.equal([send1,send2].filter(v=>v.status==='fulfilled').length,1,'one NOT_SENT -> SENDING only');
    assert.equal([send1,send2].filter(v=>v.status==='rejected'&&v.reason.code==='NOT_SENDABLE').length,1);
    await assert.rejects(svcA.revise(staff,first,{expected_revision:2,request_data:request(9),idempotency_key:key('stale-change')}),e=>e.code==='PRINT_ALREADY_ATTEMPTED');
    await svcA.markUnknownForReconciliation(staff,firstClaim.job.job_id,{reason:'simulated network uncertainty',idempotency_key:key('unknown')});
    await assert.rejects(svcA.preflight(agent2,firstClaim.job.job_id,{expected_revision:2,lease_token:firstClaim.job.lease_token}),e=>e.code==='LEASE_EXPIRED');
    const noRetry=await svcA.claim(agent2,{printer_id:'RMP7000',idempotency_key:key('no-retry')});
    assert.equal(noRetry.job,null,'UNKNOWN and leased second job must never be reclaimed');
    const snapshot=await svcA.getOrder(staff,first);
    assert.equal(snapshot.current.staff_approved,true);
    assert.equal(snapshot.current.preview_ref,null);
    assert.equal(snapshot.print_progress.verified_sheets,0);
    assert.equal(snapshot.print_progress.requires_manual_reconciliation,true);
    // Finance and delivery are independent of UNKNOWN; finance cannot fake paper.
    await svcA.recordPayment(staff,first,{direction:'received',method:'cash',amount_vnd:1000,idempotency_key:key('paid')});
    await assert.rejects(svcA.deliver(staff,first,{expected_revision:2,physical_sheets:1,idempotency_key:key('delivery')}),e=>e.code==='PAPER_NOT_VERIFIED');
    const afterMoney=await svcB.getOrder(staff,first);
    assert.equal(afterMoney.received_vnd,1000);
    assert.equal(afterMoney.order.delivered_sheets,0);
    // Conversation handover is a compare-and-swap on an actual PostgreSQL row.
    const conversation='conv-generation-'+randomUUID();
    await svcA.createDraft(staff,{customer_id:customer.customer_id,conversation_id:conversation,request_data:request(1),idempotency_key:key('conv-order')});
    const [h1,h2]=await Promise.allSettled([
      svcA.handover(staff,conversation,{expected_generation:0,idempotency_key:key('handover-a')}),
      svcB.handover(staff,conversation,{expected_generation:0,idempotency_key:key('handover-b')})
    ]);
    assert.equal([h1,h2].filter(v=>v.status==='fulfilled').length,1);
    assert.equal([h1,h2].filter(v=>v.status==='rejected'&&v.reason.code==='STALE_REVISION').length,1);
    await assert.rejects(svcB.withAiSendGate({shop_id:shop,conversation_id:conversation,generation:0},async()=>true),e=>e.code==='AI_REPLY_BLOCKED');
    const returned=await svcB.returnToAi(staff,conversation,{expected_generation:1,idempotency_key:key('return-ai')});
    assert.equal(returned.generation,2);
    assert.equal(await svcA.withAiSendGate({shop_id:shop,conversation_id:conversation,generation:2},async()=>true),true);
  }finally{await Promise.all([poolA.end(),poolB.end()]);}
});
