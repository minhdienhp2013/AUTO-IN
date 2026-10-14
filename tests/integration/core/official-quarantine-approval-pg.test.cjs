const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID,createHash}=require('node:crypto');
const {readFileSync}=require('node:fs');
const path=require('node:path');
const root=process.env.AI1_BUILD_DIR||path.resolve(__dirname,'../../../.ai1-build/backend');
const {PgStore}=require(path.join(root,'storage/database.js'));
const {OrderService}=require(path.join(root,'core/service.js'));
const {registerCoreRoutes}=require(path.join(root,'api/routes.js'));
const {createAiOrderPort}=require(path.join(root,'core/ai-order-port.js'));
let pg;try{pg=require('pg')}catch{/* real PG is CI-only */}
const url=process.env.TEST_DATABASE_URL;
const unique=p=>p+'-'+randomUUID();
const digest=x=>createHash('sha256').update(x).digest('hex');

test('REAL PG CODE-008: signed OA quarantine blocks HTTP approval 409/zero job; two workers and release after review',
 {skip:!(pg&&url)&&'Real isolated PostgreSQL TEST_DATABASE_URL required'},async()=>{
 const a=new pg.Pool({connectionString:url,max:5}),b=new pg.Pool({connectionString:url,max:5});
 const shop=unique('gate-shop'),oa=unique('gate-oa'),conv=unique('gate-chat'),
  customer=unique('gate-customer'),staffId=randomUUID(),eventId=unique('gate-inbound');
 const staff={id:staffId,shop_id:shop,role:'staff',verified:true};
 const processor={id:'synthetic-processor',shop_id:shop,role:'processor',verified:true};
 const customerPrincipal={id:'synthetic-confirming-customer',shop_id:shop,role:'customer',
  customer_id:customer,verified:true};
 const serviceA=new OrderService(new PgStore(a)),serviceB=new OrderService(new PgStore(b));
 const approvalRoute=new Map();
 registerCoreRoutes({
  get(){},
  post(route,handler){approvalRoute.set(route,handler)}
 },{
  service:serviceA,auth:{principal:async()=>staff},
  resolveVerifiedCustomer:async()=>customerPrincipal,resolvePrintAgent:async()=>processor
 });
 const approveHandler=approvalRoute.get('/api/v1/orders/:order_id/approvals');
 assert.equal(typeof approveHandler,'function');
 let order;
 async function callApproval(key){
  const reply={
   statusCode:200,
   code(status){this.statusCode=status;return this},
   send(body){return {http_status:this.statusCode,body}}
  };
  const body={expected_revision:2,acknowledge_deposit_shortage:true,idempotency_key:key};
  const result=await approveHandler({headers:{authorization:'Bearer synthetic-fixture'},
   params:{order_id:order},body},reply);
  return result;
 }
 const pending=async()=> (await a.query(
  "SELECT count(*)::int AS n FROM zalo_official_quarantine WHERE oa_id=$1 AND status='NEEDS_HUMAN'",
  [oa])).rows[0].n;
 const jobs=async()=> (await a.query(
  'SELECT count(*)::int AS n FROM core_print_jobs WHERE order_id=$1',[order])).rows[0].n;
 const hold=async(pool,raw,kind,oaId=oa,mapped=false)=>{
  // Signed AI2 ingress locks exactly this scope row before writing receipt.
  // When called with a transaction-bound client the lock lasts to COMMIT.
  await pool.query(
   "INSERT INTO zalo_official_quarantine_scopes(oa_id) VALUES($1) "+
   "ON CONFLICT (oa_id) DO NOTHING",[oaId]);
  const scope=await pool.query(
   "SELECT oa_id FROM zalo_official_quarantine_scopes "+
   "WHERE oa_id=$1 FOR UPDATE",[oaId]);
  assert.equal(scope.rows[0]?.oa_id,oaId);
  const id=randomUUID();
  await pool.query("INSERT INTO zalo_official_quarantine "+
   "(id,oa_id,raw_sha256,kind,customer_id,conversation_id,status) "+
   "VALUES($1,$2,$3,$4,$5,$6,'NEEDS_HUMAN')",
   [id,oaId,digest(raw),kind,mapped?customer:null,mapped?conv:null]);
  return id;
 };
 try{
  assert.match((await a.query('SELECT current_database() AS name')).rows[0].name,/test/i);
  assert.notEqual((await a.query('SELECT pg_backend_pid() pid')).rows[0].pid,
   (await b.query('SELECT pg_backend_pid() pid')).rows[0].pid);
  // This is AI2-owned SQL from the same AI2 validation base, NEVER copied or
  // modified by AI1. Registration in production remains AI0's responsibility.
  const migration=path.resolve(__dirname,'../../../backend/integrations/zalo/migrations/004_official_quarantine.sql');
  await a.query(readFileSync(migration,'utf8'));
  // AI0-owned 005 is the source of truth for the non-secret registry schema.
  // When this old-base AI1 PR lacks 005, run this regression on AI0 staging.
  const registryMigration=path.resolve(__dirname,
   '../../../backend/composition/migrations/005_official_zalo_shop_registry.sql');
  await a.query(readFileSync(registryMigration,'utf8'));
  await a.query('INSERT INTO core_shop_settings(shop_id) VALUES($1)',[shop]);
  await a.query(
   'INSERT INTO core_shop_zalo_oa_registry(shop_id,oa_id,app_id) VALUES($1,$2,$3)',
   [shop,oa,unique('gate-app')]);
  await a.query("INSERT INTO core_users(id,shop_id,username,password_hash,role) VALUES($1,$2,'staff','fixture','staff')",[staffId,shop]);
  await a.query("INSERT INTO zalo_inbound_events(oa_id,event_id,conversation_id,customer_id,occurred_at,payload_json) VALUES($1,$2,$3,$4,now(),$5::jsonb)",
   [oa,eventId,conv,customer,JSON.stringify({kind:'text',text:'fixture first print request'})]);
  const port=createAiOrderPort({store:new PgStore(a),trusted:{shop_id:shop,oa_id:oa}});
  const draft=await port.suggest_draft({conversation_id:conv,customer_id:customer,event_ids:[eventId],
   text:'Print one sheet',expected_generation:0,idempotency_key:unique('draft')});
  assert.equal(draft.status,'created');order=draft.order_id;
  const requestHash=(await a.query(
   'SELECT request_hash FROM core_revisions WHERE order_id=$1 AND revision=1',[order])).rows[0].request_hash;
  await serviceA.publishVerifiedPlan(processor,order,{
   expected_revision:1,
   plan:{request_hash:requestHash,physical_sheets:1,document_pages:1,
    printed_faces:1,ready:true,printer_id:'RMP7000',
    artifact_ref:'synthetic-fixture',verified_by:processor.id},
   idempotency_key:unique('plan')});
  await serviceA.confirm(customerPrincipal,order,{
   expected_revision:2,kind:'request',idempotency_key:unique('confirmed')});
  // Proposal OA must be registered once by AI0; an unbound proposal rejects.
  await a.query('DELETE FROM core_shop_zalo_oa_registry WHERE shop_id=$1 AND oa_id=$2',[shop,oa]);
  const unbound=await callApproval(unique('unbound-proposal'));
  assert.equal(unbound.http_status,409);
  assert.equal(unbound.body.error.code,'PENDING_INBOUND_REVIEW');
  assert.equal(await jobs(),0);
  await a.query(
   'INSERT INTO core_shop_zalo_oa_registry(shop_id,oa_id,app_id) VALUES($1,$2,$3)',
   [shop,oa,unique('gate-app-restored')]);
  const unknown=await hold(b,'oa-unmapped-unknown','unknown');
  const file=await hold(a,'oa-file-mapped','file',oa,true);
  await hold(b,'different-oa','image',unique('foreign-oa'));
  assert.equal(await pending(),2);
  const [one,two]=await Promise.all([
   callApproval(unique('approval-http-a')),
   serviceB.approve(staff,order,{
    expected_revision:2,acknowledge_deposit_shortage:true,idempotency_key:unique('approval-core-b')
   }).then(()=>({unexpected:'approved'}),e=>e)
  ]);
  assert.equal(one.http_status,409);
  assert.equal(one.body.error.code,'PENDING_INBOUND_REVIEW');
  assert.equal(two.code,'PENDING_INBOUND_REVIEW');
  assert.equal(two.status,409);
  assert.equal(await jobs(),0);
  assert.equal((await a.query('SELECT count(*)::int n FROM core_approvals WHERE order_id=$1',[order])).rows[0].n,0);
  await a.query("UPDATE zalo_official_quarantine SET status='REVIEWED',reviewed_at=now(),reviewed_by='synthetic-staff' WHERE id=$1",[file]);
  assert.equal(await pending(),1);
  const still=await callApproval(unique('one-left'));
  assert.equal(still.http_status,409);
  assert.equal(still.body.error.code,'PENDING_INBOUND_REVIEW');
  assert.equal(await jobs(),0);
  // A signed event committed concurrently with the approval attempt must
  // serialize through the same per-OA row lock. Provider timestamp
  // does not justify bypassing a durable event.
  await a.query("UPDATE zalo_official_quarantine SET status='REVIEWED',reviewed_at=now(),reviewed_by='synthetic-staff' WHERE id=$1",[unknown]);
  assert.equal(await pending(),0);
  const client=await b.connect();
  let opened=false;
  try{
   await client.query('BEGIN');opened=true;
   await hold(client,'race-before-approval-commit','click');
   let settled=false;
   const racing=callApproval(unique('race-approval')).then(v=>{settled=true;return v});
   await new Promise(resolve=>setTimeout(resolve,90));
   assert.equal(settled,false,'Core approval must wait for AI2-held per-OA scope row');
   await client.query('COMMIT');opened=false;
   const rejected=await racing;
   assert.equal(rejected.http_status,409);
   assert.equal(rejected.body.error.code,'PENDING_INBOUND_REVIEW');
   assert.equal(await jobs(),0);
  }finally{
   if(opened)await client.query('ROLLBACK');
   client.release();
  }
  assert.equal(await pending(),1);
  await a.query("UPDATE zalo_official_quarantine SET status='REVIEWED',reviewed_at=now(),reviewed_by='synthetic-staff' WHERE oa_id=$1 AND status='NEEDS_HUMAN'",[oa]);
  assert.equal(await pending(),0);
  // Reverse race: Core approval obtains the shared OA-scope row first.
  // Signed ingress must wait until approval commits; its receipt cannot slip
  // into a "clear" read performed inside that approval transaction.
  let afterScopeLock,releaseApproval;
  const atScopeLock=new Promise(resolve=>{afterScopeLock=resolve});
  const holdApproval=new Promise(resolve=>{releaseApproval=resolve});
  let paused=false;
  const pausedPool={
   connect:async()=>{
    const client=await a.connect();
    return {
     query:async(sql,args)=>{
      const result=await client.query(sql,args);
      if(!paused && sql.startsWith('SELECT oa_id FROM public.zalo_official_quarantine_scopes')){
       paused=true;afterScopeLock();await holdApproval;
      }
      return result;
     },
     release:()=>client.release()
    };
   },
   query:(sql,args)=>a.query(sql,args)
  };
  const pausedService=new OrderService(new PgStore(pausedPool));
  const approvalInProgress=pausedService.approve(staff,order,{
   expected_revision:2,acknowledge_deposit_shortage:true,
   idempotency_key:unique('approval-scope-first')});
  await atScopeLock;
  const ingressClient=await b.connect();
  let ingressTxOpen=false;
  let ingressSettled=false;
  try{
   await ingressClient.query('BEGIN');ingressTxOpen=true;
   const incoming=(async()=>{
    await hold(ingressClient,'arrival-after-approval-scope','file');
    await ingressClient.query('COMMIT');ingressTxOpen=false;
    ingressSettled=true;
   })();
   await new Promise(resolve=>setTimeout(resolve,90));
   assert.equal(ingressSettled,false,'signed ingress must wait for approval-held scope row');
   releaseApproval();
   const approved=await approvalInProgress;
   assert.ok(approved.job_id,'Core approval legitimately commits first with no pending receipt');
   await incoming;
  }finally{
   releaseApproval();
   if(ingressTxOpen)await ingressClient.query('ROLLBACK');
   ingressClient.release();
  }
  assert.equal(await jobs(),1,'no duplicate approval/print under reverse lock race');
  assert.equal(await pending(),1,'post-approval receipt remains durably pending for follow-up');
  await a.query("UPDATE zalo_official_quarantine SET status='REVIEWED',reviewed_at=now(),reviewed_by='synthetic-staff' WHERE oa_id=$1 AND status='NEEDS_HUMAN'",[oa]);
  assert.equal(await pending(),0);
  await assert.rejects(serviceB.approve(staff,order,{
   expected_revision:2,acknowledge_deposit_shortage:true,idempotency_key:unique('double-approve')
  }),e=>e.code==='ALREADY_APPROVED'||e.code==='PENDING_INBOUND_REVIEW');
  assert.equal(await jobs(),1);
 }finally{
  try{
   await a.query('DELETE FROM zalo_official_quarantine WHERE oa_id=$1',[oa]);
  }finally{await Promise.all([a.end(),b.end()])}
 }
});
