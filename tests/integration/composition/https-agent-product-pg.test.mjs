import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile as execFileCallback} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {mkdtemp, mkdir, readFile, rm} from 'node:fs/promises';
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
  timeout:120000
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
    ]});
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
    const done=await state(normal.jobId);
    assert.equal(done.state,'SIMULATED_DONE');
    assert.equal(done.mode_at_send,'simulation');
    assert.equal(Number(done.verified_sheets),0);
    const refuseDelivery=await post('/api/v1/orders/'+normal.id+'/deliveries',{
      expected_revision:2,physical_sheets:1,idempotency_key:'delivery-normal'
    },login.token);
    assert.notEqual(refuseDelivery.statusCode,200);
    assert.equal(code(refuseDelivery.json()),'PAPER_NOT_VERIFIED');
    const repeat=await run('python3',agentArgs,{env:pythonEnv});
    assert.equal(JSON.parse(repeat.stdout).result.status,'NO_JOB');
    assert.equal((await state(normal.jobId)).state,'SIMULATED_DONE');

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
    const noRetry=await run('python3',['-m','agents.windows.cli','--api-base-url',url,
      '--journal',journalPath],{env:pythonEnv});
    assert.equal(JSON.parse(noRetry.stdout.trim()).result.status,'NO_JOB');
    assert.equal((await state(crash.jobId)).state,'UNKNOWN');
    const outstanding=await pool.query(
      'SELECT COUNT(*)::int AS jobs FROM core_print_jobs WHERE order_id IN ($1,$2)',
      [normal.id,crash.id]);
    assert.equal(outstanding.rows[0].jobs,2,'Neither UNKNOWN nor DryRun can mint a retry job');
  }finally{
    if(app)await app.close();
    if(pool)await pool.end();
    await rm(scratch,{recursive:true,force:true});
  }
});
