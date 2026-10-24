const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const root=process.env.AI1_BUILD_DIR||path.resolve(__dirname,'../../../dist/backend');
const {OrderService}=require(path.join(root,'core/service.js'));
const {canonical,sha}=require(path.join(root,'core/model.js'));

const now=new Date('2026-10-24T04:00:00.000Z');
const shopId='shop-a';
const orderId='00000000-0000-4000-8000-000000000001';
const otherOrderId='00000000-0000-4000-8000-000000000002';
const printerId='RMP7000';
const requestData={documents:[{artifact_name:'pilot.pdf'}],copies:1,duplex:false,paper:'A4',color:'black_white'};
const requestHash=sha(canonical(requestData));
const agent={id:'agent-a',shop_id:shopId,role:'print_agent',verified:true,printer_ids:[printerId]};
const order={id:orderId,shop_id:shopId,customer_id:'customer-a',conversation_id:'conversation-a',active_revision:1,
 manual_lock:false,print_closed:false,closed_reason:null,delivered_sheets:'0'};
const revision={order_id:orderId,revision:1,request_hash:requestHash,request_data:requestData,
 plan:{request_hash:requestHash,physical_sheets:1,document_pages:1,printed_faces:1,ready:true,
  status:'READY',printer_id:printerId,artifact_ref:'opaque',verified_by:'processor'}};
const validGrant={shop_id:shopId,order_id:orderId,printer_id:printerId,enabled:true,active:true,
 duration_valid:true,order_shop_id:shopId,configured_by_role:'owner',configured_by_active:true};
const settings={shop_id:shopId,mode:'controlled_test',printing_enabled:true,manual_lock:false,
 holiday_dates:[],open_at:'00:00',close_at:'24:00',timezone:'Asia/Ho_Chi_Minh'};
const config={shop_id:shopId,printer_id:printerId,agent_id:agent.id,enabled:true,
 allow_real_print:false,tested_at:now};
const proof={candidate:{source:{sha256:'b'.repeat(64)},settings_sha256:'c'.repeat(64)},
 authorization:{evidence_sha256:'d'.repeat(64)},source:{}};

function fixture({grant=validGrant,additionalGrant=null,shopSettings=settings}={}){
 let currentGrant=grant;
 const currentAdditionalGrant=additionalGrant;
 let currentSettings=shopSettings;
 const jobs={
  [orderId]:{id:'job-a',order_id:orderId,revision:1,request_hash:requestHash,approval_id:null,
  pilot_authorization_id:'authorization-a',printer_id:printerId,state:'NOT_SENT',claimed_by:null,
  lease_secret_hash:null,lease_until:null,sent_at:null,mode_at_send:null,evidence_sha256:'d'.repeat(64),
  cancelled_at:null},
  [otherOrderId]:{id:'job-other',order_id:otherOrderId,revision:1,request_hash:requestHash,approval_id:null,
   pilot_authorization_id:'authorization-other',printer_id:printerId,state:'NOT_SENT',claimed_by:null,
   lease_secret_hash:null,lease_until:null,sent_at:null,mode_at_send:null,evidence_sha256:'e'.repeat(64),
   cancelled_at:null}
 };
 const orders={[orderId]:order,[otherOrderId]:{...order,id:otherOrderId}};
 const revisions={[orderId]:revision,[otherOrderId]:{...revision,order_id:otherOrderId}};
 const scopeChecks=[];
 const claimQueries=[];
 const writes=[];
 const db={query:async(sql,args=[])=>{
  if(sql.includes('FROM core_print_controlled_test_scopes s JOIN core_orders o')){
   scopeChecks.push(sql);
   const found=[currentGrant,currentAdditionalGrant].filter(row=>row&&row.shop_id===args[0]&&
    row.order_id===args[1]&&row.printer_id===args[2]);
   return {rows:found,rowCount:found.length};
  }
  if(sql.includes('FROM core_pilot_shop_config'))return {rows:[config],rowCount:1};
  if(sql.startsWith('SELECT o.id FROM core_orders o JOIN core_print_jobs j')){
   claimQueries.push({sql,args});
   const orderIds=[otherOrderId,orderId].filter(id=>{
    const row=[currentGrant,currentAdditionalGrant].find(value=>value&&value.order_id===id);
    return currentSettings.mode!=='controlled_test'||Boolean(row&&row.shop_id===shopId&&
     row.printer_id===printerId&&row.enabled&&row.active&&row.duration_valid&&
     row.order_shop_id===shopId&&row.configured_by_role==='owner'&&row.configured_by_active);
   });
   const selected=orderIds.find(id=>!sql.includes('AND o.id=$4')||id===args[3]);
   return {rows:selected?[{id:selected}]:[],rowCount:selected?1:0};
  }
  if(sql.startsWith('UPDATE core_print_jobs SET claimed_by=')){
   const job=Object.values(jobs).find(row=>row.id===args[0]);
   job.claimed_by=args[1];job.lease_secret_hash=args[2];job.lease_until=new Date(now.getTime()+90_000);
   writes.push('claim');return {rows:[],rowCount:1};
  }
  if(sql.startsWith("UPDATE core_print_jobs SET state='SENDING'")){
   const job=Object.values(jobs).find(row=>row.id===args[0]);
   job.state='SENDING';job.mode_at_send=args[1];job.sent_at=now;job.lease_until=null;
   writes.push('mark-sending');return {rows:[],rowCount:1};
  }
  return {rows:[],rowCount:0};
 }};
 const store={
  tx:async callback=>callback(db),
  once:async(_db,_principal,_action,_key,_payload,callback)=>callback(),
  one:async(_db,sql,args=[])=>{
   if(sql.startsWith('SELECT mode FROM core_shop_settings'))return {mode:currentSettings.mode};
   if(sql.startsWith('SELECT order_id FROM core_print_jobs'))return {order_id:Object.values(jobs).find(row=>row.id===args[0])?.order_id};
   if(sql.startsWith('SELECT * FROM core_orders'))return orders[args[0]];
   if(sql.startsWith('SELECT * FROM core_print_jobs'))return sql.includes('WHERE order_id=$1')
    ?jobs[args[0]]:Object.values(jobs).find(row=>row.id===args[0]);
   if(sql.startsWith('SELECT * FROM core_revisions'))return revisions[args[0]];
   if(sql.startsWith('SELECT * FROM core_shop_settings'))return currentSettings;
   throw new Error('unexpected Core query: '+sql);
  }
 };
 const service=new OrderService(store,()=>new Date(now));
 // This test isolates grant rechecks; candidate/source/evidence byte correctness
 // remains covered by the existing pilot source and PostgreSQL suites.
 service.pilotProvenance=async()=>proof;
 service.audit=async()=>{};
 return {service,jobs,scopeChecks,claimQueries,writes,setGrant:value=>{currentGrant=value;},setSettings:value=>{currentSettings=value;}};
}

const serverScope={shop_id:shopId,order_id:orderId,printer_id:printerId};

function gate(work){return {expected_revision:work.job.revision,lease_token:work.job.lease_token,
 request_hash:work.job.request_hash,source_sha256:work.candidate.source.sha256,
 settings_sha256:work.candidate.settings_sha256,evidence_sha256:work.authorization.evidence_sha256,
 printer_id:work.job.printer_id};}

test('pilot lane checks the same active owner grant at claim, preflight and mark-sending',async()=>{
 const f=fixture();
 const claimed=await f.service.claimPilot(agent,{printer_id:printerId,idempotency_key:'claim-a'},serverScope);
 assert.equal(claimed.work.job.mode,'controlled_test');
 assert.equal(claimed.work.job.order_id,orderId);
 assert.equal(claimed.work.job.printer_id,printerId);
 assert.equal(claimed.work.job.approval_id,undefined);
 const preflight=await f.service.preflightPilot(agent,claimed.work.job.job_id,gate(claimed.work));
 assert.equal(preflight.state,'AUTHORIZED');
 const sending=await f.service.markPilotSending(agent,claimed.work.job.job_id,gate(claimed.work));
 assert.equal(sending.state,'SENDING');
 assert.equal(f.jobs[orderId].mode_at_send,'controlled_test');
 assert.equal(f.scopeChecks.length,3);
 assert.deepEqual(f.writes,['claim','mark-sending']);
});

test('server-owned order scope wins when another order has a valid grant for the same shop and printer',async()=>{
 const f=fixture({additionalGrant:{...validGrant,order_id:otherOrderId}});
 const claimed=await f.service.claimPilot(agent,{printer_id:printerId,idempotency_key:'scoped-claim'},serverScope);
 assert.equal(claimed.work.job.order_id,orderId);
 assert.match(f.claimQueries[0].sql,/AND o\.id=\$4/);
 assert.equal(f.claimQueries[0].args[3],orderId);
});

test('controlled_test refuses Core claims without a server-owned order scope',async()=>{
 const f=fixture();
 await assert.rejects(f.service.claimPilot(agent,{printer_id:printerId,idempotency_key:'unscoped'}),
  error=>error.code==='CONTROLLED_PILOT_SCOPE_REQUIRED');
 assert.deepEqual(f.claimQueries,[]);
 assert.deepEqual(f.writes,[]);
});

test('server-owned controlled scope is rejected if the shop has returned to simulation',async()=>{
 const f=fixture({shopSettings:{...settings,mode:'simulation'}});
 await assert.rejects(f.service.claimPilot(agent,{printer_id:printerId,idempotency_key:'stale-mode'},serverScope),
  error=>error.code==='CONTROLLED_PILOT_MODE_REQUIRED');
 assert.deepEqual(f.claimQueries,[]);
 assert.deepEqual(f.writes,[]);
});

test('legacy generic report cannot bypass the pilot evidence report gate',async()=>{
 const f=fixture();
 f.service.validateJob=async()=>({o:order,j:{...f.jobs[orderId],state:'SENDING'}});
 await assert.rejects(f.service.report(agent,'job-a',{expected_revision:1,lease_token:'lease-a',
  result:'sent_unverified',evidence_kind:'spooler',idempotency_key:'legacy-pilot-report'}),
  error=>error.code==='PILOT_REPORT_REQUIRED');
 assert.deepEqual(f.writes,[]);
 assert.equal(f.jobs[orderId].state,'NOT_SENT');
});

test('pilot lane stops before the send boundary when the grant expires or is revoked after claim',async()=>{
 const f=fixture();
 const claimed=await f.service.claimPilot(agent,{printer_id:printerId,idempotency_key:'claim-a'},serverScope);
 f.setGrant({...validGrant,active:false});
 await assert.rejects(f.service.preflightPilot(agent,claimed.work.job.job_id,gate(claimed.work)),
  error=>error.code==='CONTROLLED_TEST_SCOPE_REQUIRED');
 f.setGrant(validGrant);
 await f.service.preflightPilot(agent,claimed.work.job.job_id,gate(claimed.work));
 f.setGrant({...validGrant,enabled:false});
 await assert.rejects(f.service.markPilotSending(agent,claimed.work.job.job_id,gate(claimed.work)),
  error=>error.code==='CONTROLLED_TEST_SCOPE_REQUIRED');
 assert.equal(f.jobs[orderId].state,'NOT_SENT');
 assert.deepEqual(f.writes,['claim']);
});

test('overlong or future-dated grant cannot enter the controlled pilot queue',async()=>{
 const f=fixture({grant:{...validGrant,duration_valid:false}});
 const claimed=await f.service.claimPilot(agent,{printer_id:printerId,idempotency_key:'claim-a'},serverScope);
 assert.equal(claimed.work,null);
 assert.deepEqual(f.writes,[]);
});

test('simulation remains the default lane and does not need a grant',async()=>{
 const f=fixture({grant:null,shopSettings:{...settings,mode:'simulation',printing_enabled:false}});
 const claimed=await f.service.claimPilot(agent,{printer_id:printerId,idempotency_key:'simulation'});
 assert.equal(claimed.work.job.mode,'simulation');
 assert.equal(f.scopeChecks.length,0);
 assert.deepEqual(f.writes,['claim']);
});
