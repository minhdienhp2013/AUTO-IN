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
import {createPilotWordPdfIntakeAdapter} from '../../../backend/conversation/pilot-word-pdf-intake.ts';
import {pilotSettingsHash} from '../../../backend/core/pilot-shop-code.ts';

const databaseUrl=process.env.TEST_DATABASE_URL;
const skip=!databaseUrl?'TEST_DATABASE_URL unset: isolated OA-to-Core-to-Agent pilot NOT RUN':false;
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const codeKey=Buffer.from('synthetic-only-pilot-HMAC-secret-key-32-bytes-minimum');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const uid=()=>randomUUID();
const stable=value=>Array.isArray(value)?value.map(stable):
 value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;

function runDryRun({apiBaseUrl,agentToken,journalPath}){
 return new Promise((resolve,reject)=>{
  const child=spawn(process.env.PYTHON??'python3',['-m','agents.windows.pilot_cli',
   '--api-base-url',apiBaseUrl,'--journal',journalPath],{
   cwd:root,env:{...process.env,PYTHONPATH:[root,process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
    AUTO_IN_AGENT_TOKEN:agentToken},stdio:['ignore','pipe','pipe']
  });
  let stdout='',settled=false;
  const timer=setTimeout(()=>{
   if(!settled){settled=true;child.kill('SIGKILL');reject(new Error('PILOT_DRYRUN_TIMEOUT'));}
  },30_000);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.length>8192){child.kill('SIGKILL');}});
  child.stderr.resume();
  child.once('error',()=>{
   if(settled)return;settled=true;clearTimeout(timer);reject(new Error('PILOT_DRYRUN_PROCESS_UNAVAILABLE'));
  });
  child.once('close',code=>{
   if(settled)return;settled=true;clearTimeout(timer);
   if(code!==0){reject(new Error('PILOT_DRYRUN_EXIT_FAILED'));return;}
   try{resolve(JSON.parse(stdout));}catch{reject(new Error('PILOT_DRYRUN_RESULT_INVALID'));}
  });
 });
}

test('synthetic OA file/settings/code -> Core pilot job -> Agent HTTP DryRun stays simulation-only',
 {skip,timeout:120_000},async t=>{
  // Guard before constructing a pool: only an explicitly named loopback test DB is eligible.
  assertIsolatedSimulationDatabase(databaseUrl);
  const pool=new pg.Pool({connectionString:databaseUrl,max:5,connectionTimeoutMillis:5000});
  const sql=asSqlPool(pool),suffix=uid().replaceAll('-','');
  const shop=`pilot-${suffix}`,oa=`oa-${suffix}`,appId=`app-${suffix}`;
  const customer=`customer-${suffix}`,conversation=`conversation-${suffix}`;
  const password=`isolated-${uid()}-owner-password`;
  const fixtureKey=`synthetic-${uid()}-${uid()}`;
  const agentToken=`synthetic-agent-${uid()}-${uid()}`;
  const ai2Token=`synthetic-ai2-${uid()}-${uid()}`;
  const agentId=`agent-${suffix}`,printerId='RMP7000';
  const fileEvent=`file-${suffix}`,settingsEvent=`settings-${suffix}`,codeEvent=`code-${suffix}`;
  const sourceBytes=await fs.readFile(path.join(root,'tests/unit/printing/fixtures/pilot-word-pdf/public-one-page.pdf'));
  const sourceHash=sha(sourceBytes),bundle=`doc-${suffix}`;
  const sourceRef=`${bundle}/source-000-${sourceHash}.pdf`;
  const manifestRef=`${bundle}/pilot-review-1.json`;
  const requestData={documents:[{artifact_name:sourceRef,copies:2,duplex:true,paper:'A4'}]};
  const trusted={shop_id:shop,oa_id:oa};
  const hmacKey=codeKey;
  const sealed=new Map();
  let currentCandidate=null,currentSubmission=null,orderId=null,app=null,serverUrl=null;
  let tempRoot=null,journalPath=null,bootstrapped=false;
  let stage='bootstrap',lastStatus='NA',lastReason='NA';
  const safe=value=>typeof value==='number'&&Number.isInteger(value)?String(value):
   typeof value==='string'&&/^[A-Z][A-Z0-9_]{1,40}$/.test(value)?value:'NA';
  const observe=(name,response)=>{
   stage=name;lastStatus=safe(response.statusCode);
   try{const body=response.json();lastReason=safe(body?.error?.code??body?.reason??body?.status);}catch{lastReason='NA';}
   return response;
  };
  const evidenceOptions={artifactRoot:path.join(os.tmpdir(),'unused-pilot-runtime-evidence-root'),
   printerCapabilities:{simulation_only:true,printer_id:printerId,queue_name:printerId}};
  const evidence=createTrustedPrintEvidencePort(evidenceOptions);
  const pdfSource={async read_registered(_db,scope){
   const bytes=sealed.get(fileEvent);if(!bytes)return null;
   const manifestBytes=Buffer.from(JSON.stringify({schema:'ai0.pdf_review_manifest.v1',
    manifest_ref:manifestRef,shop_id:scope.shop_id,order_id:scope.order_id,
    active_revision:scope.active_revision,request_hash:scope.request_hash,
    source:{format:'PDF',artifact_ref:sourceRef,sha256:sourceHash,size_bytes:bytes.length}}));
   return {source:{artifact_ref:sourceRef,bytes:new Uint8Array(bytes)},
    manifest:{ref:manifestRef,bytes:manifestBytes},provider_event_id:fileEvent};
  }};
  const core=createCoreModule({pool:sql,mode:'v1',pilotCodeHmacKey:hmacKey,evidence,pdfSource});
  try{
   await core.auth.bootstrapOwner({shop_id:shop,username:'owner',password,bootstrap_enabled:true});
   bootstrapped=true;
   await pool.query("UPDATE core_shop_settings SET mode='simulation',printing_enabled=false,open_at='00:00',close_at='24:00',timezone='Asia/Ho_Chi_Minh',holiday_dates='{}' WHERE shop_id=$1",[shop]);
   await pool.query('INSERT INTO core_shop_zalo_oa_registry(shop_id,oa_id,app_id) VALUES($1,$2,$3)',[shop,oa,appId]);
   await pool.query('INSERT INTO core_pilot_shop_config(shop_id,printer_id,agent_id,enabled,allow_real_print,tested_at) '+
    'VALUES($1,$2,$3,true,false,clock_timestamp())',[shop,printerId,agentId]);

   const ownerLogin=await core.auth.login(shop,'owner',password);
   const draft=await core.service.createDraft(ownerLogin.principal,{customer_id:customer,conversation_id:conversation,
    request_data:requestData,idempotency_key:`pilot-draft-${suffix}`});
   orderId=draft.order_id;
   // This test-only pre-binding is explicit: the live Core order/source/plan binder is not implemented yet.
   const plan={request_hash:draft.request_hash,physical_sheets:2,document_pages:1,printed_faces:2,
    ready:true,printer_id:printerId,artifact_ref:sourceRef,verified_by:`synthetic-test-only-${suffix}`};
   await pool.query('UPDATE core_revisions SET plan=$3::jsonb WHERE order_id=$1 AND revision=$2',
    [orderId,draft.revision,JSON.stringify(plan)]);

   const sameJson=(a,b)=>JSON.stringify(stable(a))===JSON.stringify(stable(b));
   const assertServiceRequest=(request,expected)=>{
    if(request.headers.authorization!==`Bearer ${ai2Token}`||!sameJson(request.body,expected))
     throw new Error('SYNTHETIC_AI2_SERVICE_SCOPE_REJECTED');
   };
   const webhook=createSyntheticZaloIngress(pool,{kind:'synthetic_fixture',...trusted,fixture_key:fixtureKey});
   app=buildIntegratedApp({pool:sql,zaloWebhook:webhook,
    identities:[{token:agentToken,principal:{id:agentId,shop_id:shop,role:'print_agent',verified:true,
     printer_ids:[printerId]}}],
    trustedPrintEvidence:evidenceOptions,
    pilotWordPdf:{hmacKey,pdfSource,
     resolveCandidate:async request=>{assertServiceRequest(request,currentCandidate);return currentCandidate;},
     resolveCodeSubmission:async request=>{assertServiceRequest(request,currentSubmission);return currentSubmission;}}
   });
   await app.ready();
   const sendEvent=async(name,event)=>{
    stage=name;
    const response=observe(name,await app.inject({method:'POST',url:'/webhooks/zalo',
     headers:{'content-type':'application/json','x-test-fixture-key':fixtureKey},payload:JSON.stringify(event)}));
    assert.equal(response.statusCode,200);
    assert.equal(response.json().status,'accepted');
   };
   const baseEvent={synthetic_fixture:true,oa_id:oa,customer_id:customer,conversation_id:conversation,
    occurred_at:new Date().toISOString()};
   await sendEvent('oa-file',{...baseEvent,event_id:fileEvent,kind:'file',file_ref:`media-${suffix}`,
    filename:'public-one-page.pdf',mime_type:'application/pdf'});
   await sendEvent('oa-settings',{...baseEvent,event_id:settingsEvent,kind:'text',text:'In 2 bản A4, 2 mặt, đen trắng.'});

   stage='shop-code';
   const displayResponse=observe('shop-code',await app.inject({method:'GET',url:'/api/v1/pilot/shop-code',
    headers:{authorization:`Bearer ${ownerLogin.token}`}}));
   assert.equal(displayResponse.statusCode,200);
   assert.equal(displayResponse.headers['cache-control'],'no-store');
   const display=displayResponse.json();
   assert.ok(/^[0-9A-HJKMNP-TV-Z]{10}$/.test(display.code),'server shop code follows the locked wire format');
   await sendEvent('oa-code',{...baseEvent,event_id:codeEvent,kind:'text',text:`Mã cửa hàng: ${display.code}`});

   const intake=createPilotWordPdfIntakeAdapter({trusted_shop_id:shop,trusted_oa_id:oa,ports:{
    async read_verified_events({event_ids}){
     const rows=(await pool.query('SELECT event_id,payload_json FROM zalo_inbound_events WHERE oa_id=$1 AND event_id=ANY($2::text[])',
      [oa,event_ids])).rows;
     return event_ids.map(id=>rows.find(row=>row.event_id===id)?.payload_json).filter(Boolean);
    },
    media:{async read_verified(input){
     if(input.oa_id!==oa||input.provider_event_id!==fileEvent)return null;
     return {oa_id:oa,customer_id:customer,conversation_id:conversation,provider_event_id:fileEvent,
      bytes:new Uint8Array(sourceBytes)};
    }},
    custody:{
     async seal(input){
      if(input.provider_event_id!==fileEvent||input.sha256!==sourceHash||!Buffer.from(input.bytes).equals(sourceBytes))
       throw new Error('SYNTHETIC_SOURCE_BINDING_REJECTED');
      const prior=sealed.get(input.provider_event_id);
      if(prior&&!Buffer.from(prior).equals(Buffer.from(input.bytes)))throw new Error('SEALED_SOURCE_REPLACEMENT_REJECTED');
      sealed.set(input.provider_event_id,new Uint8Array(input.bytes));
      return {schema:'ai0.pilot_sealed_source.v1',...trusted,customer_id:customer,conversation_id:conversation,
       provider_event_id:fileEvent,format:'PDF',artifact_ref:sourceRef,sha256:sourceHash,size_bytes:sourceBytes.length};
     },
     async read_sealed(input){
      const value=sealed.get(input.provider_event_id);
      return value&&input.oa_id===oa&&input.artifact_ref===sourceRef?new Uint8Array(value):null;
     }
    },
    candidate_binding:{async bind(input){
     if(input.shop_id!==shop||input.oa_id!==oa||input.customer_id!==customer||input.conversation_id!==conversation||
       input.source.artifact_ref!==sourceRef||input.source.sha256!==sourceHash||input.source.provider_event_id!==fileEvent||
       input.settings.copies!==2||input.settings.duplex!==true||input.settings.paper!=='A4'||
       input.settings.color!=='black_white')return null;
     currentCandidate={shop_id:shop,oa_id:oa,customer_id:customer,conversation_id:conversation,
      order_id:draft.order_id,revision:draft.revision,request_hash:draft.request_hash,
      source:{format:'PDF',artifact_ref:sourceRef,sha256:sourceHash,size_bytes:sourceBytes.length,provider_event_id:fileEvent},
      settings:input.settings,settings_sha256:pilotSettingsHash(input.settings),printer_id:printerId};
     return currentCandidate;
    }},
    core:{
     async registerPilotCandidate(candidate){
      currentCandidate=candidate;
      stage='register-candidate';
      const response=observe('register-candidate',await app.inject({method:'POST',url:'/internal/v1/pilot/candidates',
       headers:{authorization:`Bearer ${ai2Token}`},payload:candidate}));
      assert.equal(response.statusCode,200);
      return response.json();
     },
     async authorizePilotPrint(submission){
      currentSubmission={...submission,idempotency_key:`caller-controlled-${suffix}`};
      stage='authorize-code';
      const response=observe('authorize-code',await app.inject({method:'POST',url:'/internal/v1/pilot/code-submissions',
       headers:{authorization:`Bearer ${ai2Token}`},payload:currentSubmission}));
      assert.equal(response.statusCode,200);
      return response.json();
     }
    }
   }});
   stage='process-intake';
   const intakeResult=await intake.processVerifiedEvents({event_ids:[fileEvent,settingsEvent,codeEvent],source_event_id:fileEvent});
   stage='intake-result';lastStatus=safe(intakeResult.status);lastReason=safe(intakeResult.reason);
   assert.equal(intakeResult.status,'AUTHORIZED');
   assert.equal(intakeResult.candidate_registered,true);
   assert.equal(intakeResult.authorization_attempted,true);
   stage='verify-provenance';
   const replayKeys=(await pool.query('SELECT ca.idempotency_key AS attempt_key,a.idempotency_key AS authorization_key '+
    'FROM core_pilot_code_attempts ca JOIN core_pilot_print_authorizations a '+
    'ON a.shop_id=ca.shop_id AND a.oa_id=ca.oa_id AND a.provider_event_id=ca.provider_event_id '+
    'WHERE ca.order_id=$1',[orderId])).rows;
   assert.equal(replayKeys.length,1);
   assert.equal(replayKeys[0].attempt_key,replayKeys[0].authorization_key);
   assert.match(replayKeys[0].attempt_key,/^core-pilot:[0-9a-f]{64}$/);
   assert.notEqual(replayKeys[0].attempt_key,currentSubmission.idempotency_key);
   const eventBinding=(await pool.query('SELECT c.source_event_id,a.provider_event_id '+
    'FROM core_pilot_candidates c JOIN core_pilot_print_authorizations a ON a.candidate_id=c.id '+
    'WHERE c.order_id=$1',[orderId])).rows;
   assert.equal(eventBinding.length,1);
   assert.equal(eventBinding[0].source_event_id,fileEvent);
   assert.equal(eventBinding[0].provider_event_id,codeEvent);
   assert.notEqual(eventBinding[0].source_event_id,eventBinding[0].provider_event_id);
   const storedPilotData={
    candidateAuthorizationJob:(await pool.query('SELECT to_jsonb(c) AS candidate,to_jsonb(a) AS authorization,'+
     'to_jsonb(j) AS job FROM core_pilot_candidates c JOIN core_pilot_print_authorizations a ON a.candidate_id=c.id '+
     'JOIN core_print_jobs j ON j.pilot_authorization_id=a.id WHERE c.order_id=$1',[orderId])).rows,
    attempts:(await pool.query('SELECT * FROM core_pilot_code_attempts WHERE order_id=$1',[orderId])).rows,
    audit:(await pool.query('SELECT action,details FROM core_audit WHERE shop_id=$1',[shop])).rows
   };
   assert.equal(JSON.stringify(storedPilotData).includes(display.code),false,
    'raw shop code must not persist in candidate, authorization, job, attempt, or audit rows');

   for(const headers of [{},{authorization:`Bearer ${'X'.repeat(32)}`}]){
    const denied=await app.inject({method:'POST',url:'/internal/v1/pilot/print-jobs/claim',headers,
     payload:{printer_id:printerId,idempotency_key:`denied-${suffix}-${headers.authorization?'wrong':'missing'}`}});
    assert.equal(denied.statusCode,401);
   }
   stage='legacy-claim';
   const legacyClaim=observe('legacy-claim',await app.inject({method:'POST',url:'/internal/v1/print-jobs/claim',
    headers:{authorization:`Bearer ${agentToken}`},payload:{printer_id:printerId,idempotency_key:`legacy-${suffix}`}}));
   assert.equal(legacyClaim.statusCode,200);
   assert.equal(legacyClaim.json().job,null,'legacy claim must not see the pilot authorization job');
   assert.equal((await pool.query('SELECT claimed_by FROM core_print_jobs WHERE order_id=$1',[orderId])).rows[0].claimed_by,null);

   // Exercise AI3's real loopback HTTP client against Core routes, in simulation DryRun only.
   tempRoot=await fs.mkdtemp(path.join(os.tmpdir(),'autoin-pilot-dryrun-'));
   await fs.chmod(tempRoot,0o700);
   journalPath=path.join(tempRoot,'pilot.sqlite');
   serverUrl=await app.listen({host:'127.0.0.1',port:0});
   stage='agent-dryrun';
   const agentResult=await runDryRun({apiBaseUrl:serverUrl,agentToken,journalPath});
   stage='agent-result';lastStatus=safe(agentResult.result?.status);lastReason=safe(agentResult.result?.reason);
   assert.equal(agentResult.mode,'simulation');
   assert.equal(agentResult.driver_called,false);
   assert.equal(agentResult.result.status,'SIMULATED_DONE');
   assert.equal(agentResult.result.driver_called,false);
   assert.equal(JSON.stringify(agentResult).includes(display.code),false);

   const jobs=(await pool.query('SELECT j.id,j.state,j.approval_id,j.pilot_authorization_id,j.mode_at_send '+
    'FROM core_print_jobs j WHERE j.order_id=$1',[orderId])).rows;
   assert.equal(jobs.length,1);
   assert.equal(jobs[0].state,'SIMULATED_DONE');
   assert.equal(jobs[0].approval_id,null);
   assert.ok(jobs[0].pilot_authorization_id);
   assert.equal(jobs[0].mode_at_send,'simulation');
   for(const lease of ['',`wrong-${suffix}`]){
    const headers={authorization:`Bearer ${agentToken}`};
    if(lease)headers['x-auto-in-pilot-lease']=lease;
    const denied=await app.inject({method:'GET',url:`/internal/v1/pilot/print-jobs/${jobs[0].id}/source`,headers});
    assert.equal(denied.statusCode,403);
    assert.equal(denied.json().error.code,'BAD_LEASE');
   }
   assert.equal((await pool.query('SELECT count(*)::int AS n FROM core_approvals WHERE order_id=$1',[orderId])).rows[0].n,0);
   assert.equal((await pool.query('SELECT count(*)::int AS n FROM core_confirmations WHERE order_id=$1',[orderId])).rows[0].n,0);
  }catch(failure){
   t.diagnostic(`PILOT_COMPOSITION_DIAG stage=${stage} status=${lastStatus} reason=${lastReason} assertion=${safe(failure?.actual)}/${safe(failure?.expected)} error=${safe(failure?.code)}`);
   throw failure;
  }finally{
   if(app)await app.close().catch(()=>{});
   if(bootstrapped){
    await pool.query('DELETE FROM core_print_jobs WHERE order_id=$1',[orderId]).catch(()=>{});
    await pool.query('DELETE FROM core_pilot_print_authorizations WHERE order_id=$1',[orderId]).catch(()=>{});
    await pool.query('DELETE FROM core_pilot_code_attempts WHERE order_id=$1',[orderId]).catch(()=>{});
    await pool.query('DELETE FROM core_pilot_candidates WHERE order_id=$1',[orderId]).catch(()=>{});
    await pool.query('DELETE FROM core_audit WHERE shop_id=$1',[shop]).catch(()=>{});
    await pool.query('DELETE FROM core_revisions WHERE order_id=$1',[orderId]).catch(()=>{});
    await pool.query('DELETE FROM core_orders WHERE shop_id=$1',[shop]).catch(()=>{});
    await pool.query('DELETE FROM core_idempotency WHERE shop_id=$1',[shop]).catch(()=>{});
    await pool.query('DELETE FROM core_conversation_controls WHERE shop_id=$1 AND conversation_id=$2',[shop,conversation]).catch(()=>{});
    await pool.query('DELETE FROM core_pilot_shop_code_windows WHERE shop_id=$1',[shop]).catch(()=>{});
    await pool.query('DELETE FROM core_pilot_shop_config WHERE shop_id=$1',[shop]).catch(()=>{});
    await pool.query('DELETE FROM core_shop_zalo_oa_registry WHERE shop_id=$1',[shop]).catch(()=>{});
    await pool.query('DELETE FROM zalo_process_queue WHERE oa_id=$1',[oa]).catch(()=>{});
    await pool.query('DELETE FROM zalo_inbound_events WHERE oa_id=$1',[oa]).catch(()=>{});
    await pool.query('DELETE FROM core_sessions WHERE user_id IN (SELECT id FROM core_users WHERE shop_id=$1)',[shop]).catch(()=>{});
    await pool.query('DELETE FROM core_users WHERE shop_id=$1',[shop]).catch(()=>{});
    await pool.query('DELETE FROM core_shop_settings WHERE shop_id=$1',[shop]).catch(()=>{});
   }
   if(tempRoot)await fs.rm(tempRoot,{recursive:true,force:true}).catch(()=>{});
   await pool.end();
  }
 });

test('DOCX integration NOT RUN: no executable pilot DOCX Core-to-Agent integration case',
 {skip:'NOT RUN: this pilot integration executable covers PDF only'},()=>{});
