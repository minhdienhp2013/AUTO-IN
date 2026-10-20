import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile as execFileCallback} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {chmod, mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import pg from 'pg';
import {buildIntegratedApp} from '../../../backend/composition/runtime.ts';
import {asSqlPool, assertIsolatedSimulationDatabase} from '../../../backend/composition/postgres.ts';
import {createCoreModule} from '../../../backend/core/factory.ts';

const execFile=promisify(execFileCallback);
const run=async (program,args,options={})=>execFile(program,args,{
  cwd:process.cwd(),timeout:60000,maxBuffer:1024*1024,...options
});
const allowedErrorCodes=new Set(['STALE_PRINT_EVIDENCE','DOCUMENT_EVIDENCE_UNVERIFIED']);
const stageByRoute=Object.freeze({
  '/internal/v1/print-jobs/claim':'claim',
  '/internal/v1/print-jobs/:job_id/preflight':'preflight'
});
const code=payload=>payload?.error?.code;
const secureHeaders=token=>({authorization:'Bearer '+token});

test('AI0 targeted source-tamper runtime diagnostic',{timeout:300000},async()=>{
  const urls=[process.env.DATABASE_URL,process.env.TEST_DATABASE_URL,
    process.env.AUTOIN_TEST_DATABASE_URL];
  let scratch,pool,app,observationWritten=false,failure=null,cleanupFailed=false;
  const observations=[];
  try{
    assert.ok(urls.every(value=>typeof value==='string'&&value.length>0));
    assert.ok(urls.every(value=>value===urls[0]));
    assert.equal(process.env.AUTOIN_OPERATION_MODE,'simulation');
    assert.equal(process.env.AUTOIN_ALLOW_PG_ACCEPTANCE,'YES_ISOLATED_TEST_DB');
    assertIsolatedSimulationDatabase(urls[0]);
    const evidencePath=process.env.AUTOIN_SAFE_DIAGNOSTIC_FILE;
    assert.ok(typeof evidencePath==='string'&&evidencePath.length>0);

    scratch=await mkdtemp(join(tmpdir(),'autoin-source-tamper-diagnostic-'));
    const cert=join(scratch,'localhost.crt'),key=join(scratch,'localhost.key');
    const inputRoot=join(scratch,'input'),artifactRoot=join(scratch,'output');
    const journalPath=join(scratch,'source-tamper.sqlite');
    await mkdir(inputRoot,{mode:0o700});
    await mkdir(artifactRoot,{mode:0o700});
    await run('openssl',['req','-x509','-nodes','-newkey','rsa:2048','-days','1',
      '-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1',
      '-keyout',key,'-out',cert]);
    await run('python3',['-c',
      'import fitz,sys;d=fitz.open();p=d.new_page(width=120,height=160);p.draw_rect(fitz.Rect(10,10,70,70));d.save(sys.argv[1]);d.close()',
      join(inputRoot,'fixture.pdf')]);

    pool=new pg.Pool({connectionString:urls[0],connectionTimeoutMillis:5000});
    const sqlPool=asSqlPool(pool);
    const core=createCoreModule({pool:sqlPool});
    const shop='autoin-test-source-tamper-'+randomUUID();
    const customer='synthetic-customer';
    const password='private-synthetic-'+randomUUID();
    const agentToken=randomUUID()+randomUUID();
    const customerToken=randomUUID()+randomUUID();
    await pool.query('INSERT INTO core_shop_settings(shop_id,open_at,close_at) VALUES($1,$2,$3)',
      [shop,'00:00','24:00']);
    await core.auth.bootstrapOwner({shop_id:shop,username:'owner',password,bootstrap_enabled:true});
    const login=await core.auth.login(shop,'owner',password);
    app=buildIntegratedApp({pool:sqlPool,tls:{
      key:await readFile(key),cert:await readFile(cert)
    },identities:[
      {token:customerToken,principal:{id:'verified-customer',shop_id:shop,
        customer_id:customer,role:'customer',verified:true}},
      {token:agentToken,principal:{id:'agent-local',shop_id:shop,
        printer_ids:['RMP7000'],role:'print_agent',verified:true}}
    ],approvedDocumentEvidence:{artifactRoot,python:'python3',timeoutMs:20000},
      trustedPrintEvidence:{artifactRoot,printerCapabilities:{simulation_only:true,
        printer_id:'RMP7000',queue_name:'RMP7000'}}});

    app.addHook('onSend',async(request,reply,payload)=>{
      const stage=stageByRoute[request.routeOptions.url];
      if(!stage)return payload;
      let errorCode='OTHER';
      if(reply.statusCode>=400)try{
          const raw=Buffer.isBuffer(payload)?payload.toString('utf8'):
            (typeof payload==='string'?payload:null);
          if(raw!==null&&Buffer.byteLength(raw)<=4096){
            const candidate=code(JSON.parse(raw));
            if(allowedErrorCodes.has(candidate))errorCode=candidate;
          }
        }catch{}
      observations.push({stage,http_status:Number.isInteger(reply.statusCode)?reply.statusCode:null,
        error_code:errorCode});
      return payload;
    });

    const post=(path,payload,token)=>app.inject({method:'POST',url:path,payload,
      headers:secureHeaders(token)});
    const orderResponse=await post('/api/v1/orders',{
      customer_id:customer,request_data:{documents:[{
        artifact_name:'fixture.pdf',copies:2,duplex:false,paper:'A4'
      }]},idempotency_key:'create-source-tamper-diagnostic'
    },login.token);
    assert.equal(orderResponse.statusCode,200);
    const orderId=orderResponse.json().order_id;
    await run(process.execPath,['--import','tsx','scripts/process-order.ts',shop,orderId],{
      env:{...process.env,DATABASE_URL:urls[0],AUTOIN_INPUT_ROOT:inputRoot,
        AUTOIN_ARTIFACT_ROOT:artifactRoot,AUTOIN_PROCESSOR_ID:'source-tamper-diagnostic',
        AUTOIN_PYTHON:'python3'}
    });
    const preview=await app.inject({method:'GET',url:'/api/v1/orders/'+orderId,
      headers:secureHeaders(login.token)});
    assert.equal(preview.statusCode,200);
    const evidence=preview.json().current?.print_evidence;
    assert.ok(evidence&&/^[a-f0-9]{64}$/.test(evidence.evidence_sha256));
    const review=await post('/api/v1/orders/'+orderId+'/preview-reviews',{
      expected_revision:2,expected_request_hash:orderResponse.json().request_hash,
      expected_evidence_sha256:evidence.evidence_sha256,decision:'checked',
      idempotency_key:'preview-review-source-tamper-diagnostic'
    },login.token);
    assert.equal(review.statusCode,200);
    const confirmation=await post('/api/v1/orders/'+orderId+'/confirmations',{
      expected_revision:2,kind:'request',idempotency_key:'confirm-source-tamper-diagnostic'
    },customerToken);
    assert.equal(confirmation.statusCode,200);
    const approval=await post('/api/v1/orders/'+orderId+'/approvals',{
      expected_revision:2,acknowledge_deposit_shortage:false,
      idempotency_key:'approve-source-tamper-diagnostic'
    },login.token);
    assert.equal(approval.statusCode,200);
    const jobId=approval.json().job_id;

    const anchor=await pool.query(
      'SELECT artifact_ref FROM ai0_verified_plan_manifests WHERE shop_id=$1 AND order_id=$2 AND revision=2',
      [shop,orderId]);
    assert.equal(anchor.rows.length,1);
    const manifest=JSON.parse(await readFile(join(artifactRoot,anchor.rows[0].artifact_ref),'utf8'));
    const sourcePath=join(artifactRoot,manifest.files[0].source_artifact_ref);
    await chmod(sourcePath,0o600);
    await writeFile(sourcePath,Buffer.from('synthetic altered source bytes'));

    await app.listen({host:'127.0.0.1',port:0});
    const address=app.server.address();
    assert.ok(address&&typeof address!=='string');
    const agentEnv={...process.env,AUTO_IN_AGENT_TOKEN:agentToken,
      SSL_CERT_FILE:cert,PYTHONPATH:process.cwd(),PYTHONNOUSERSITE:'1'};
    let childOutput='',childExitCode=null;
    try{
      const child=await run('python3',['-m','agents.windows.cli','--api-base-url',
        'https://127.0.0.1:'+address.port,'--journal',journalPath],{env:agentEnv});
      childOutput=child.stdout;
      childExitCode=0;
    }catch(error){
      childOutput=typeof error.stdout==='string'?error.stdout:'';
      childExitCode=Number.isInteger(error.code)?error.code:null;
    }

    assert.ok(observations.length>0,'Source-tamper request must produce an observed claim/preflight response');
    const errorObservations=observations.filter(item=>item.http_status===null||item.http_status>=400);
    const observed=errorObservations[0]??observations[0];
    await writeFile(evidencePath,JSON.stringify(observed),{mode:0o600,flag:'wx'});
    observationWritten=true;
    assert.equal(errorObservations.length,1);
    assert.deepEqual(observed,{stage:'claim',http_status:409,error_code:'STALE_PRINT_EVIDENCE'});

    const agentResult=JSON.parse(childOutput.trim());
    assert.equal(childExitCode,2);
    assert.equal(agentResult.result?.status,'UNKNOWN');
    assert.equal(agentResult.result?.reason_code,'AGENT_UNVERIFIED_FAILURE');
    assert.equal((await pool.query('SELECT state FROM core_print_jobs WHERE id=$1',[jobId]))
      .rows[0]?.state,'NOT_SENT');
    const journal=await run('python3',['-c',
      'import sqlite3,sys;d=sqlite3.connect(sys.argv[1]);print(d.execute("SELECT COUNT(*) FROM jobs").fetchone()[0])',
      journalPath]);
    assert.equal(journal.stdout.trim(),'0');
    const jobCount=await pool.query(
      'SELECT COUNT(*)::int AS n FROM core_print_jobs WHERE order_id=$1',[orderId]);
    assert.equal(jobCount.rows[0]?.n,1);
  }catch{
    failure=observationWritten?'diagnostic unresolved':'diagnostic evidence unavailable';
  }finally{
    if(app)try{await app.close();}catch{cleanupFailed=true;}
    if(pool)try{await pool.end();}catch{cleanupFailed=true;}
    if(scratch)try{await rm(scratch,{recursive:true,force:true});}catch{cleanupFailed=true;}
  }
  if(cleanupFailed&&!failure)failure=observationWritten?'diagnostic unresolved':'diagnostic evidence unavailable';
  if(failure)throw new Error(failure);
});
