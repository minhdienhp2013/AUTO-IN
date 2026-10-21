import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {asSqlPool,assertIsolatedSimulationDatabase} from '../../../backend/composition/postgres.ts';
import {buildIntegratedApp} from '../../../backend/composition/runtime.ts';
import {createSyntheticZaloIngress} from '../../../backend/composition/zalo-simulation.ts';
import {createCoreModule} from '../../../backend/core/factory.ts';
import {createTrustedPrintEvidencePort} from '../../../backend/composition/trusted-print-evidence.ts';
import {createPilotPrivateSourcePorts} from '../../../backend/composition/pilot-private-source.ts';
import {createPilotIngressResolvers} from '../../../backend/composition/pilot-ingress.ts';
import {createPilotWordPdfIntakeAdapter} from '../../../backend/conversation/pilot-word-pdf-intake.ts';

const databaseUrl=process.env.TEST_DATABASE_URL;
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const id=()=>randomUUID().replaceAll('-','');
const safe=value=>typeof value==='string'&&/^[A-Z][A-Z0-9_]{1,48}$/.test(value)?value:'NA';
function runAgent(url,token,journal){
 return new Promise((resolve,reject)=>{
  const child=spawn(process.env.PYTHON??'python3',['-m','agents.windows.pilot_cli',
   '--api-base-url',url,'--journal',journal],{cwd:root,env:{...process.env,
   PYTHONPATH:root,AUTO_IN_AGENT_TOKEN:token},stdio:['ignore','pipe','ignore']});
  let output='';const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('PILOT_AGENT_TIMEOUT'));},30_000);
  child.stdout.setEncoding('utf8');child.stdout.on('data',part=>{output+=part;if(output.length>8192)child.kill('SIGKILL');});
  child.on('error',()=>{clearTimeout(timer);reject(new Error('PILOT_AGENT_UNAVAILABLE'));});
  child.on('close',code=>{clearTimeout(timer);try{
   const result=JSON.parse(output);
   if(code!==0){const error=new Error('PILOT_AGENT_FAILED');error.pilotReason=safe(result?.result?.reason);reject(error);}
   else resolve(result);
  }catch{reject(new Error('PILOT_AGENT_RESULT_INVALID'));}});
 });
}
for(const format of ['DOCX','PDF'])test(`verified synthetic OA ${format} -> durable custody/binder -> Core -> Agent HTTP DryRun`,
 {skip:databaseUrl?false:'isolated TEST_DATABASE_URL absent',timeout:120_000},async t=>{
 assertIsolatedSimulationDatabase(databaseUrl);
 const pool=new pg.Pool({connectionString:databaseUrl,max:5,connectionTimeoutMillis:5000});
 const sql=asSqlPool(pool),suffix=id(),shop=`pilot-${suffix}`,oa=`oa-${suffix}`;
 const customer=`customer-${suffix}`,conversation=`conversation-${suffix}`;
 const fileEvent=`file-${suffix}`,settingsEvent=`settings-${suffix}`,codeEvent=`code-${suffix}`;
 const printer='RMP7000',agentId=`agent-${suffix}`,agentToken=`agent-${id()}-${id()}`;
 const ai2Token=`ai2-${id()}-${id()}`,fixtureKey=`fixture-${id()}-${id()}`;
 const password=`owner-${id()}`,hmacKey=Buffer.from(`test-hmac-${id()}-${id()}`);
 const extension=format==='DOCX'?'docx':'pdf';
 const sourceBytes=await fs.readFile(path.join(root,`tests/unit/printing/fixtures/pilot-word-pdf/public-one-page.${extension}`));
 const sourceHash=sha(sourceBytes);
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'autoin-private-pilot-'));
 await fs.chmod(temp,0o700);
 let app,orderId,bootstrapped=false,stage='bootstrap',status='NA',reason='NA';
 let reportEvidence=null;
 const observe=(name,response)=>{stage=name;status=String(response.statusCode);
  try{reason=safe(response.json()?.error?.code);}catch{reason='NA';}return response;};
 try{
  const ports=createPilotPrivateSourcePorts(sql,path.join(temp,'private'));
  const ingress=createPilotIngressResolvers(sql,ai2Token,ports.binding,
   input=>ports.custody.read_sealed(input));
  const evidence={artifactRoot:path.join(temp,'evidence'),
   printerCapabilities:{simulation_only:true,printer_id:printer,queue_name:printer}};
  const core=createCoreModule({pool:sql,mode:'v1',pilotCodeHmacKey:hmacKey,
   evidence:createTrustedPrintEvidencePort(evidence),wordSource:ports.wordSource,pdfSource:ports.pdfSource});
  await core.auth.bootstrapOwner({shop_id:shop,username:'owner',password,bootstrap_enabled:true});
  bootstrapped=true;
  await pool.query("UPDATE core_shop_settings SET mode='simulation',printing_enabled=false,open_at='00:00',close_at='24:00',timezone='Asia/Ho_Chi_Minh',holiday_dates='{}' WHERE shop_id=$1",[shop]);
  await pool.query('INSERT INTO core_shop_zalo_oa_registry(shop_id,oa_id,app_id) VALUES($1,$2,$3)',[shop,oa,`app-${suffix}`]);
  await pool.query('INSERT INTO core_pilot_shop_config(shop_id,printer_id,agent_id,enabled,allow_real_print,tested_at) VALUES($1,$2,$3,true,false,clock_timestamp())',[shop,printer,agentId]);
  const owner=await core.auth.login(shop,'owner',password);
  app=buildIntegratedApp({pool:sql,zaloWebhook:createSyntheticZaloIngress(pool,{kind:'synthetic_fixture',shop_id:shop,oa_id:oa,fixture_key:fixtureKey}),
   identities:[{token:agentToken,principal:{id:agentId,shop_id:shop,role:'print_agent',verified:true,printer_ids:[printer]}}],
   trustedPrintEvidence:evidence,pilotWordPdf:{hmacKey,wordSource:ports.wordSource,pdfSource:ports.pdfSource,...ingress}});
  app.addHook('preHandler',async request=>{
   if(/^\/internal\/v1\/pilot\/print-jobs\/[^/]+\/reports$/.test(request.url)){
    const value=request.body?.evidence;
    reportEvidence={driver_called:value?.driver_called,spooler_ack:value?.spooler_ack};
   }
  });
  await app.ready();
  const send=async(name,event)=>{
   const response=observe(name,await app.inject({method:'POST',url:'/webhooks/zalo',
    headers:{'content-type':'application/json','x-test-fixture-key':fixtureKey},payload:JSON.stringify({
     synthetic_fixture:true,oa_id:oa,customer_id:customer,conversation_id:conversation,
     occurred_at:new Date().toISOString(),...event})}));
   assert.equal(response.statusCode,200);assert.equal(response.json().status,'accepted');
  };
  await send('oa-file',{event_id:fileEvent,kind:'file',file_ref:`media-${suffix}`,
   filename:`public-one-page.${extension}`,mime_type:format==='DOCX'?
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document':'application/pdf'});
  stage='source-seal';
  const source=await ports.custody.seal({oa_id:oa,customer_id:customer,conversation_id:conversation,
   provider_event_id:fileEvent,format,bytes:new Uint8Array(sourceBytes),
   sha256:sourceHash,size_bytes:sourceBytes.length});
  assert.equal(source.sha256,sourceHash);
  assert.deepEqual(Buffer.from(await ports.custody.read_sealed({oa_id:oa,provider_event_id:fileEvent,
   artifact_ref:source.artifact_ref})),sourceBytes);
  const requestData={documents:[{artifact_name:source.artifact_ref,copies:2,duplex:true,paper:'A4'}]};
  const draft=await core.service.createDraft(owner.principal,{customer_id:customer,
   conversation_id:conversation,request_data:requestData,idempotency_key:`pilot-${extension}-${suffix}`});
  orderId=draft.order_id;
  const order=(await pool.query('SELECT active_revision,shop_id,customer_id,conversation_id FROM core_orders WHERE id=$1',[orderId])).rows[0];
  assert.deepEqual({revision:order.active_revision,shop:order.shop_id,customer:order.customer_id,
   conversation:order.conversation_id},{revision:draft.revision,shop,customer,conversation});
  const plan={request_hash:draft.request_hash,physical_sheets:2,document_pages:1,printed_faces:2,
   ready:true,printer_id:printer,artifact_ref:source.artifact_ref,verified_by:`pilot-${extension}-test`};
  await pool.query('UPDATE core_revisions SET plan=$3::jsonb WHERE order_id=$1 AND revision=$2',
   [orderId,draft.revision,JSON.stringify(plan)]);
  const boundRevision=(await pool.query('SELECT request_hash,request_data,plan FROM core_revisions WHERE order_id=$1 AND revision=$2',
   [orderId,draft.revision])).rows[0];
  assert.equal(boundRevision.request_hash,draft.request_hash);
  assert.deepEqual(boundRevision.request_data,requestData);
  assert.deepEqual(boundRevision.plan,plan);
  await send('oa-settings',{event_id:settingsEvent,kind:'text',text:'In 2 bản A4, 2 mặt, đen trắng.'});
  const display=observe('shop-code',await app.inject({method:'GET',url:'/api/v1/pilot/shop-code',
   headers:{authorization:`Bearer ${owner.token}`}}));
  assert.equal(display.statusCode,200);
  const code=display.json().code;
  await send('oa-code',{event_id:codeEvent,kind:'text',text:`Mã cửa hàng: ${code}`});
  const intake=createPilotWordPdfIntakeAdapter({trusted_shop_id:shop,trusted_oa_id:oa,ports:{
   async read_verified_events({event_ids}){
    const rows=(await pool.query('SELECT event_id,payload_json FROM zalo_inbound_events WHERE oa_id=$1 AND event_id=ANY($2::text[])',[oa,event_ids])).rows;
    return event_ids.map(event=>rows.find(row=>row.event_id===event)?.payload_json).filter(Boolean);
   },
   media:{async read_verified(input){return input.oa_id===oa&&input.provider_event_id===fileEvent?
    {oa_id:oa,customer_id:customer,conversation_id:conversation,provider_event_id:fileEvent,
     bytes:new Uint8Array(sourceBytes)}:null;}},
   custody:ports.custody,candidate_binding:ports.binding,
   core:{
    async registerPilotCandidate(){
     const response=observe('register',await app.inject({method:'POST',url:'/internal/v1/pilot/candidates',
      headers:{authorization:`Bearer ${ai2Token}`},payload:{oa_id:oa,source_event_id:fileEvent}}));
     assert.equal(response.statusCode,200);return response.json();
    },
    async authorizePilotPrint(){
     const response=observe('authorize',await app.inject({method:'POST',url:'/internal/v1/pilot/code-submissions',
      headers:{authorization:`Bearer ${ai2Token}`},payload:{oa_id:oa,provider_event_id:codeEvent}}));
     assert.equal(response.statusCode,200);return response.json();
    }
   }
  }});
  stage='intake';
  const intakeResult=await intake.processVerifiedEvents({event_ids:[fileEvent,settingsEvent,codeEvent],source_event_id:fileEvent});
  assert.equal(intakeResult.status,'AUTHORIZED');
  const stored=(await pool.query('SELECT c.order_id,c.revision,c.request_hash,c.source_artifact_ref,c.source_format,c.source_sha256,c.source_size_bytes,c.source_event_id,c.settings,c.settings_sha256,c.manifest_sha256,a.provider_event_id FROM core_pilot_candidates c JOIN core_pilot_print_authorizations a ON a.candidate_id=c.id WHERE c.order_id=$1',[orderId])).rows;
  assert.equal(stored.length,1);assert.equal(stored[0].source_format,format);
  assert.equal(stored[0].order_id,orderId);assert.equal(stored[0].revision,draft.revision);
  assert.equal(stored[0].request_hash,draft.request_hash);
  assert.equal(stored[0].source_artifact_ref,source.artifact_ref);
  assert.equal(stored[0].source_sha256,sourceHash);assert.equal(stored[0].source_event_id,fileEvent);
  assert.equal(Number(stored[0].source_size_bytes),sourceBytes.length);
  assert.deepEqual(stored[0].settings,{copies:2,duplex:true,paper:'A4',color:'black_white'});
  assert.equal(stored[0].provider_event_id,codeEvent);
  assert.match(stored[0].settings_sha256,/^[a-f0-9]{64}$/);
  assert.match(stored[0].manifest_sha256,/^[a-f0-9]{64}$/);
  const url=await app.listen({host:'127.0.0.1',port:0});
  stage='agent-dryrun';
  const agent=await runAgent(url,agentToken,path.join(temp,'journal.sqlite'));
  assert.equal(agent.mode,'simulation');assert.equal(agent.driver_called,false);
  assert.equal(agent.result.status,'SIMULATED_DONE');assert.equal(agent.result.driver_called,false);
  assert.equal(reportEvidence?.driver_called,false);
  assert.equal(reportEvidence?.spooler_ack,false);
  assert.equal(JSON.stringify(agent).includes(code),false);
  const jobs=(await pool.query('SELECT id,state,pilot_authorization_id,approval_id,evidence_kind FROM core_print_jobs WHERE order_id=$1',[orderId])).rows;
  assert.equal(jobs.length,1);assert.equal(jobs[0].state,'SIMULATED_DONE');
  assert.ok(jobs[0].pilot_authorization_id);assert.equal(jobs[0].approval_id,null);
  assert.equal(jobs[0].evidence_kind,'simulated');
 }catch(error){t.diagnostic(`PILOT_PRIVATE_SOURCE_DIAG format=${format} stage=${stage} status=${status} reason=${reason} agent_reason=${safe(error?.pilotReason)}`);throw error;}
 finally{
  if(app)await app.close().catch(()=>{});
  if(bootstrapped){
   for(const [query,values] of [
    ['DELETE FROM core_print_jobs WHERE order_id=$1',[orderId]],
    ['DELETE FROM core_pilot_print_authorizations WHERE order_id=$1',[orderId]],
    ['DELETE FROM core_pilot_code_attempts WHERE order_id=$1',[orderId]],
    ['DELETE FROM core_pilot_candidates WHERE order_id=$1',[orderId]],
    ['DELETE FROM core_audit WHERE shop_id=$1',[shop]],
    ['DELETE FROM core_order_inbound_reviews WHERE shop_id=$1',[shop]],
    ['DELETE FROM core_revisions WHERE order_id=$1',[orderId]],
    ['DELETE FROM core_orders WHERE shop_id=$1',[shop]],
    ['DELETE FROM core_idempotency WHERE shop_id=$1',[shop]],
    ['DELETE FROM core_conversation_controls WHERE shop_id=$1 AND conversation_id=$2',[shop,conversation]],
    ['DELETE FROM core_pilot_shop_code_windows WHERE shop_id=$1',[shop]],
    ['DELETE FROM core_pilot_shop_config WHERE shop_id=$1',[shop]],
    ['DELETE FROM ai0_pilot_private_sources WHERE shop_id=$1',[shop]],
    ['DELETE FROM core_shop_zalo_oa_registry WHERE shop_id=$1',[shop]],
    ['DELETE FROM zalo_process_queue WHERE oa_id=$1',[oa]],
    ['DELETE FROM zalo_inbound_events WHERE oa_id=$1',[oa]],
    ['DELETE FROM core_sessions WHERE user_id IN (SELECT id FROM core_users WHERE shop_id=$1)',[shop]],
    ['DELETE FROM core_users WHERE shop_id=$1',[shop]],
    ['DELETE FROM core_shop_settings WHERE shop_id=$1',[shop]]
   ])await pool.query(query,values).catch(()=>{});
  }
  await pool.end();await fs.rm(temp,{recursive:true,force:true}).catch(()=>{});
 }
});
