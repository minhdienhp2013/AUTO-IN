const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const root=process.env.AI1_BUILD_DIR||path.resolve(__dirname,'../../../dist/backend');
const {registerCoreRoutes}=require(path.join(root,'api/routes.js'));
const {DomainError}=require(path.join(root,'core/model.js'));

const staff={id:'staff-a',shop_id:'shop-a',role:'staff',verified:true};
const agent={id:'agent-a',shop_id:'shop-a',role:'print_agent',verified:true,printer_ids:['RMP7000']};
const codeSubmission={schema:'ai0.pilot_code_submission.v1',shop_id:'shop-a',oa_id:'oa-a',customer_id:'customer-a',
 conversation_id:'chat-a',order_id:'order-a',revision:1,provider_event_id:'code-event-a',code:'AB23456789',
 idempotency_key:'idempotency-a'};
function setup(overrides={}){
 const routes=new Map(),calls=[];
 const app={get:(route,handler)=>routes.set('GET '+route,handler),post:(route,handler)=>routes.set('POST '+route,handler)};
 const dependencies={auth:{principal:async token=>{if(token==='staff-token')return staff;throw new DomainError('UNAUTHENTICATED','Unauthorized',401);}},
  service:{getPilotShopCode:async principal=>{calls.push(['display',principal]);return {schema:'ai0.pilot_shop_code_display.v1',
   shop_id:principal.shop_id,code:'AB23456789',expires_at:'2026-10-21T04:30:00.000Z',server_time:'2026-10-21T04:00:00.000Z'};},
   registerPilotCandidate:async value=>{calls.push(['candidate',value]);return {status:'WAITING_FOR_CODE',reason:'CODE_REQUIRED'};},
   authorizePilotPrint:async value=>{calls.push(['submission',value]);return {status:'WAITING_FOR_FILE',reason:'SOURCE_REQUIRED'};},
   claimPilot:async value=>{calls.push(['claim',value]);return {schema:'ai0.pilot_agent_claim.v1',work:{job:{job_id:'job-a',order_id:'order-a',
    revision:1,request_hash:'a'.repeat(64),printer_id:'RMP7000',lease_token:'lease-a',lease_seconds:90,mode:'simulation'},
    candidate:{shop_id:'shop-a'},authorization:{schema:'ai0.pilot_print_authorization.v1'}}};},
   getPilotJobSource:async(...args)=>{calls.push(['source',...args]);return {format:'PDF',sha256:'b'.repeat(64),size_bytes:3,bytes:Buffer.from('pdf')};},
   preflightPilot:async(...args)=>{calls.push(['preflight',...args]);return {schema:'ai0.pilot_agent_gate_receipt.v1',state:'AUTHORIZED'};},
   markPilotSending:async(...args)=>{calls.push(['mark-sending',...args]);return {schema:'ai0.pilot_agent_gate_receipt.v1',state:'SENDING'};},
   reportPilot:async(...args)=>{calls.push(['report',...args]);return {job_id:'job-a',state:'SIMULATED_DONE'};}},
  schedule:{},resolveVerifiedCustomer:async()=>staff,resolvePrintAgent:async()=>agent,
  resolvePilotCandidate:async()=>({trusted:'candidate'}),resolvePilotCodeSubmission:async()=>codeSubmission,...overrides};
 registerCoreRoutes(app,dependencies);
 const invoke=async(method,route,request={})=>{
  let status=200,payload,headers={};const reply={code(n){status=n;return this;},
   header(name,value){headers[name.toLowerCase()]=value;return this;},send(value){payload=value;return value;}};
  const value=await routes.get(method+' '+route)(request,reply);
  return {status,payload:payload??value,headers};
 };
 return {calls,invoke};
}

test('pilot shop-code display is scoped to authenticated staff session and no-store even on errors',async()=>{
 const {invoke}=setup();
 const ok=await invoke('GET','/api/v1/pilot/shop-code',{headers:{authorization:'Bearer staff-token'}});
 assert.equal(ok.status,200);assert.equal(ok.payload.shop_id,'shop-a');
 assert.equal(ok.headers['cache-control'],'no-store');
 const denied=await invoke('GET','/api/v1/pilot/shop-code',{headers:{}});
 assert.equal(denied.status,401);assert.equal(denied.payload.error.code,'UNAUTHENTICATED');
 assert.equal(denied.headers['cache-control'],'no-store');
});

test('pilot OA endpoints are internal, resolver-derived, no-store, and never echo raw code',async()=>{
 const {calls,invoke}=setup();
 const request={headers:{},body:{shop_id:'attacker',code:'not-trusted'}};
 const candidate=await invoke('POST','/internal/v1/pilot/candidates',request);
 assert.equal(candidate.status,200);assert.equal(candidate.payload.status,'WAITING_FOR_CODE');
 assert.equal(candidate.headers['cache-control'],'no-store');
 const response=await invoke('POST','/internal/v1/pilot/code-submissions',request);
 assert.equal(response.status,200);assert.equal(response.payload.status,'WAITING_FOR_FILE');
 assert.equal(response.headers['cache-control'],'no-store');
 assert.equal(JSON.stringify(response.payload).includes(codeSubmission.code),false);
 assert.deepEqual(calls.map(x=>x[0]),['candidate','submission']);
 assert.deepEqual(calls[0][1],{trusted:'candidate'});
 assert.deepEqual(calls[1][1],codeSubmission);
});

test('pilot internal route fails closed if trusted ingress resolver is absent',async()=>{
 const {invoke}=setup({resolvePilotCodeSubmission:undefined});
 const response=await invoke('POST','/internal/v1/pilot/code-submissions',{headers:{},body:codeSubmission});
 assert.equal(response.status,503);assert.equal(response.payload.error.code,'PILOT_INGRESS_UNAVAILABLE');
 assert.equal(response.headers['cache-control'],'no-store');
});

test('pilot Agent uses separate claim/source/gate/report paths with no approval field and no-store source bytes',async()=>{
 const {calls,invoke}=setup();
 const claimed=await invoke('POST','/internal/v1/pilot/print-jobs/claim',{headers:{},body:{printer_id:'RMP7000',idempotency_key:'claim-a'}});
 assert.equal(claimed.payload.schema,'ai0.pilot_agent_claim.v1');
 assert.equal(claimed.payload.work.job.approval_id,undefined);
 assert.equal(claimed.payload.work.job.lease_token,'lease-a');
 assert.equal(claimed.headers['cache-control'],'no-store');
 const source=await invoke('GET','/internal/v1/pilot/print-jobs/:job_id/source',
  {headers:{'x-auto-in-pilot-lease':'lease-a'},params:{job_id:'job-a'}});
 assert.equal(source.payload.toString(),'pdf');
 assert.equal(source.headers['cache-control'],'no-store');
 assert.equal(source.headers['content-type'],'application/pdf');
 assert.equal(source.headers['x-auto-in-source-sha256'],'b'.repeat(64));
 assert.equal(source.headers['x-auto-in-source-size'],'3');
 assert.deepEqual(calls.find(x=>x[0]==='source'),['source',agent,'job-a','lease-a']);
 const tuple={expected_revision:1,lease_token:'lease-a',request_hash:'a'.repeat(64),source_sha256:'b'.repeat(64),
  settings_sha256:'c'.repeat(64),evidence_sha256:'d'.repeat(64),printer_id:'RMP7000'};
 const preflight=await invoke('POST','/internal/v1/pilot/print-jobs/:job_id/preflight',
  {headers:{},params:{job_id:'job-a'},body:tuple});
 assert.equal(preflight.payload.schema,'ai0.pilot_agent_gate_receipt.v1');
 assert.equal(preflight.payload.state,'AUTHORIZED');
 const sending=await invoke('POST','/internal/v1/pilot/print-jobs/:job_id/mark-sending',
  {headers:{},params:{job_id:'job-a'},body:tuple});
 assert.equal(sending.payload.state,'SENDING');
 const reportBody={schema:'ai0.pilot_agent_report.v1',lease_token:'lease-a',idempotency_key:'report-a',
  state:'SIMULATED_DONE',evidence:{driver_called:false}};
 const reported=await invoke('POST','/internal/v1/pilot/print-jobs/:job_id/reports',
  {headers:{},params:{job_id:'job-a'},body:reportBody});
 assert.equal(reported.payload.state,'SIMULATED_DONE');
 assert.deepEqual(calls.filter(x=>['claim','preflight','mark-sending','report'].includes(x[0])).map(x=>x[0]),
  ['claim','preflight','mark-sending','report']);
});
