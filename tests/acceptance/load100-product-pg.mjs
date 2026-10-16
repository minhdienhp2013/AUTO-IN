/**
 * CODE505 LOAD100: isolated, evidence-first product acceptance.
 * NOT a 24-hour or physical TN037 release test. No provider sender or printer.
 * Run: AUTOIN_OPERATION_MODE=simulation AUTOIN_ALLOW_PG_ACCEPTANCE=YES_ISOLATED_TEST_DB
 *      TEST_DATABASE_URL=postgresql://...@127.0.0.1:5432/autoin_test_load100
 *      node --import tsx tests/acceptance/load100-product-pg.mjs
 * --check-fixture validates the fixed public manifest WITHOUT product PASS.
 */
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {readFile,mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile as execFileCallback} from 'node:child_process';
import {promisify} from 'node:util';

const execFile=promisify(execFileCallback);
const hash=b=>createHash('sha256').update(b).digest('hex');
const FIXTURE=resolve('tests/fixtures/public/load100');
const TIMEOUT={http_ms:20000,processor_ms:90000,run_ms:1200000,worker_drain_ms:480000};
const ADOPT_ROUTE='/internal/simulation/inbound-artifacts/:event_id/adopt';
const report={schema:'autoin.load100.acceptance.v1',mode:'simulation',status:'NOT_RUN',
  dataset:'load100-fixed-v1', limits:{http_concurrency:5,workers:2,worker_pools:2,processors:2},
  timeouts:TIMEOUT,submitted:0,completed:0,failed:0,unique_order_ids:0,
  replay_events:0,lost_success_response_replays:0,
  controlled_core_revisions:0,revisions_verified:0,latency_ms:{},http_errors:[],
  expected_source_sha256:{},observed_source_sha256:{},worker_counters:{ingested:0,claimed:0,processed:0,held:0,needs_human:0,retry:0},
  product_commit_sha:null,fixture_variant:'80 PNG / 20 PDF, two shared byte-identical assets',
  elapsed_ms:null,throughput_orders_per_second:null,queue_peak:null,queue_drain:null,
  guards_before:null,guards_after:null,reason:null,live:{oa:false,deepseek:false,ricoh:false,ios_safari:false,tn037_7d:false}};
let started=performance.now(),finished=false,runAbortController=null;
const observations={webhook:[],upload:[],adopt:[],preview:[],processor:[]};
const stop=(code,msg)=>{const e=new Error(msg);e.code=code;throw e};
function quantiles(samples){
 const v=[...samples].sort((a,b)=>a-b);
 if(!v.length)return {n:0,p50:null,p95:null,max:null};
 const at=p=>Math.round(v[Math.ceil(p*v.length)-1]*100)/100;
 return {n:v.length,p50:at(0.5),p95:at(0.95),max:Math.round(v.at(-1)*100)/100};
}
async function emit(exit=2){
 if(finished)return;finished=true;
 report.elapsed_ms=Math.round(performance.now()-started);
 report.latency_ms=Object.fromEntries(Object.entries(observations).map(([k,v])=>[k,quantiles(v)]));
 report.throughput_orders_per_second=report.elapsed_ms>0?
   Math.round(report.completed*100000/report.elapsed_ms)/100:null;
 const output=JSON.stringify(report);
 console.log('LOAD100_JSON '+output);
 const filename=process.env.AUTOIN_LOAD100_REPORT;
 if(filename){
   if(!filename.startsWith('/tmp/')&&!filename.startsWith('/var/tmp/'))
     console.error('REPORT_PATH_DENIED: only /tmp or /var/tmp outside repository');
   else await writeFile(filename,output+'\n',{mode:0o600}).catch(e=>
     console.error('REPORT_WRITE_FAILURE '+e.message));
 }
 console.log('TAP version 13');
 if(report.status==='PASS')console.log('ok 1 - LOAD100 batch of 100 synthetic orders (not TN037 release)');
 else if(report.status==='FIXTURE_ONLY')console.log('ok 1 - LOAD100 fixture-only selfcheck # SKIP product PostgreSQL/Fastify NOT RUN');
 else console.log('not ok 1 - LOAD100 product # '+report.status+' '+String(report.reason).replace(/[\r\n]/g,' '));
 console.log('1..1');
 process.exitCode=exit;
}
// Failures cancel outstanding HTTP/processors, then WAIT for every task to settle
// before app/pool/artifact cleanup. Promise.all alone would release resources early.
async function bounded(items,limit,handler){
 let index=0,active=0,peak=0,firstError=null;
 const threads=Array.from({length:Math.min(limit,items.length)},async()=>{
   while(index<items.length&&!firstError&&!runAbortController?.signal.aborted){
     const item=items[index++];active++;peak=Math.max(peak,active);
     try{await handler(item)}
     catch(e){if(!firstError){firstError=e;runAbortController?.abort(e)}}
     finally{active--}
   }
 });
 const settled=await Promise.allSettled(threads);
 const unexpected=settled.find(x=>x.status==='rejected');
 if(firstError)throw firstError;
 if(unexpected)throw unexpected.reason;
 if(runAbortController?.signal.aborted)stop('RUN_TIMEOUT','Global run deadline exceeded');
 return peak;
}
async function readFixture(){
 const m=JSON.parse(await readFile(join(FIXTURE,'manifest.json'),'utf8'));
 assert.equal(m.schema,'autoin.load100.fixture.v1');
 assert.equal(m.cases?.length,100);
 assert.equal(m.expected_unique_customers,100);
 assert.equal(m.expected_unique_conversations,100);
 assert.equal(m.expected_unique_orders,100);
 const known=new Set(),customers=new Set(),conversations=new Set();
 const assets={};
 for(const [kind,filename] of Object.entries({image:'source.png',file:'source.pdf'})){
   const buf=await readFile(join(FIXTURE,filename));
   assert.equal(hash(buf),m.assets[kind].sha256,'Fixture hash mismatch '+filename);
   assert.equal(buf.length,m.assets[kind].bytes,'Fixture byte mismatch '+filename);
   assets[kind]=buf;
 }
 for(let i=0;i<m.cases.length;i++){
   const c=m.cases[i],num=String(i+1).padStart(3,'0');
   assert.equal(c.index,i+1);
   assert.equal(c.event_id,'load100-event-'+num);
   assert.equal(c.customer_id,'load100-customer-'+num);
   assert.equal(c.conversation_id,'load100-conversation-'+num);
   assert.equal(c.kind,i%5===4?'file':'image');
   assert.equal(c.filename,c.kind==='file'?'source.pdf':'source.png');
   assert.equal(c.expected.source_sha256,m.assets[c.kind].sha256);
   assert.deepEqual(c.expected.revisions,[1,2,3]);
   assert.equal(c.expected.event_id,c.event_id);
   assert.equal(c.expected.customer_id,c.customer_id);
   assert.equal(c.expected.conversation_id,c.conversation_id);
   assert.ok(!known.has(c.event_id)&&!customers.has(c.customer_id)&&!conversations.has(c.conversation_id));
   known.add(c.event_id);customers.add(c.customer_id);conversations.add(c.conversation_id);
 }
 report.expected_source_sha256=Object.fromEntries(m.cases.map(c=>[c.event_id,c.expected.source_sha256]));
 return {cases:m.cases,assets};
}
function guardDatabase(url){
 if(process.env.AUTOIN_OPERATION_MODE!=='simulation'||process.env.AUTOIN_ALLOW_PG_ACCEPTANCE!=='YES_ISOLATED_TEST_DB')
   stop('ISOLATION_REQUIRED','simulation + YES_ISOLATED_TEST_DB are required');
 if(!url||url.includes('?')||url.includes('#'))stop('DATABASE_REQUIRED','isolated local PostgreSQL URL required');
}
async function run(){
 const {cases,assets}=await readFixture();
 if(process.argv.includes('--check-fixture')){
   report.status='FIXTURE_ONLY';report.reason='100 fixed cases and binary SHA256 validated; product NOT RUN';
   await emit(0);return;
 }
 const url=process.env.TEST_DATABASE_URL;
 guardDatabase(url);
 const [{default:pg},{PgStore},{createCoreModule},{asSqlPool,assertIsolatedSimulationDatabase},
   {createSyntheticZaloRuntime},{buildIntegratedApp}]=await Promise.all([
   import('pg'),import('../../backend/storage/database.ts'),
   import('../../backend/core/factory.ts'),import('../../backend/composition/postgres.ts'),
   import('../../backend/composition/zalo-simulation.ts'),import('../../backend/composition/runtime.ts')]);
 assertIsolatedSimulationDatabase(url);
 // Every SQL query is bounded as well; the global watchdog is not an uncancellable DB query.
 const poolOptions={connectionString:url,max:5,connectionTimeoutMillis:5000,
   query_timeout:TIMEOUT.http_ms,statement_timeout:TIMEOUT.http_ms};
 const a=new pg.Pool(poolOptions);
 const b=new pg.Pool(poolOptions);
 let app=null,root=null;
 const runId=randomUUID(),shop='autoin-test-load100-'+runId,oa='oa-'+runId;
 const fixtureKey=randomUUID()+randomUUID(),password='test-only-'+randomUUID();
 const scope={shop_id:shop,oa_id:oa},python=process.env.AUTOIN_PYTHON||'python3';
 runAbortController=new AbortController();
 const watchdog=setTimeout(()=>runAbortController.abort(new Error('RUN_TIMEOUT')),TIMEOUT.run_ms);
 watchdog.unref();
 const startDeadline=performance.now()+TIMEOUT.run_ms;
 const remaining=()=>{if(runAbortController.signal.aborted||performance.now()>startDeadline)
   stop('RUN_TIMEOUT','20-minute technical test deadline exceeded')};
 const sql=(statement,args=[])=>a.query(statement,args);
 try{
   const git=await execFile('git',['rev-parse','HEAD'],{timeout:5000});
   report.product_commit_sha=git.stdout.trim();
   assert.match(report.product_commit_sha,/^[a-f0-9]{40}$/);
   const version=await sql('SHOW server_version_num');
   const major=Number(version.rows[0].server_version_num);
   if(major!==180003)stop('POSTGRES_VERSION_REQUIRED','Need isolated PostgreSQL 18.3, found '+major);
   root=await mkdtemp(join(tmpdir(),'autoin-load100-'));
   const inbound=join(root,'inbound'),output=join(root,'rendered');
   await mkdir(inbound,{mode:0o700});await mkdir(output,{mode:0o700});
   const core=createCoreModule({pool:asSqlPool(a)});
   await core.auth.bootstrapOwner({shop_id:shop,username:'owner',password,bootstrap_enabled:true});
   await sql('UPDATE core_shop_settings SET open_at=$2,close_at=$3 WHERE shop_id=$1',
     [shop,'00:00','24:00']); // fixture clock window only, never live shop settings
   await sql('INSERT INTO core_shop_zalo_oa_registry(shop_id,oa_id,app_id) VALUES($1,$2,$3)',
     [shop,oa,'synthetic-app-'+runId]);
   const r1=createSyntheticZaloRuntime(a,{kind:'synthetic_fixture',shop_id:shop,oa_id:oa,fixture_key:fixtureKey},
     {store:new PgStore(asSqlPool(a)),artifactRoot:inbound,python});
   const r2=createSyntheticZaloRuntime(b,{kind:'synthetic_fixture',shop_id:shop,oa_id:oa,fixture_key:fixtureKey},
     {store:new PgStore(asSqlPool(b)),artifactRoot:inbound,python});
   app=buildIntegratedApp({pool:asSqlPool(a),zaloWebhook:r1.webhook,
     zaloWorkerConfigured:true,syntheticArtifactIngest:{artifactRoot:inbound,scope},
     previewArtifactRoot:output});
   // Fail closed before creating 100 proposals: no legitimate adopt endpoint on this product SHA.
   await app.ready();
   if(!app.hasRoute({method:'POST',url:ADOPT_ROUTE}))
     stop('MISSING_STAFF_ADOPT_API',
       'AI0 must expose authenticated existing-order adoption + identical-key ACK replay via '+ADOPT_ROUTE+
       '; cannot call direct Core service or create a second draft to fake 100 mappings');
   await app.listen({host:'127.0.0.1',port:0});
   const address=app.server.address();
   assert.ok(address && typeof address!=='string');
   const base='http://127.0.0.1:'+address.port;
   const http=async(method,path,body,headers={},stage='webhook',drop=false)=>{
     remaining();
     const t=performance.now();
     let response;
     try{
       response=await fetch(base+path,{
         method,headers:{...(body?{'Content-Type':'application/json'}:{}),...headers},
         ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.any([AbortSignal.timeout(TIMEOUT.http_ms),runAbortController.signal])
       });
       const status=response.status;
       // Dropped-response fixture: server has succeeded, client deliberately
       // discards the 2xx body and replays the identical request/key.
       const value=drop?(await response.arrayBuffer(),null):await response.json();
       observations[stage]?.push(performance.now()-t);
       if(status<200||status>=300){
         const err={stage,path,status,code:value?.error?.code||'UNKNOWN'};
         report.http_errors.push(err);stop('HTTP_ERROR',JSON.stringify(err));
       }
       return {status,data:value};
     }catch(e){
       if(e.code)throw e;
       report.http_errors.push({stage,path,error:e.name});
       stop('HTTP_NETWORK_ERROR',stage+' '+e.message);
     }
   };
   const login=await http('POST','/api/v1/auth/login',
     {shop_id:shop,username:'owner',password},{},'webhook');
   assert.equal(login.status,200);
   const auth={Authorization:'Bearer '+login.data.token};
   // Test-only synthetic fixture verifier: never Zalo provider-signed identity.
   const sign={'x-test-fixture-key':fixtureKey};
   const replayTimestamp=new Date().toISOString();
   const send=async c=>http('POST','/webhooks/zalo',{
     synthetic_fixture:true,event_id:c.event_id,oa_id:oa,customer_id:c.customer_id,
     conversation_id:c.conversation_id,occurred_at:replayTimestamp,
     kind:c.kind,filename:c.filename,file_ref:'untrusted-'+c.event_id
   },sign,'webhook');
   const baseline=async()=>{
     const r=await sql(
       "SELECT (SELECT count(*)::int FROM core_confirmations c JOIN core_orders o ON o.id=c.order_id WHERE o.shop_id=$1) confirmations,"+
       " (SELECT count(*)::int FROM core_approvals a JOIN core_orders o ON o.id=a.order_id WHERE o.shop_id=$1) approvals,"+
       " (SELECT count(*)::int FROM core_print_jobs j JOIN core_orders o ON o.id=j.order_id WHERE o.shop_id=$1) print_jobs",[shop]);
     return r.rows[0];
   };
   report.guards_before=await baseline();
   assert.deepEqual(report.guards_before,{confirmations:0,approvals:0,print_jobs:0});
   // All HTTP is genuine Fastify loopback, limit five concurrent requests.
   await bounded(cases,5,async c=>{
     const r=await send(c);assert.equal(r.data.status,'accepted');
     report.submitted++;
   });
   await bounded(cases.slice(0,20),5,async c=>{
     const r=await send(c);assert.equal(r.data.status,'duplicate');
     report.replay_events++;
   });
   await bounded(cases,5,async c=>{
     const r=await http('POST','/internal/simulation/inbound-artifacts',
       {event_id:c.event_id,filename:c.filename,
         content_base64:assets[c.kind].toString('base64')},auth,'upload');
     assert.equal(r.data.status,'registered');
     assert.equal(r.data.preview_trusted,false);
   });
   // An event is COMMITTED after enqueue; the batch is DONE only after processing.
   // Both independent durable queues must drain. Do not call COMMITTED an order.
   const sampleQueues=async()=>{
     const x=(await sql(
       "SELECT (SELECT count(*)::int FROM zalo_batches WHERE oa_id=$1 AND status<>'DONE') batches_pending,"+
       " (SELECT count(*)::int FROM zalo_process_queue WHERE oa_id=$1 AND status<>'COMMITTED') events_pending,"+
       " (SELECT count(*)::int FROM zalo_batches WHERE oa_id=$1 AND status='DONE') batches_done,"+
       " (SELECT count(*)::int FROM zalo_process_queue WHERE oa_id=$1 AND status='COMMITTED') events_committed",
       [oa])).rows[0];
     const q={batches_pending:x.batches_pending,events_pending:x.events_pending,
       combined_pending:x.batches_pending+x.events_pending,
       batches_done:x.batches_done,events_committed:x.events_committed};
     report.queue_peak=Math.max(report.queue_peak||0,q.combined_pending);
     report.queue_drain=q;
     return q;
   };
   let proposalCount=0,loop=0;
   while(proposalCount<100){
     remaining();loop++;
     if(performance.now()-started>TIMEOUT.worker_drain_ms)
       stop('WORKER_DRAIN_TIMEOUT','AI2 durable worker failed to settle within technical 8-minute drain');
     // Advance synthetic batching deadlines only; never fake DONE/PROCESSED rows.
     await sql("UPDATE zalo_batches SET deadline_at=now()-interval '1 second' WHERE oa_id=$1 AND status='OPEN'",[oa]);
     await sampleQueues();
     const work=[];
     await bounded([r1,r2],2,async runtime=>{
       const tick=await runtime.tick_inbound({ingest_limit:25,batch_limit:10});
       for(const field of ['ingested','claimed','processed','held','needs_human','retry']){
         if(!Number.isSafeInteger(tick[field])||tick[field]<0)
           stop('INVALID_WORKER_RESULT','Invalid durable worker counter '+field);
         report.worker_counters[field]+=tick[field];
       }
       assert.equal(tick.claimed,tick.processed+tick.held+tick.needs_human+tick.retry,
         'AI2 worker claimed accounting');
       work.push(tick);
     });
     // Retried effects may not be safely inferred to have completed. In LOAD100,
     // any held/needs_human/retry outcome is a FAIL, with DB state left for diagnosis.
     if(work.some(w=>w.held||w.needs_human||w.retry)){
       await sampleQueues();
       stop('WORKER_NOT_CLEAN','AI2 held/needs_human/retry '+JSON.stringify(work));
     }
     proposalCount=(await sql('SELECT count(*)::int n FROM core_ai_draft_proposals WHERE shop_id=$1',[shop])).rows[0].n;
     if(loop>100)stop('WORKER_BACKLOG','AI2 did not drain after 100 bounded worker ticks');
   }
   const queuesAfterWorkers=await sampleQueues();
   assert.deepEqual({batches_pending:queuesAfterWorkers.batches_pending,
     events_pending:queuesAfterWorkers.events_pending},
     {batches_pending:0,events_pending:0},'Both AI2 queues must drain');
   assert.equal(queuesAfterWorkers.batches_done,100);
   assert.equal(queuesAfterWorkers.events_committed,100);
   // Outbound adapter must remain disabled even though queued requests may exist.
   const outbound=await r1.tick_outbound();
   assert.equal(outbound.disabled,true,'live outbound must not be enabled');
   const rows=(await sql('SELECT p.order_id::text,p.customer_id,p.conversation_id FROM core_ai_draft_proposals p WHERE p.shop_id=$1',[shop])).rows;
   assert.equal(rows.length,100);
   const idByCase=new Map();
   for(const c of cases){
     const found=rows.filter(r=>r.customer_id===c.customer_id&&r.conversation_id===c.conversation_id);
     assert.equal(found.length,1,'missing or duplicate expected AI2 mapping '+c.event_id);
     idByCase.set(c.event_id,found[0].order_id);
   }
   assert.equal(new Set(idByCase.values()).size,100,'not 100 distinct AI2-created orders');
   // Adoption must be an authenticated, idempotent staff API targeting the
   // EXISTING AI2 order. No direct DB status writes or createDraft fallback.
   await bounded(cases,5,async(c,i)=>{
     const path='/internal/simulation/inbound-artifacts/'+c.event_id+'/adopt';
     const body={order_id:idByCase.get(c.event_id),paper:'A4',copies:1,duplex:false,
       idempotency_key:'load100-adopt-'+c.event_id};
     if(c.index<=20){
       const first=await http('POST',path,body,auth,'adopt',true);
       assert.ok(first.status===200||first.status===201);
       const replay=await http('POST',path,body,auth,'adopt');
       assert.equal(replay.status,first.status,'HTTP ACK replay response code');
       assert.equal(replay.data.order_id,body.order_id);
       assert.equal(replay.data.status,'adopted');
       assert.equal(replay.data.revision,2);
       assert.equal(replay.data.requires_customer_confirmation,true);
       assert.equal(replay.data.preview_trusted,false);
       // Check the exact persisted server receipt, not just order/revision guesses.
       const receipts=(await sql(
         'SELECT response FROM ai0_source_adoption_receipts WHERE shop_id=$1 AND oa_id=$2 AND event_id=$3',
         [shop,oa,c.event_id])).rows;
       assert.equal(receipts.length,1);
       assert.deepEqual(replay.data,receipts[0].response);
       report.lost_success_response_replays++;
     }else{
       const result=await http('POST',path,body,auth,'adopt');
       assert.equal(result.data.order_id,body.order_id);
       assert.equal(result.data.status,'adopted');
       assert.equal(result.data.revision,2);
       assert.equal(result.data.requires_customer_confirmation,true);
       assert.equal(result.data.preview_trusted,false);
     }
     report.controlled_core_revisions++;
   });
   const workerProcessors=await bounded(cases,2,async c=>{
     remaining();const at=performance.now(),orderId=idByCase.get(c.event_id);
     const child=await execFile(process.execPath,
       ['--import','tsx','scripts/process-order.ts',shop,orderId],{
       cwd:process.cwd(),timeout:TIMEOUT.processor_ms,killSignal:'SIGKILL',signal:runAbortController.signal,maxBuffer:1024*1024,
       env:{...process.env,DATABASE_URL:url,AUTOIN_INPUT_ROOT:inbound,AUTOIN_ARTIFACT_ROOT:output,
         AUTOIN_PYTHON:python,AUTOIN_PROCESSOR_ID:'load100-processor'}
     });
     observations.processor.push(performance.now()-at);
     const result=JSON.parse(child.stdout);
     assert.equal(result.revision,3,'AI3 verified plan must advance the adopted AI2 order to revision 3');
   });
   assert.ok(workerProcessors<=2);
   const expectedOrders=new Set([...idByCase.values()]);
   const stored=(await sql(
     'SELECT o.id::text order_id,o.customer_id,o.conversation_id,o.active_revision,r.request_hash,r.request_data,'+
     ' v.artifact_ref,v.manifest_sha256,v.request_hash AS anchored_hash FROM core_orders o '+
     'JOIN core_revisions r ON r.order_id=o.id AND r.revision=o.active_revision '+
     'LEFT JOIN ai0_verified_plan_manifests v ON v.order_id=o.id AND v.shop_id=o.shop_id AND v.revision=o.active_revision '+
     'WHERE o.shop_id=$1',[shop])).rows;
   assert.equal(stored.length,100,'scope leakage, orphan, or duplicate orders');
   assert.equal(new Set(stored.map(x=>x.order_id)).size,100);
   const allRevisions=(await sql(
     'SELECT order_id::text,revision,request_hash FROM core_revisions WHERE order_id=ANY($1::uuid[]) ORDER BY order_id,revision',
     [[...expectedOrders]])).rows;
   assert.equal(allRevisions.length,300,'No missing/extra historical revisions');
   const revisionsByOrder=new Map();
   for(const revision of allRevisions){
     assert.match(revision.request_hash,/^[a-f0-9]{64}$/);
     const list=revisionsByOrder.get(revision.order_id)||[];
     list.push(revision.revision);revisionsByOrder.set(revision.order_id,list);
   }
   for(const id of expectedOrders){
     assert.deepEqual(revisionsByOrder.get(id),[1,2,3],'Exact order history 1->2->3');
     report.revisions_verified++;
   }
   for(const c of cases){
     const orderId=idByCase.get(c.event_id);
     assert.ok(expectedOrders.has(orderId));
     const row=stored.find(x=>x.order_id===orderId);
     assert.ok(row&&row.customer_id===c.customer_id&&row.conversation_id===c.conversation_id);
     assert.equal(row.active_revision,3);
     assert.match(row.request_hash,/^[a-f0-9]{64}$/);
     assert.equal(row.anchored_hash,row.request_hash);
     assert.ok(row.artifact_ref,'AI3 sealed manifest missing');
     assert.equal(row.request_data.documents?.length,1);
     assert.equal(row.request_data.documents[0]?.copies,1);
     assert.equal(row.request_data.documents[0]?.paper,'A4');
     const source=(await sql(
       'SELECT sha256 FROM ai0_inbound_document_artifacts WHERE shop_id=$1 AND oa_id=$2 AND event_id=$3',
       [shop,oa,c.event_id])).rows;
     assert.equal(source.length,1);
     assert.equal(source[0].sha256,c.expected.source_sha256);
     report.observed_source_sha256[c.event_id]=source[0].sha256;
     const manifest=await readFile(join(output,row.artifact_ref));
     assert.equal(hash(manifest),row.manifest_sha256);
     const m=JSON.parse(manifest.toString('utf8'));
     assert.equal(m.schema,'ai3.document_bridge.v1');
     assert.equal(m.request_hash,row.request_hash);
     assert.equal(m.files.length,1);
     assert.equal(m.files[0].file_sha256,c.expected.source_sha256,
       'AI3 sealed source SHA mismatch against the event ID');
     report.completed++;
   }
   await bounded(cases,5,async c=>{
     const id=idByCase.get(c.event_id);
     const r=await http('GET','/api/v1/orders/'+id+'/revisions/3/previews',null,auth,'preview');
     assert.equal(r.data.revision,3);
     assert.equal(r.data.preview_verified,true);
   });
   report.guards_after=await baseline();
   assert.deepEqual(report.guards_after,report.guards_before);
   report.queue_drain=await sampleQueues();
   assert.equal(report.queue_drain.batches_pending,0,'Batch backlog not drained');
   assert.equal(report.queue_drain.events_pending,0,'Event queue backlog not drained');
   assert.equal(report.queue_drain.batches_done,100);
   assert.equal(report.queue_drain.events_committed,100);
   assert.deepEqual(report.observed_source_sha256,report.expected_source_sha256);
   assert.equal(report.submitted,100);
   assert.equal(report.completed,100);
   assert.equal(report.replay_events,20);
   assert.equal(report.lost_success_response_replays,20);
   assert.equal(report.controlled_core_revisions,100);
   assert.equal(report.http_errors.length,0);
   report.unique_order_ids=expectedOrders.size;
   report.status='PASS';report.reason='100/100 synthetic verified in isolated batch, not 100 per day or TN037';
 }finally{
   // bounded() has settled all in-flight work (including child processors)
   // before a rejected operation reaches this cleanup. Cancelling the watchdog
   // prevents a late timeout during app.close()/database teardown.
   clearTimeout(watchdog);
   if(app)await app.close();
   await Promise.allSettled([a.end(),b.end()]);
   if(root)await rm(root,{recursive:true,force:true});
   runAbortController=null;
 }
}
try{await run();if(!finished)await emit(report.status==='PASS'?0:2)}
catch(e){
 report.status=e.code==='MISSING_STAFF_ADOPT_API'||e.code==='DATABASE_REQUIRED'||
   e.code==='ISOLATION_REQUIRED'||e.code==='POSTGRES_VERSION_REQUIRED'?'BLOCKED':'FAIL';
 report.failed=Math.max(report.failed,report.submitted-report.completed,report.status==='FAIL'?1:0);
 report.reason=(e.code||e.name||'ERROR')+': '+String(e.message).slice(0,550);
 await emit(2);
}
