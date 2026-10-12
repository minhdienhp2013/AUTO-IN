/**
 * CODE-008: real PostgreSQL, REAL AI1/AI2 composition transactions,
 * synthetic SIGNED webhook only. Never an actual Zalo customer or printer.
 *
 * GREEN safety assertions coexist with RED business contract cases until
 * transactional append/revision and API PENDING_REVIEW -> HTTP409 ship.
 * A red required case MUST NOT become SKIP just to make release CI green.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {asSqlPool,assertIsolatedSimulationDatabase} from '../../backend/composition/postgres.ts';
import {createCoreModule} from '../../backend/core/factory.ts';
import {createAiOrderPort} from '../../backend/core/ai-order-port.ts';
import {guardedSyntheticConversationOrders} from '../../backend/composition/conversation-order-guard.ts';
import {createSyntheticZaloIngress} from '../../backend/composition/zalo-simulation.ts';
import {buildIntegratedApp} from '../../backend/composition/runtime.ts';
import {requireIsolatedPgEnv} from './integration-preflight.mjs';
import {requireExactCode405Checkout} from './code405-exact-sha.mjs';
import {assertSafeDatabase} from './product-adapter.mjs';

const enabled=process.env.AUTOIN_RUN_PRODUCT_ACCEPTANCE==='1';
const skip=enabled?false:'CODE-008 product NOT RUN: require --integration, exact integrated SHA and real isolated PostgreSQL';
const timeout=120000;
const rand=()=>randomUUID();
// Exercise the database trigger independently of the Core business rejection.
// A Core 409 is NOT evidence that the PostgreSQL trigger was exercised.
async function assertDirectSqlPendingBlock(pool,orderId,actorId){
 const rev=(await pool.query(
  'SELECT revision,request_hash FROM core_revisions WHERE order_id=$1 ORDER BY revision DESC LIMIT 1',
  [orderId])).rows[0];
 assert.ok(rev?.request_hash,'Expected an immutable test revision before raw SQL gate');
 await assert.rejects(pool.query(
  'INSERT INTO core_approvals(id,order_id,revision,request_hash,actor_id) VALUES($1,$2,$3,$4,$5)',
  [rand(),orderId,rev.revision,rev.request_hash,actorId]),
  e=>e?.code==='P0001'&&String(e.message).includes('AI0_PENDING_INBOUND_REVIEW'),
  'A direct SQL insert must remain rejected by PostgreSQL P0001 even when Core emits HTTP 409');
}
const isPendingCoreConflict=e=>e?.code==='PENDING_INBOUND_REVIEW'&&e?.status===409;
const count=async(pool,table,shop)=>(await pool.query(
 table==='core_orders'?
 'SELECT count(*)::int AS n FROM core_orders WHERE shop_id=$1':
 'SELECT count(*)::int AS n FROM '+table+' WHERE order_id IN (SELECT id FROM core_orders WHERE shop_id=$1)',
 [shop])).rows[0].n;

async function withSignedConversation(fn){
 requireIsolatedPgEnv();
 requireExactCode405Checkout(process.env.AUTOIN_INTEGRATION_SHA);
 const url=process.env.AUTOIN_TEST_DATABASE_URL;
 assertSafeDatabase(url);
 if(process.env.TEST_DATABASE_URL && process.env.TEST_DATABASE_URL!==url)
  throw Error('CODE008 isolated TEST_DATABASE_URL mismatch');
 assertIsolatedSimulationDatabase(url);
 const pool=new pg.Pool({connectionString:url,max:7,connectionTimeoutMillis:5000});
 const tag=rand(),shop='autoin-test-code008-'+tag,oa='oa-'+tag;
 const customer='customer-'+tag,conversation='conversation-'+tag,key=rand()+rand();
 const scope={shop_id:shop,oa_id:oa},core=createCoreModule({pool:asSqlPool(pool)});
 let app,bootstrapped=false;
 try{
  const password='fixture-'+rand();
  await core.auth.bootstrapOwner({shop_id:shop,username:'owner',password,bootstrap_enabled:true});
  bootstrapped=true;
  const actor=(await pool.query("SELECT id FROM core_users WHERE shop_id=$1 AND username='owner'",[shop])).rows[0].id;
  const staff={id:actor,shop_id:shop,role:'owner',verified:true};
  const ownerSession=await core.auth.login(shop,'owner',password);
  const customerCredential={id:'fixture-customer-'+tag,shop_id:shop,customer_id:customer,role:'customer',verified:true};
  const processor={id:'fixture-processor-'+tag,shop_id:shop,role:'processor',verified:true};
  app=buildIntegratedApp({pool:asSqlPool(pool),zaloWebhook:createSyntheticZaloIngress(pool,{
   kind:'synthetic_fixture',...scope,fixture_key:key
  })});
  await app.ready();
  const port=guardedSyntheticConversationOrders(pool,scope,
   createAiOrderPort({store:core.store,trusted:scope}));
  async function webhook(event_id,{kind='text',occurred_at=new Date().toISOString(),text='In A4'}={}){
   const event={synthetic_fixture:true,event_id,oa_id:oa,customer_id:customer,
    conversation_id:conversation,occurred_at,kind,
    ...(kind==='text'?{text}:{filename:'more-file.png',file_ref:'untrusted-customer-path'})};
   const response=await app.inject({method:'POST',url:'/webhooks/zalo',
    headers:{'content-type':'application/json','x-test-fixture-key':key},
    payload:JSON.stringify(event)});
   assert.equal(response.statusCode,200,JSON.stringify(response.json()));
   return response.json();
  }
  const propose=(event_id,text='In A4')=>port.suggest_draft({
   conversation_id:conversation,customer_id:customer,event_ids:[event_id],
   text,idempotency_key:'proposal-'+event_id,expected_generation:0
  });
  const original=async()=>{
   const id='first-'+rand();
   assert.equal((await webhook(id)).status,'accepted');
   const receipt=await propose(id);
   assert.equal(receipt.status,'created',JSON.stringify(receipt));
   assert.equal(await count(pool,'core_orders',shop),1);
   return {eventId:id,orderId:receipt.order_id};
  };
  const revision=async(orderId)=>(await pool.query(
   'SELECT active_revision FROM core_orders WHERE id=$1',[orderId])).rows[0].active_revision;
  const confirm=async orderId=>{
   const row=(await pool.query('SELECT request_hash FROM core_revisions WHERE order_id=$1 AND revision=1',[orderId])).rows[0];
   const plan={request_hash:row.request_hash,ready:true,printer_id:'RMP7000',
    verified_by:'TEST_ONLY_NOT_AI3',artifact_ref:'synthetic/no-real-artifact',
    document_pages:1,printed_faces:1,physical_sheets:1};
   const planResult=await core.service.publishVerifiedPlan(processor,orderId,{
    expected_revision:1,plan,idempotency_key:'synthetic-plan-'+orderId
   });
   assert.equal(planResult.revision,2);
   await core.service.confirm(customerCredential,orderId,{
    expected_revision:2,kind:'request',idempotency_key:'fixture-credential-'+orderId
   });
   return 2;
  };
  await fn({app,pool,shop,oa,customer,conversation,webhook,propose,original,
   revision,count:table=>count(pool,table,shop),confirm,core,staff,staffToken:ownerSession.token});
 }finally{
  if(app)await app.close();
  if(bootstrapped){
   // Test-only synthetic shop; no real customer data. CI is isolated.
   const stmts=[
    'DELETE FROM core_print_jobs WHERE order_id IN (SELECT id FROM core_orders WHERE shop_id=$1)',
    'DELETE FROM core_approvals WHERE order_id IN (SELECT id FROM core_orders WHERE shop_id=$1)',
    'DELETE FROM core_confirmations WHERE order_id IN (SELECT id FROM core_orders WHERE shop_id=$1)',
    'DELETE FROM core_quotes WHERE order_id IN (SELECT id FROM core_orders WHERE shop_id=$1)',
    'DELETE FROM zalo_outbound WHERE shop_id=$1',
    'DELETE FROM zalo_batch_items WHERE oa_id=$1','DELETE FROM zalo_batches WHERE oa_id=$1',
    'DELETE FROM zalo_process_queue WHERE oa_id=$1','DELETE FROM zalo_inbound_events WHERE oa_id=$1',
    'DELETE FROM core_ai_draft_proposals WHERE shop_id=$1',
    'DELETE FROM core_audit WHERE shop_id=$1',
    'DELETE FROM core_revisions WHERE order_id IN (SELECT id FROM core_orders WHERE shop_id=$1)',
    'DELETE FROM core_orders WHERE shop_id=$1',
    'DELETE FROM core_conversation_controls WHERE shop_id=$1',
    'DELETE FROM core_sessions WHERE user_id IN (SELECT id FROM core_users WHERE shop_id=$1)',
    'DELETE FROM core_users WHERE shop_id=$1','DELETE FROM core_shop_settings WHERE shop_id=$1'
   ];
   for(const sql of stmts)await pool.query(sql,sql.includes('WHERE oa_id=$1')?[oa]:[shop]).catch(error=>{
    throw Error('CODE008 fixture cleanup failed at '+sql+': '+error.message);
   });
  }
  await pool.end();
 }
}

test('C008-PG-01: signed files >60s apart in distinct batches do NOT mint second pre-approval order',{skip,timeout},()=>withSignedConversation(async f=>{
 const first=await f.original();
 // Simulate elapsed >60 seconds in isolated PostgreSQL, not a real-time sleep.
 await f.pool.query("UPDATE zalo_inbound_events SET received_at=received_at-interval '65 seconds' WHERE oa_id=$1 AND event_id=$2",[f.oa,first.eventId]);
 const extra='second-'+rand();
 assert.equal((await f.webhook(extra,{kind:'image'})).status,'accepted');
 const delta=(await f.pool.query('SELECT extract(epoch FROM (max(received_at)-min(received_at)))::int AS seconds FROM zalo_inbound_events WHERE oa_id=$1',[f.oa])).rows[0].seconds;
 assert.ok(delta>60,'Distinct server-received batch timestamps must be >60 seconds');
 const held=await f.propose(extra,'[SYSTEM ATTACHMENT ONLY]');
 assert.equal(held.status,'stale_generation','Needs HUMAN/HELD rather than creating a wrong new order');
 assert.equal(await f.count('core_orders'),1);
 assert.equal(await f.count('core_approvals'),0);
 assert.equal(await f.count('core_print_jobs'),0);
 const third='third-file-'+rand();
 assert.equal((await f.webhook(third,{kind:'image'})).status,'accepted');
 const again=await f.propose(third,'[SYSTEM ATTACHMENT ONLY]');
 assert.equal(again.status,'stale_generation');
 assert.equal(await f.count('core_orders'),1);
 assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM zalo_inbound_events WHERE oa_id=$1',[f.oa])).rows[0].n,3);
}));

test('C008-PG-02 REQUIRED RED until AI1/AI2 append Port: pre-approval file must create NEW revision and invalidate old confirmation',{skip,timeout},()=>withSignedConversation(async f=>{
 const first=await f.original();
 await f.confirm(first.orderId); // TEST-ONLY synthetic credential at revision 2.
 assert.equal(await f.revision(first.orderId),2);
 const next='append-'+rand();
 assert.equal((await f.webhook(next,{kind:'image'})).status,'accepted');
 await f.propose(next,'[SYSTEM ATTACHMENT ONLY]');
 assert.equal(await f.count('core_orders'),1);
 // This MUST be RED while AI2 only parks the event; it must NOT be passed
 // by silently labelling an unreviewed file as already adopted.
 const rev=await f.revision(first.orderId);
 assert.ok(rev>=3,'CODE008 P0: file arrived pre-approval but active revision was NOT incremented; printing could omit it');
 assert.equal(await f.count('core_approvals'),0);
 assert.equal(await f.count('core_print_jobs'),0);
 const old=(await f.pool.query('SELECT count(*)::int AS n FROM core_confirmations WHERE order_id=$1 AND revision=2',[first.orderId])).rows[0].n;
 assert.equal(old,1,'Historical confirmation remains audited, NEVER transferred to new revision');
 const current=(await f.pool.query('SELECT count(*)::int AS n FROM core_confirmations WHERE order_id=$1 AND revision=$2',[first.orderId,rev])).rows[0].n;
 assert.equal(current,0,'A new active revision requires fresh customer confirmation');
}));

test('C008-HTTP-03: Core business PENDING_INBOUND_REVIEW HTTP409 plus independent raw SQL P0001 gate',{skip,timeout},()=>withSignedConversation(async f=>{
 const first=await f.original();
 await f.confirm(first.orderId);
 const event='preapproval-'+rand();
 assert.equal((await f.webhook(event,{kind:'image',occurred_at:new Date(Date.now()+60000).toISOString()})).status,'accepted');
 const result=await f.app.inject({method:'POST',url:'/api/v1/orders/'+first.orderId+'/approvals',
  headers:{authorization:'Bearer '+f.staffToken},
  payload:{expected_revision:2,acknowledge_deposit_shortage:false,idempotency_key:'approval-'+rand()}});
 // Core must return a machine-readable business HTTP 409, not raw SQL P0001/HTTP 500.
 assert.equal(result.statusCode,409,'P0 CODE008: signed pending inbound must return HTTP409, NOT internal 500: '+JSON.stringify(result.json()));
 assert.equal(result.json()?.error?.code,'PENDING_INBOUND_REVIEW',
  'Core must expose the exact business error for unresolved file');
 await assert.rejects(f.core.service.approve(f.staff,first.orderId,{
  expected_revision:2,acknowledge_deposit_shortage:false,idempotency_key:'core-attempt-'+rand()
 }),isPendingCoreConflict,'Core must reject pending inbound as business DomainError HTTP409');
 await assertDirectSqlPendingBlock(f.pool,first.orderId,f.staff.id);
 assert.equal(await f.count('core_approvals'),0);
 assert.equal(await f.count('core_print_jobs'),0);
 assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM zalo_inbound_events WHERE oa_id=$1 AND event_id=$2',
  [f.oa,event])).rows[0].n,1,'Blocked approval may NOT discard signed unreviewed event');
}));

test('C008-PG-04: duplicate webhook, lost ACK and two independent AI2 workers cannot split order',{skip,timeout},()=>withSignedConversation(async f=>{
 const first=await f.original();
 const extra='replay-'+rand();
 const payload={kind:'image',occurred_at:new Date().toISOString()};
 assert.equal((await f.webhook(extra,payload)).status,'accepted');
 const [a,b]=await Promise.all([f.propose(extra,'[SYSTEM ATTACHMENT ONLY]'),f.propose(extra,'[SYSTEM ATTACHMENT ONLY]')]);
 assert.equal(a.status,'stale_generation');assert.equal(b.status,'stale_generation');
 assert.equal((await f.webhook(extra,payload)).status,'duplicate','Synthetic transport duplicate');
 const retried=await f.propose(extra,'[SYSTEM ATTACHMENT ONLY]'); // Lost ACK/retry.
 assert.equal(retried.status,'stale_generation');
 assert.equal(await f.count('core_orders'),1);
 assert.equal(await f.count('core_print_jobs'),0);
 assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM zalo_inbound_events WHERE oa_id=$1 AND event_id=$2',[f.oa,extra])).rows[0].n,1);
 assert.equal(await f.revision(first.orderId),1,'HELD is not adoption: never misreport the batch as included');
}));

test('C008-PG-05: after staff approval, genuinely new request creates NEW order with ZERO auto-approve/print',{skip,timeout},()=>withSignedConversation(async f=>{
 const first=await f.original(); await f.confirm(first.orderId);
 const approved=await f.core.service.approve(f.staff,first.orderId,{
  expected_revision:2,acknowledge_deposit_shortage:false,idempotency_key:'approved-'+rand()
 });
 assert.ok(approved.job_id);assert.equal(await f.count('core_orders'),1);
 await f.pool.query('SELECT pg_sleep(0.03)');
 const next='after-approval-'+rand();
 assert.equal((await f.webhook(next)).status,'accepted');
 const second=await f.propose(next,'Đây là tài liệu in mới');
 assert.equal(second.status,'created',JSON.stringify(second));
 assert.notEqual(second.order_id,first.orderId);
 assert.equal(await f.count('core_orders'),2);
 const secondState=(await f.pool.query('SELECT active_revision FROM core_orders WHERE id=$1',[second.order_id])).rows[0];
 assert.equal(secondState.active_revision,1);
 assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM core_approvals WHERE order_id=$1',[second.order_id])).rows[0].n,0);
 assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM core_print_jobs WHERE order_id=$1',[second.order_id])).rows[0].n,0);
 assert.equal(await f.revision(first.orderId),2,'Approved old revision must remain untouched');
}));

test('C008-PG-06: delayed old event with forged future provider clock cannot create second order',{skip,timeout},()=>withSignedConversation(async f=>{
 const first=await f.original();await f.confirm(first.orderId);
 await f.core.service.approve(f.staff,first.orderId,{
  expected_revision:2,acknowledge_deposit_shortage:false,idempotency_key:'approved-'+rand()
 });
 const extra='late-'+rand();
 assert.equal((await f.webhook(extra,{occurred_at:new Date(Date.now()-180000).toISOString()})).status,'accepted');
 const held=await f.propose(extra,'Tin cũ đến chậm');
 assert.equal(held.status,'stale_generation');
 assert.equal(await f.count('core_orders'),1);
 assert.equal(await f.count('core_print_jobs'),1,'No implicit second print from old delayed message');
}));


test('C008-PG-07: two independent approval workers cannot bypass a committed pre-approval signed file',{skip,timeout},()=>withSignedConversation(async f=>{
 const original=await f.original();await f.confirm(original.orderId);
 const eid='committed-pending-'+rand();
 assert.equal((await f.webhook(eid,{kind:'image',occurred_at:new Date(Date.now()+180000).toISOString()})).status,'accepted');
 // Each Core tx gets its own PostgreSQL connection through its Pool.
 const results=await Promise.allSettled([0,1].map(n=>f.core.service.approve(f.staff,original.orderId,{
  expected_revision:2,acknowledge_deposit_shortage:false,idempotency_key:'worker-'+n+'-'+rand()
 })));
 assert.equal(results.length,2);
 assert.equal(results.filter(x=>x.status==='fulfilled').length,0,'NO worker may approve ahead of pending event');
 for(const r of results)assert.ok(r.status==='rejected'&&isPendingCoreConflict(r.reason),
  'Both independent Core approval transactions must return PENDING_INBOUND_REVIEW HTTP409');
 // A separate direct SQL attempt still MUST hit the PostgreSQL trigger (P0001).
 await assertDirectSqlPendingBlock(f.pool,original.orderId,f.staff.id);
 assert.equal(await f.count('core_orders'),1);
 assert.equal(await f.count('core_approvals'),0);
 assert.equal(await f.count('core_print_jobs'),0);
 assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM zalo_inbound_events WHERE oa_id=$1 AND event_id=$2',
  [f.oa,eid])).rows[0].n,1);
}));

test('C008-PG-08: ambiguous multi-open same conversation stays HELD, not silently merged or approved',{skip,timeout},()=>withSignedConversation(async f=>{
 await f.original();
 const second=await f.core.service.createDraft(f.staff,{
  customer_id:f.customer,conversation_id:f.conversation,
  request_data:{documents:[{filename:'explicit-separate-staff-order.pdf',copies:1}]},
  idempotency_key:'staff-created-separate-'+rand()
 });
 assert.ok(second.order_id);
 assert.equal(await f.count('core_orders'),2);
 const eid='ambiguous-'+rand();
 assert.equal((await f.webhook(eid,{text:'Thêm một bản'})).status,'accepted');
 const result=await f.propose(eid,'Thêm một bản');
 assert.equal(result.status,'stale_generation','Ambiguous event is held for HUMAN identification');
 assert.equal(await f.count('core_orders'),2);
 assert.equal(await f.count('core_approvals'),0);
 assert.equal(await f.count('core_print_jobs'),0);
 assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM zalo_inbound_events WHERE oa_id=$1 AND event_id=$2',
 [f.oa,eid])).rows[0].n,1);
}));


test('C008-PG-09: racing signed file ingress against staff approval obeys DB commit ordering',{skip,timeout},()=>withSignedConversation(async f=>{
 const first=await f.original();await f.confirm(first.orderId);
 const eid='simultaneous-'+rand();
 const [inbound,approval]=await Promise.allSettled([
  f.webhook(eid,{kind:'image',occurred_at:new Date(Date.now()+90000).toISOString()}),
  f.core.service.approve(f.staff,first.orderId,{
   expected_revision:2,acknowledge_deposit_shortage:false,idempotency_key:'race-approve-'+rand()
  })
 ]);
 assert.equal(inbound.status,'fulfilled','Signed ingress must persist even when staff approves simultaneously');
 assert.equal(inbound.value.status,'accepted');
 const stored=(await f.pool.query('SELECT received_at FROM zalo_inbound_events WHERE oa_id=$1 AND event_id=$2',[f.oa,eid])).rows;
 assert.equal(stored.length,1,'Inbound event must not be lost during approval transaction');
 if(approval.status==='rejected'){
  assert.ok(isPendingCoreConflict(approval.reason),'Core must reject a committed pending inbound with business HTTP409');
  assert.equal(await f.count('core_approvals'),0);
  assert.equal(await f.count('core_print_jobs'),0);
  assert.equal(await f.count('core_orders'),1);
 }else{
  // An approval may succeed ONLY if it won the row lock *before* signed
  // webhook was durably received; user-controlled occurred_at cannot decide.
  const ordering=(await f.pool.query(
   'SELECT e.received_at <= a.created_at AS inbound_not_later FROM zalo_inbound_events e '+
   'JOIN core_approvals a ON a.order_id=$1 WHERE e.oa_id=$2 AND e.event_id=$3',
   [first.orderId,f.oa,eid])).rows[0];
  assert.equal(ordering?.inbound_not_later,false,
   'P0 LOST FILE: staff approved while signed file had already been committed to PG');
  assert.equal(await f.count('core_approvals'),1);
  assert.equal(await f.count('core_print_jobs'),1);
  const next=await f.propose(eid,'[SYSTEM ATTACHMENT ONLY]');
  // For a near-simultaneous boundary, conservatively HOLD/NEEDS_HUMAN is
  // allowed even if trusted DB microseconds say receive was marginally later.
  // Creation is allowed only as a distinct order, never mutation/reprint.
  assert.ok(['created','stale_generation'].includes(next.status),
   'Race resolution must either create a distinct safe order or hold for HUMAN');
  if(next.status==='created'){
   assert.notEqual(next.order_id,first.orderId);
   assert.equal(await f.count('core_orders'),2);
   assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM core_approvals WHERE order_id=$1',[next.order_id])).rows[0].n,0);
  }else{
   assert.equal(await f.count('core_orders'),1,'HELD keeps the event for review; must not discard/create silently');
  }
  assert.equal(await f.count('core_print_jobs'),1,'No auto re-print of the first job or print of a new job');
 }
}));
