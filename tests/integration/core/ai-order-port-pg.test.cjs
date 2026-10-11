const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const root=process.env.AI1_BUILD_DIR||path.resolve(__dirname,'../../../.ai1-build/backend');
const {PgStore}=require(path.join(root,'storage/database.js'));
const {OrderService}=require(path.join(root,'core/service.js'));
const {createAiOrderPort}=require(path.join(root,'core/ai-order-port.js'));
let pg;
try{pg=require('pg');}catch{/* AI0 owns root dependencies */}
const url=process.env.TEST_DATABASE_URL;
const ready=Boolean(pg&&url);
const key=()=>randomUUID();
const inserts=async(pool,oa,conversation,customer,ids)=>{
 for(const id of ids)await pool.query(
  'INSERT INTO zalo_inbound_events(oa_id,event_id,conversation_id,customer_id,occurred_at,payload_json) VALUES($1,$2,$3,$4,now(),$5::jsonb)',
  [oa,id,conversation,customer,JSON.stringify({verified:true})]);
};
test('REAL PostgreSQL: AI2 Port draft dedupe, generation and HUMAN routing via independent pools',{skip:!ready&&'Requires TEST_DATABASE_URL and pg'},async()=>{
 const poolA=new pg.Pool({connectionString:url,max:5});
 const poolB=new pg.Pool({connectionString:url,max:5});
 try{
  const dbName=(await poolA.query('SELECT current_database() AS name')).rows[0].name;
  assert.match(dbName,/test/, 'Never test against production');
  const pids=await Promise.all([poolA.query('SELECT pg_backend_pid() AS pid'),poolB.query('SELECT pg_backend_pid() AS pid')]);
  assert.notEqual(pids[0].rows[0].pid,pids[1].rows[0].pid,'independent PostgreSQL connections');
  // Isolated local/CI DB already migrated by AI0; permit standalone migration 005 for CODE-301.
  await poolA.query(fs.readFileSync(path.resolve(__dirname,'../../../backend/storage/migrations/005_ai_order_port.sql'),'utf8'));
  const shop='ai-port-test-'+key(),oa='oa-'+key(),conv='conversation-'+key(),customer='cust-'+key();
  const ids=['evt-'+key(),'evt-'+key()];
  await poolA.query('INSERT INTO core_shop_settings(shop_id) VALUES($1)',[shop]);
  await inserts(poolA,oa,conv,customer,ids);
  const trusted={shop_id:shop,oa_id:oa};
  const portA=createAiOrderPort({store:new PgStore(poolA),trusted});
  const portB=createAiOrderPort({store:new PgStore(poolB),trusted});
  const input={conversation_id:conv,customer_id:customer,event_ids:ids,text:'In văn bản A4 một bản',idempotency_key:'draft-'+key(),expected_generation:0};
  await assert.rejects(portA.suggest_draft({...input,customer_id:'wrong-customer'}),e=>e.code==='AI_CUSTOMER_MISMATCH');
  await assert.rejects(portA.suggest_draft({...input,event_ids:['not-a-verified-event']}),e=>e.code==='UNVERIFIED_AI_EVENTS');
  const foreignPort=createAiOrderPort({store:new PgStore(poolB),trusted:{shop_id:'other-shop',oa_id:oa}});
  await assert.rejects(foreignPort.suggest_draft(input),e=>e.code==='AI_SHOP_NOT_FOUND');
  const [resultA,resultB]=await Promise.all([
   portA.suggest_draft(input),
   portB.suggest_draft({...input,event_ids:[...ids].reverse(),idempotency_key:'different-'+key()})]);
  assert.deepEqual([resultA.status,resultB.status].sort(),['created','existing']);
  assert.equal(resultA.order_id,resultB.order_id);
  const id=resultA.order_id;
  const order=(await poolA.query('SELECT * FROM core_orders WHERE id=$1',[id])).rows[0];
  assert.equal(order.shop_id,shop);assert.equal(order.customer_id,customer);assert.equal(order.conversation_id,conv);
  const data=(await poolA.query('SELECT * FROM core_revisions WHERE order_id=$1',[id])).rows;
  assert.equal(data.length,1);assert.equal(data[0].revision,1);assert.equal(data[0].plan,null);
  assert.equal(data[0].request_data.source,'zalo_ai_suggestion');
  assert.equal((await poolA.query('SELECT count(*)::int AS n FROM core_ai_draft_proposals WHERE shop_id=$1',[shop])).rows[0].n,1);
  assert.equal((await poolA.query('SELECT count(*)::int AS n FROM core_approvals WHERE order_id=$1',[id])).rows[0].n,0);
  assert.equal((await poolA.query('SELECT count(*)::int AS n FROM core_print_jobs WHERE order_id=$1',[id])).rows[0].n,0);
  assert.equal((await poolA.query('SELECT count(*)::int AS n FROM core_confirmations WHERE order_id=$1',[id])).rows[0].n,0);
  assert.equal((await poolA.query('SELECT count(*)::int AS n FROM core_quotes WHERE order_id=$1',[id])).rows[0].n,0);
  await assert.rejects(portA.suggest_draft({...input,text:'changed',idempotency_key:'new-'+key()}),e=>e.code==='AI_DRAFT_IDEMPOTENCY_CONFLICT');
  await assert.rejects(portB.suggest_draft({...input,text:'changed'}),e=>e.code==='AI_DRAFT_IDEMPOTENCY_CONFLICT');
  assert.equal((await poolB.query('SELECT count(*)::int AS n FROM core_ai_draft_proposals WHERE shop_id=$1',
    [shop])).rows[0].n,1,'conflicting idempotency cannot create a second draft');
  await assert.rejects(portA.suggest_draft({...input,event_ids:['not-same'],idempotency_key:input.idempotency_key}),e=>e.code==='UNVERIFIED_AI_EVENTS');
  assert.deepEqual(await portA.suggest_draft({...input,expected_generation:1}),{status:'stale_generation'});
  // Missing control + future generation must not insert a control row or proposal.
  const isolatedConv='conv-no-control-'+key(),isolatedEvent='evt-'+key();
  await inserts(poolA,oa,isolatedConv,customer,[isolatedEvent]);
  const missingDraft=await portB.suggest_draft({conversation_id:isolatedConv,customer_id:customer,event_ids:[isolatedEvent],
    text:'Unlinked stale',idempotency_key:'stale-'+key(),expected_generation:8});
  assert.deepEqual(missingDraft,{status:'stale_generation'});
  const missingRoute=await portA.route_human({conversation_id:isolatedConv,
    reason:'Unlinked stale routing',event_ids:[isolatedEvent],expected_generation:9});
  assert.deepEqual(missingRoute,{status:'stale_generation'});
  assert.equal((await poolA.query('SELECT count(*)::int AS n FROM core_conversation_controls WHERE shop_id=$1 AND conversation_id=$2',
    [shop,isolatedConv])).rows[0].n,0,'stale request cannot create a control row');
  assert.equal((await poolA.query('SELECT count(*)::int AS n FROM core_orders WHERE shop_id=$1 AND conversation_id=$2',
    [shop,isolatedConv])).rows[0].n,0,'stale request cannot create an order');

  const request={conversation_id:conv,reason:'Cần người đọc ảnh',event_ids:ids,expected_generation:0};
  const [routeA,routeB]=await Promise.all([portA.route_human(request),portB.route_human(request)]);
  assert.deepEqual([routeA.status,routeB.status].sort(),['routed','stale_generation']);
  assert.equal([routeA,routeB].filter(r=>r.status==='routed').length,1);
  assert.equal([routeA,routeB].find(r=>r.status==='routed').generation,1);
  assert.deepEqual(await portA.route_human(request),{status:'stale_generation'},
    'identical retry with old generation must be stale, not already_routed');
  const row=(await poolA.query('SELECT status,claimed_by,generation::text AS generation,ai_route_reason FROM core_conversation_controls WHERE shop_id=$1 AND conversation_id=$2',[shop,conv])).rows[0];
  assert.equal(row.status,'HUMAN');assert.equal(row.claimed_by,null);assert.equal(row.generation,'1');
  assert.equal(row.ai_route_reason,'Cần người đọc ảnh');
  assert.deepEqual(await portA.suggest_draft(input),{status:'stale_generation'});
  assert.deepEqual(await portB.suggest_draft({...input,expected_generation:1}),{status:'stale_generation'});
  assert.deepEqual(await portA.route_human({...request,expected_generation:99}),{status:'stale_generation'});
  assert.deepEqual(await portA.route_human({...request,expected_generation:0}),{status:'stale_generation'});
  const currentHuman=await portA.route_human({...request,expected_generation:1});
  assert.equal(currentHuman.status,'already_routed');
  assert.equal(currentHuman.generation,1);
  assert.equal((await poolA.query('SELECT generation::text AS generation FROM core_conversation_controls WHERE shop_id=$1 AND conversation_id=$2',
    [shop,conv])).rows[0].generation,'1','already_routed must not increment generation');
  const staffId=randomUUID();
  await poolA.query("INSERT INTO core_users(id,shop_id,username,password_hash,role) VALUES($1,$2,'staff',$3,'staff')",[staffId,shop,'test-hash-never-used']);
  const staff={id:staffId,role:'staff',shop_id:shop,verified:true};
  const svc=new OrderService(new PgStore(poolA));
  const claim=await svc.handover(staff,conv,{expected_generation:1,idempotency_key:'staff-claim-'+key()});
  assert.equal(claim.claimed_by,staffId);assert.equal(claim.generation,2);
  assert.deepEqual(await portA.route_human(request),{status:'stale_generation'});
  await assert.rejects(svc.withAiSendGate({shop_id:shop,conversation_id:conv,generation:0},async()=>true),e=>e.code==='AI_REPLY_BLOCKED');
  const returned=await svc.returnToAi(staff,conv,{expected_generation:2,idempotency_key:'staff-return-'+key()});
  assert.equal(returned.status,'AI');assert.equal(returned.generation,3);
  assert.equal(await svc.withAiSendGate({shop_id:shop,conversation_id:conv,generation:3},async()=>true),true);
  // Different customer cannot hijack existing conversation even with a verified OA event.
  const anotherCustomer='cust-'+key(),third='evt-'+key();
  await inserts(poolA,oa,conv,anotherCustomer,[third]);
  await assert.rejects(portB.suggest_draft({conversation_id:conv,customer_id:anotherCustomer,event_ids:[third],text:'different',idempotency_key:'x-'+key(),expected_generation:3}),e=>e.code==='AI_CONVERSATION_CUSTOMER_CONFLICT');
 }finally{await Promise.all([poolA.end(),poolB.end()]);}
});
