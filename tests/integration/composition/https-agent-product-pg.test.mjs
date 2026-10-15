import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile as execFileCallback} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash,randomUUID} from 'node:crypto';
import {chmod, mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import pg from 'pg';
import {buildIntegratedApp} from '../../../backend/composition/runtime.ts';
import {asSqlPool, assertIsolatedSimulationDatabase} from '../../../backend/composition/postgres.ts';
import {createCoreModule} from '../../../backend/core/factory.ts';

const execFile=promisify(execFileCallback);
const databaseUrl=process.env.TEST_DATABASE_URL;
const run=async (program,args,options={})=>execFile(program,args,{
  cwd:process.cwd(),timeout:60000,maxBuffer:1024*1024,...options
});
const code=payload=>payload?.error?.code;
const secureHeaders=token=>({authorization:'Bearer '+token});

/** This exercise has NO physical driver, no live OA and no remote listener.
 * It proves that a real scoped HTTPS Python agent can use the AI1 Fastify/PG
 * lease contract, and DryRun can never become verified paper. */
test('AI0 PRODUCT PostgreSQL + HTTPS Python DryRun: approval, journal, simulation and UNKNOWN no-resend',{
  skip:!databaseUrl?'TEST_DATABASE_URL missing; product HTTPS/PG DryRun NOT VERIFIED':false,
  timeout:300000
},async()=>{
  assertIsolatedSimulationDatabase(databaseUrl);
  const scratch=await mkdtemp(join(tmpdir(),'autoin-https-dryrun-'));
  const cert=join(scratch,'localhost.crt'),key=join(scratch,'localhost.key');
  const inputRoot=join(scratch,'input'),artifactRoot=join(scratch,'output');
  let pool,app;
  try {
    await mkdir(inputRoot,{mode:0o700});
    await mkdir(artifactRoot,{mode:0o700});
    await run('openssl',['req','-x509','-nodes','-newkey','rsa:2048','-days','1',
      '-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1',
      '-keyout',key,'-out',cert]);
    await run('python3',['-c',
      'from PIL import Image;import sys;Image.new("RGB",(120,160),"white").save(sys.argv[1])',
      join(inputRoot,'fixture.png')]);
    pool=new pg.Pool({connectionString:databaseUrl,connectionTimeoutMillis:5000});
    const core=createCoreModule({pool:asSqlPool(pool)});
    const shop='autoin-test-https-'+randomUUID();
    const password='private-synthetic-'+randomUUID();
    const customer='synthetic-customer';
    const agentToken=randomUUID()+randomUUID();
    const customerToken=randomUUID()+randomUUID();
    await pool.query('INSERT INTO core_shop_settings(shop_id,open_at,close_at) VALUES($1,$2,$3)',
      [shop,'00:00','23:59']);
    await core.auth.bootstrapOwner({shop_id:shop,username:'owner',password,bootstrap_enabled:true});
    const login=await core.auth.login(shop,'owner',password);
    app=buildIntegratedApp({pool:asSqlPool(pool),tls:{
      key:await readFile(key),cert:await readFile(cert)
    },identities:[
      {token:customerToken,principal:{id:'verified-customer',shop_id:shop,
        customer_id:customer,role:'customer',verified:true}},
      {token:agentToken,principal:{id:'agent-local',shop_id:shop,
        printer_ids:['RMP7000'],role:'print_agent',verified:true}}
    ],approvedDocumentEvidence:{artifactRoot,python:'python3',timeoutMs:20000}});
    await app.listen({host:'127.0.0.1',port:0});
    const address=app.server.address();
    assert.ok(address && typeof address!=='string');
    const url='https://127.0.0.1:'+address.port;
    const pythonEnv={...process.env,AUTO_IN_AGENT_TOKEN:agentToken,
      SSL_CERT_FILE:cert,PYTHONPATH:process.cwd(),PYTHONNOUSERSITE:'1'};
    async function post(path,payload,token){
      return app.inject({method:'POST',url:path,payload,
        headers:secureHeaders(token)});
    }
    async function orderReadyToDryRun(label){
      const newOrder=await post('/api/v1/orders',{
        customer_id:customer,request_data:{documents:[{
          artifact_name:'fixture.png',copies:2,duplex:false,paper:'A4'
        }]},idempotency_key:'create-'+label
      },login.token);
      assert.equal(newOrder.statusCode,200,JSON.stringify(newOrder.json()));
      const id=newOrder.json().order_id;
      assert.ok(id);
      const {stdout}=await run(process.execPath,['--import','tsx','scripts/process-order.ts',shop,id],{
        env:{...process.env,DATABASE_URL:databaseUrl,AUTOIN_INPUT_ROOT:inputRoot,
          AUTOIN_ARTIFACT_ROOT:artifactRoot,AUTOIN_PROCESSOR_ID:'ai0-verified-fixture',
          AUTOIN_PYTHON:'python3'}
      });
      const published=JSON.parse(stdout);
      assert.equal(published.revision,2);
      assert.equal(published.requires_reconfirmation,true);
      const badApprove=await post('/api/v1/orders/'+id+'/approvals',{
        expected_revision:2,acknowledge_deposit_shortage:false,idempotency_key:'bad-'+label
      },login.token);
      assert.notEqual(badApprove.statusCode,200,
        'No approval without verified customer reconfirmation');
      assert.equal(code(badApprove.json()),'CUSTOMER_NOT_CONFIRMED');
      const confirm=await post('/api/v1/orders/'+id+'/confirmations',{
        expected_revision:2,kind:'request',idempotency_key:'confirm-'+label
      },customerToken);
      assert.equal(confirm.statusCode,200,JSON.stringify(confirm.json()));
      const approve=await post('/api/v1/orders/'+id+'/approvals',{
        expected_revision:2,acknowledge_deposit_shortage:false,idempotency_key:'approve-'+label
      },login.token);
      assert.equal(approve.statusCode,200,JSON.stringify(approve.json()));
      return {id,jobId:approve.json().job_id};
    }
    const normal=await orderReadyToDryRun('normal');
    // Python's real urllib HTTPS transport uses the private CA; the only driver
    // is DryRunDriver. A real machine cannot be reached by this test.
    const agentArgs=['-m','agents.windows.cli','--api-base-url',url,
      '--journal',join(scratch,'normal.sqlite')];
    const first=await run('python3',agentArgs,{env:pythonEnv});
    const outcome=JSON.parse(first.stdout.trim());
    assert.equal(outcome.result.status,'SIMULATED_DONE',JSON.stringify(outcome));
    assert.equal(outcome.result.job_id,normal.jobId);
    const state=async id=>(await pool.query(
      'SELECT state,verified_sheets,mode_at_send FROM core_print_jobs WHERE id=$1',[id])).rows[0];
    async function manifestFor(order){
      const anchor=await pool.query(
        'SELECT artifact_ref,manifest_sha256 FROM ai0_verified_plan_manifests WHERE shop_id=$1 AND order_id=$2 AND revision=2',
        [shop,order.id]);
      assert.equal(anchor.rows.length,1);
      const path=join(artifactRoot,anchor.rows[0].artifact_ref);
      const raw=await readFile(path);
      return {anchor:anchor.rows[0],path,manifest:JSON.parse(raw.toString('utf8'))};
    }
    async function assertEvidenceRefusalBeforeJournal(order,label){
      const journalPath=join(scratch,label+'.sqlite');
      const attempt=await run('python3',['-m','agents.windows.cli','--api-base-url',url,
        '--journal',journalPath],{env:pythonEnv}).then(value=>({value}),error=>({error}));
      assert.ok(attempt.error,'Unverified document evidence must stop the agent');
      assert.equal(attempt.error.code,2);
      const output=JSON.parse(attempt.error.stdout.trim());
      assert.equal(output.result.status,'BLOCKED',JSON.stringify(output));
      assert.equal(output.result.reason,'DOCUMENT_EVIDENCE_UNVERIFIED',JSON.stringify(output));
      assert.equal((await state(order.jobId)).state,'NOT_SENT');
      const journal=await run('python3',['-c',
        'import sqlite3,sys;d=sqlite3.connect(sys.argv[1]);print(d.execute("SELECT COUNT(*) FROM jobs").fetchone()[0])',
        journalPath]);
      assert.equal(journal.stdout.trim(),'0','Evidence rejection must happen before a journal boundary');
      const count=await pool.query(
        'SELECT COUNT(*)::int AS n FROM core_print_jobs WHERE order_id=$1',[order.id]);
      assert.equal(count.rows[0].n,1,'Evidence rejection must not create another print job');
    }

    const done=await state(normal.jobId);
    assert.equal(done.state,'SIMULATED_DONE');
    assert.equal(done.mode_at_send,'simulation');
    assert.equal(Number(done.verified_sheets),0);
    const refuseFakeEvidence=await post('/api/v1/print-jobs/'+normal.jobId+'/verify-paper',{
      evidence_kind:'staff_inspected',physical_sheets:2,
      note:'test fixture must not count as real paper',idempotency_key:'fake-paper-normal'
    },login.token);
    assert.notEqual(refuseFakeEvidence.statusCode,200);
    assert.equal(code(refuseFakeEvidence.json()),'VERIFY_STATE');
    const refuseDelivery=await post('/api/v1/orders/'+normal.id+'/deliveries',{
      expected_revision:2,physical_sheets:1,idempotency_key:'delivery-normal'
    },login.token);
    assert.notEqual(refuseDelivery.statusCode,200);
    assert.equal(code(refuseDelivery.json()),'PAPER_NOT_VERIFIED');
    const repeat=await run('python3',agentArgs,{env:pythonEnv});
    assert.equal(JSON.parse(repeat.stdout).result.status,'NO_JOB');
    assert.equal((await state(normal.jobId)).state,'SIMULATED_DONE');

    const tampered=await orderReadyToDryRun('tampered');
    const anchor=await pool.query(
      'SELECT artifact_ref FROM ai0_verified_plan_manifests WHERE shop_id=$1 AND order_id=$2 AND revision=2',
      [shop,tampered.id]);
    assert.equal(anchor.rows.length,1);
    await writeFile(join(artifactRoot,anchor.rows[0].artifact_ref),Buffer.from('tampered manifest'));
    const tamperedJournal=join(scratch,'tampered.sqlite');
    const tamperedRun=await run('python3',['-m','agents.windows.cli','--api-base-url',url,
      '--journal',tamperedJournal],{env:pythonEnv}).then(value=>({value}),error=>({error}));
    assert.ok(tamperedRun.error,'Tampered manifest must block the agent before mark-sending');
    assert.equal(tamperedRun.error.code,2);
    assert.equal((await state(tampered.jobId)).state,'NOT_SENT');
    const emptyJournal=await run('python3',['-c',
      'import sqlite3,sys;d=sqlite3.connect(sys.argv[1]);print(d.execute("SELECT COUNT(*) FROM jobs").fetchone()[0])',
      tamperedJournal]);
    assert.equal(emptyJournal.stdout.trim(),'0','A blocked evidence gate must not journal a send boundary');
    const tamperedJobCount=await pool.query(
      'SELECT COUNT(*)::int AS n FROM core_print_jobs WHERE order_id=$1',[tampered.id]);
    assert.equal(tamperedJobCount.rows[0].n,1,'Evidence rejection must not create a retry job');


    const sourceTampered=await orderReadyToDryRun('tampered-source');
    const sourceManifest=await manifestFor(sourceTampered);
    const sourcePath=join(artifactRoot,sourceManifest.manifest.files[0].source_artifact_ref);
    await chmod(sourcePath,0o600);
    await writeFile(sourcePath,Buffer.from('synthetic altered source bytes'));
    await assertEvidenceRefusalBeforeJournal(sourceTampered,'tampered-source');

    const previewTampered=await orderReadyToDryRun('tampered-preview');
    const previewManifest=await manifestFor(previewTampered);
    const previewPath=join(artifactRoot,previewManifest.manifest.previews[0].ref);
    await chmod(previewPath,0o600);
    await writeFile(previewPath,Buffer.from('synthetic altered preview bytes'));
    await assertEvidenceRefusalBeforeJournal(previewTampered,'tampered-preview');

    const requestHashMismatch=await orderReadyToDryRun('request-hash-mismatch');
    const requestEvidence=await manifestFor(requestHashMismatch);
    const mismatchedHash='f'.repeat(64)===requestEvidence.manifest.request_hash
      ?'e'.repeat(64):'f'.repeat(64);
    requestEvidence.manifest.request_hash=mismatchedHash;
    const changedManifest=Buffer.from(JSON.stringify(requestEvidence.manifest),'utf8');
    await chmod(requestEvidence.path,0o600);
    await writeFile(requestEvidence.path,changedManifest);
    const changedManifestHash=createHash('sha256').update(changedManifest).digest('hex');
    const anchored=await pool.query(
      'UPDATE ai0_verified_plan_manifests SET manifest_sha256=$1 WHERE shop_id=$2 AND order_id=$3 AND revision=2',
      [changedManifestHash,shop,requestHashMismatch.id]);
    assert.equal(anchored.rowCount,1);
    await assertEvidenceRefusalBeforeJournal(requestHashMismatch,'request-hash-mismatch');

    const staleRevision=await orderReadyToDryRun('stale-revision');
    const staleClaim=await post('/internal/v1/print-jobs/claim',{
      printer_id:'RMP7000',idempotency_key:'claim-stale-revision'
    },agentToken);
    assert.equal(staleClaim.statusCode,200,JSON.stringify(staleClaim.json()));
    const staleJob=staleClaim.json().job;
    assert.ok(staleJob && staleJob.job_id===staleRevision.jobId);
    const revised=await post('/api/v1/orders/'+staleRevision.id+'/revisions',{
      expected_revision:2,
      request_data:{documents:[{artifact_name:'fixture.png',copies:3,duplex:false,paper:'A4'}]},
      idempotency_key:'revise-after-claim'
    },login.token);
    assert.equal(revised.statusCode,200,JSON.stringify(revised.json()));
    assert.equal(revised.json().revision,3);
    const stalePreflight=await post('/internal/v1/print-jobs/'+staleJob.job_id+'/preflight',{
      expected_revision:staleJob.revision,lease_token:staleJob.lease_token
    },agentToken);
    assert.equal(stalePreflight.statusCode,409,JSON.stringify(stalePreflight.json()));
    assert.equal(code(stalePreflight.json()),'STALE_REVISION');
    assert.equal((await state(staleJob.job_id)).state,'NOT_SENT');
    const staleCount=await pool.query(
      'SELECT COUNT(*)::int AS n FROM core_print_jobs WHERE order_id=$1',[staleRevision.id]);
    assert.equal(staleCount.rows[0].n,1,'Stale revision must not mint a replacement job');

    const lostAck=await orderReadyToDryRun('lost-mark-ack');
    const lostAckJournal=join(scratch,'lost-mark-ack.sqlite');
    const lostAckScript=[
      'from agents.windows.agent import DryRunDriver,Journal,PrintAgent',
      'from agents.windows.backend_http import HttpBackendClient',
      'import json,os,sys',
      'class LostAckBackend(HttpBackendClient):',
      ' def mark_sending(self,job):',
      '  super().mark_sending(job)',
      '  raise TimeoutError("synthetic lost ACK after committed mark-sending")',
      'j=Journal(sys.argv[2]);d=DryRunDriver()',
      'try:',
      ' a=PrintAgent(LostAckBackend(sys.argv[1],os.environ["AUTO_IN_AGENT_TOKEN"]),j,d)',
      ' result=a.run_once()',
      ' print(json.dumps({"result":result,"driver_calls":d.calls}))',
      'finally:j.close()'
    ].join('\n');
    const lostAckResult=await run('python3',['-c',lostAckScript,url,lostAckJournal],{env:pythonEnv});
    const lostAckOutput=JSON.parse(lostAckResult.stdout.trim());
    assert.equal(lostAckOutput.result.status,'UNKNOWN',JSON.stringify(lostAckOutput));
    assert.equal(lostAckOutput.driver_calls,0,'Lost mark ACK must never reach the driver');
    assert.equal((await state(lostAck.jobId)).state,'UNKNOWN');
    const lostAckCount=await pool.query(
      'SELECT COUNT(*)::int AS n FROM core_print_jobs WHERE order_id=$1',[lostAck.id]);
    assert.equal(lostAckCount.rows[0].n,1,'Lost mark ACK must not create a retry job');

    const lostAckRestartScript=[
      'from agents.windows.agent import DryRunDriver,Journal,PrintAgent',
      'from agents.windows.backend_http import HttpBackendClient',
      'import json,os,sys',
      'j=Journal(sys.argv[2]);d=DryRunDriver()',
      'try:',
      ' a=PrintAgent(HttpBackendClient(sys.argv[1],os.environ["AUTO_IN_AGENT_TOKEN"]),j,d)',
      ' recovered=a.recover()',
      ' result=a.run_once()',
      ' print(json.dumps({"recovered":recovered,"result":result,"driver_calls":d.calls}))',
      'finally:j.close()'
    ].join('\n');
    const lostAckRestart=await run('python3',['-c',lostAckRestartScript,url,lostAckJournal],{env:pythonEnv});
    const restartOutput=JSON.parse(lostAckRestart.stdout.trim());
    assert.equal(restartOutput.result.status,'NO_JOB',JSON.stringify(restartOutput));
    assert.equal(restartOutput.driver_calls,0,'Restart after lost ACK must not resend');
    assert.equal((await state(lostAck.jobId)).state,'UNKNOWN');

    const crash=await orderReadyToDryRun('crash');
    // Simulated process death AFTER committed SENDING, BEFORE any dry-run driver.
    // A separate Python process will recover UNKNOWN without calling send().
    const journalPath=join(scratch,'crash.sqlite');
    const crashScript=[
      'from agents.windows.agent import Journal,DryRunDriver,PrintAgent,SimulatedCrash',
      'from agents.windows.backend_http import HttpBackendClient',
      'import os,sys',
      'j=Journal(sys.argv[2])',
      'a=PrintAgent(HttpBackendClient(sys.argv[1],os.environ["AUTO_IN_AGENT_TOKEN"]),j,DryRunDriver())',
      'try:',
      ' try:a.run_once(fault_at="after_mark_sending")',
      ' except SimulatedCrash:print("EXPECTED_CRASH")',
      'finally:j.close()'
    ].join('\n');
    const before=await run('python3',['-c',crashScript,url,journalPath],{env:pythonEnv});
    assert.match(before.stdout,/EXPECTED_CRASH/);
    assert.equal((await state(crash.jobId)).state,'SENDING');
    const recoverScript=[
      'from agents.windows.agent import Journal,DryRunDriver,PrintAgent',
      'from agents.windows.backend_http import HttpBackendClient',
      'import json,os,sys',
      'j=Journal(sys.argv[2]);d=DryRunDriver()',
      'try:',
      ' a=PrintAgent(HttpBackendClient(sys.argv[1],os.environ["AUTO_IN_AGENT_TOKEN"]),j,d)',
      ' recovered=a.recover()',
      ' print(json.dumps({"recovered":recovered,"driver_calls":d.calls}))',
      'finally:j.close()'
    ].join('\n');
    const recovered=await run('python3',['-c',recoverScript,url,journalPath],{env:pythonEnv});
    const recovery=JSON.parse(recovered.stdout.trim());
    assert.deepEqual(recovery.recovered,[crash.jobId]);
    assert.equal(recovery.driver_calls,0);
    assert.equal((await state(crash.jobId)).state,'UNKNOWN');
    assert.equal(Number((await state(crash.jobId)).verified_sheets),0);
    const refuseUnknownAsPaper=await post('/api/v1/print-jobs/'+crash.jobId+'/verify-paper',{
      evidence_kind:'staff_inspected',physical_sheets:2,
      note:'simulation unknown cannot prove paper',idempotency_key:'fake-paper-unknown'
    },login.token);
    assert.notEqual(refuseUnknownAsPaper.statusCode,200);
    assert.equal(code(refuseUnknownAsPaper.json()),'SIMULATION_NOT_PAPER');
    const noRetry=await run('python3',['-m','agents.windows.cli','--api-base-url',url,
      '--journal',journalPath],{env:pythonEnv});
    assert.equal(JSON.parse(noRetry.stdout.trim()).result.status,'NO_JOB');
    assert.equal((await state(crash.jobId)).state,'UNKNOWN');
    const outstanding=await pool.query(
      'SELECT COUNT(*)::int AS jobs FROM core_print_jobs WHERE order_id IN ($1,$2,$3)',
      [normal.id,crash.id,lostAck.id]);
    assert.equal(outstanding.rows[0].jobs,3,'DryRun, crash-UNKNOWN and lost-ACK UNKNOWN cannot mint retry jobs');
  }finally{
    if(app)await app.close();
    if(pool)await pool.end();
    await rm(scratch,{recursive:true,force:true});
  }
});
