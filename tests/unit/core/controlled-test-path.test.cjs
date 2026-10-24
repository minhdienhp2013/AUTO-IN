const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const root=process.env.AI1_BUILD_DIR||path.resolve(__dirname,'../../../dist/backend');
const {OrderService}=require(path.join(root,'core/service.js'));

const now=new Date('2026-10-24T04:00:00.000Z');
const shopId='shop-a';
const orderId='00000000-0000-4000-8000-000000000001';
const printerId='RMP7000';
const agent={id:'agent-a',shop_id:shopId,role:'print_agent',verified:true,printer_ids:[printerId]};
const order={id:orderId,shop_id:shopId,customer_id:'customer-a',conversation_id:'conversation-a',active_revision:1,
 manual_lock:false,print_closed:false,closed_reason:null,delivered_sheets:'0'};
const revision={order_id:orderId,revision:1,request_hash:'a'.repeat(64),request_data:{},
 plan:{request_hash:'a'.repeat(64),physical_sheets:1,document_pages:1,printed_faces:1,ready:true,
  status:'READY',printer_id:printerId,artifact_ref:'opaque',verified_by:'processor'}};
const validGrant={shop_id:shopId,order_id:orderId,printer_id:printerId,enabled:true,active:true,
 order_shop_id:shopId,configured_by_role:'owner',configured_by_active:true};
const settings={shop_id:shopId,mode:'controlled_test',printing_enabled:true,manual_lock:false,
 holiday_dates:[],open_at:'00:00',close_at:'24:00',timezone:'Asia/Ho_Chi_Minh'};

function fixture({grant=validGrant,shopSettings=settings}={}){
 let currentGrant=grant;
 let currentSettings=shopSettings;
 const job={id:'job-a',order_id:orderId,revision:1,request_hash:revision.request_hash,approval_id:'approval-a',
  printer_id:printerId,state:'NOT_SENT',claimed_by:null,lease_secret_hash:null,lease_until:null,sent_at:null,mode_at_send:null,
  confirmed_at:now,evidence_sha256:null,cancelled_at:null};
 const scopeChecks=[];
 const writes=[];
 const db={query:async(sql,args=[])=>{
  if(sql.includes('FROM core_print_controlled_test_scopes s JOIN core_orders o')){
   scopeChecks.push(sql);
   const row=currentGrant;
   return {rows:row?[row]:[],rowCount:row?1:0};
  }
  if(sql.startsWith('SELECT o.id FROM core_orders o JOIN core_print_jobs j')){
   const exact=String(args[0])===shopId&&String(args[1])===printerId&&job.state==='NOT_SENT'&&
    (!sql.includes("ss.mode<>'controlled_test'")||currentSettings.mode!=='controlled_test'||Boolean(currentGrant&&
      currentGrant.shop_id===shopId&&currentGrant.order_id===orderId&&currentGrant.printer_id===printerId&&
      currentGrant.enabled&&currentGrant.active&&currentGrant.order_shop_id===shopId&&
      currentGrant.configured_by_role==='owner'&&currentGrant.configured_by_active));
   return {rows:exact?[{id:orderId}]:[],rowCount:exact?1:0};
  }
  if(sql.startsWith('SELECT * FROM core_print_jobs WHERE order_id='))
   return {rows:job.state==='NOT_SENT'?[job]:[],rowCount:job.state==='NOT_SENT'?1:0};
  if(sql.startsWith('UPDATE core_print_jobs SET claimed_by=')){
   job.claimed_by=args[1];job.lease_secret_hash=args[2];job.lease_until=new Date(now.getTime()+90_000);
   writes.push('claim');return {rows:[],rowCount:1};
  }
  if(sql.startsWith("UPDATE core_print_jobs SET state='SENDING'")){
   job.state='SENDING';job.mode_at_send=args[1];job.sent_at=now;job.lease_until=null;
   writes.push('mark-sending');return {rows:[],rowCount:1};
  }
  if(sql.startsWith('UPDATE core_print_jobs SET state=$2,evidence_kind=$3')){
   job.state=args[1];writes.push('report-'+job.state);return {rows:[],rowCount:1};
  }
  return {rows:[],rowCount:0};
 }};
 const store={
  tx:async callback=>callback(db),
  once:async(_db,_principal,_action,_key,_payload,callback)=>callback(),
  one:async(_db,sql)=>{
   if(sql.startsWith('SELECT order_id FROM core_print_jobs'))return {order_id:orderId};
   if(sql.startsWith('SELECT * FROM core_orders'))return order;
   if(sql.startsWith('SELECT * FROM core_print_jobs'))return job;
   if(sql.startsWith('SELECT * FROM core_revisions'))return revision;
   if(sql.startsWith('SELECT * FROM core_shop_settings'))return currentSettings;
   throw new Error('unexpected Core query: '+sql);
  }
 };
 const service=new OrderService(store,()=>new Date(now));
 // This test isolates mode/grant enforcement; the existing production binding
 // and evidence tests continue to cover revision and document gates.
 service.assertJobBinding=async()=>{};
 service.audit=async()=>{};
 return {service,job,scopeChecks,writes,setGrant:value=>{currentGrant=value;},
  setSettings:value=>{currentSettings=value;}};
}

test('controlled_test claim, preflight and mark-sending recheck one exact active owner grant',async()=>{
 const f=fixture();
 const claim=await f.service.claim(agent,{printer_id:printerId,idempotency_key:'claim-a'});
 assert.equal(claim.job.mode,'controlled_test');
 assert.equal(claim.job.order_id,orderId);
 assert.equal(claim.job.printer_id,printerId);
 assert.equal(f.scopeChecks.length,1);
 const preflight=await f.service.preflight(agent,claim.job.job_id,{expected_revision:1,lease_token:claim.job.lease_token});
 assert.equal(preflight.allowed,true);
 assert.equal(preflight.mode,'controlled_test');
 const mark=await f.service.markSending(agent,claim.job.job_id,
  {expected_revision:1,lease_token:claim.job.lease_token,idempotency_key:'send-a'});
 assert.equal(mark.state,'SENDING');
 assert.equal(mark.mode,'controlled_test');
 assert.equal(f.job.mode_at_send,'controlled_test');
 assert.equal(f.scopeChecks.length,3);
 assert.deepEqual(f.writes,['claim','mark-sending']);
});

test('claim returns no work when the grant is missing, expired, disabled, mis-scoped or not owned by an active owner',async()=>{
 const cases=[
  ['missing',null],
  ['expired',{...validGrant,active:false}],
  ['disabled',{...validGrant,enabled:false}],
  ['wrong shop',{...validGrant,shop_id:'shop-other'}],
  ['wrong order',{...validGrant,order_id:'00000000-0000-4000-8000-000000000002'}],
  ['wrong printer',{...validGrant,printer_id:'OTHER'}],
  ['wrong order tenant',{...validGrant,order_shop_id:'shop-other'}],
  ['non-owner grantor',{...validGrant,configured_by_role:'staff'}],
  ['inactive owner',{...validGrant,configured_by_active:false}]
 ];
 for(const [name,grant] of cases){
  const f=fixture({grant});
  const result=await f.service.claim(agent,{printer_id:printerId,idempotency_key:'claim-'+name.replaceAll(' ','-')});
  assert.equal(result.job,null,name);
  assert.deepEqual(f.writes,[],name);
 }
});

test('grant expiry/revocation after claim blocks preflight and mark-sending without crossing send boundary',async()=>{
 const f=fixture();
 const claim=await f.service.claim(agent,{printer_id:printerId,idempotency_key:'claim-a'});
 f.setGrant({...validGrant,active:false});
 await assert.rejects(f.service.preflight(agent,claim.job.job_id,
  {expected_revision:1,lease_token:claim.job.lease_token}),e=>e.code==='CONTROLLED_TEST_SCOPE_REQUIRED');
 f.setGrant(validGrant);
 const allowed=await f.service.preflight(agent,claim.job.job_id,
  {expected_revision:1,lease_token:claim.job.lease_token});
 assert.equal(allowed.allowed,true);
 f.setGrant({...validGrant,configured_by_role:'staff'});
 await assert.rejects(f.service.markSending(agent,claim.job.job_id,
  {expected_revision:1,lease_token:claim.job.lease_token,idempotency_key:'send-a'}),
  e=>e.code==='CONTROLLED_TEST_SCOPE_REQUIRED');
 assert.equal(f.job.state,'NOT_SENT');
 assert.deepEqual(f.writes,['claim']);
});

test('expired Agent lease blocks controlled_test preflight and mark-sending',async()=>{
 const f=fixture();
 const claim=await f.service.claim(agent,{printer_id:printerId,idempotency_key:'claim-a'});
 f.job.lease_until=new Date(now.getTime()-1);
 await assert.rejects(f.service.preflight(agent,claim.job.job_id,
  {expected_revision:1,lease_token:claim.job.lease_token}),e=>e.code==='LEASE_EXPIRED');
 await assert.rejects(f.service.markSending(agent,claim.job.job_id,
  {expected_revision:1,lease_token:claim.job.lease_token,idempotency_key:'send-a'}),e=>e.code==='NOT_SENDABLE');
 assert.equal(f.job.state,'NOT_SENT');
 assert.deepEqual(f.writes,['claim']);
});

test('Agent without the exact printer credential cannot enter controlled_test claim',async()=>{
 const f=fixture();
 await assert.rejects(f.service.claim({...agent,printer_ids:['OTHER']},
  {printer_id:printerId,idempotency_key:'wrong-printer'}),e=>e.code==='PRINTER_SCOPE_DENIED');
 assert.deepEqual(f.writes,[]);
});

test('default simulation mode stays simulation even when a grant row exists',async()=>{
 const defaultSettings={...settings,mode:'simulation',printing_enabled:false};
 const f=fixture({shopSettings:defaultSettings});
 const claim=await f.service.claim(agent,{printer_id:printerId,idempotency_key:'default-off'});
 assert.equal(claim.job.mode,'simulation');
 assert.equal(f.scopeChecks.length,0);
 assert.deepEqual(f.writes,['claim']);
});

test('UNKNOWN remains outside the claim queue after a controlled_test send boundary',async()=>{
 const f=fixture();
 const claim=await f.service.claim(agent,{printer_id:printerId,idempotency_key:'claim-a'});
 await f.service.markSending(agent,claim.job.job_id,
  {expected_revision:1,lease_token:claim.job.lease_token,idempotency_key:'send-a'});
 const report=await f.service.report(agent,claim.job.job_id,{expected_revision:1,lease_token:claim.job.lease_token,
  result:'unknown',evidence_kind:'agent_uncertain',idempotency_key:'unknown-a'});
 assert.equal(report.state,'UNKNOWN');
 const secondClaim=await f.service.claim(agent,{printer_id:printerId,idempotency_key:'claim-b'});
 assert.equal(secondClaim.job,null);
 assert.equal(f.job.state,'UNKNOWN');
 assert.deepEqual(f.writes,['claim','mark-sending','report-UNKNOWN']);
});
