import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,rm,chmod,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import pg from 'pg';
import {asSqlPool,assertIsolatedSimulationDatabase} from '../../../backend/composition/postgres.ts';
import {createCoreModule} from '../../../backend/core/factory.ts';
import {buildIntegratedApp} from '../../../backend/composition/runtime.ts';
import {classifyBoundFirstPage,isolatedFirstPageWorker} from '../../../backend/composition/first-page-suggestion.ts';
import {previewBoundFirstPageQuestion} from '../../../backend/composition/first-page-question-port.ts';

const url=process.env.TEST_DATABASE_URL;
test('TN005 real Fastify/PG: sealed page0, tenant and revision CAS, timeout and no print mutation',{
  skip:!url?'TEST_DATABASE_URL missing: TN005 PG/HTTP NOT RUN':false,timeout:120_000
},async()=>{
  assertIsolatedSimulationDatabase(url);
  const tmp=await mkdtemp(join(tmpdir(),'autoin-first-page-'));
  const root=join(tmp,'inbound'),pdfPath=join(tmp,'source.pdf');
  const pool=new pg.Pool({connectionString:url,connectionTimeoutMillis:5000});
  const second=new pg.Pool({connectionString:url,connectionTimeoutMillis:5000});
  const id=randomUUID(),shop='autoin-test-first-page-'+id,oa='oa-'+id;
  const scope={shop_id:shop,oa_id:oa},password='fixture-'+id;
  let app;
  try{
    await mkdir(root,{mode:0o700});
    const python=process.env.AUTOIN_PYTHON??'python3';
    const made=spawnSync(python,['-c',
      'import fitz,sys;d=fitz.open();a=d.new_page();a.insert_text((30,60),"BAI TAP TOAN\\nCau 1: tinh\\nHo ten hoc sinh: A");b=d.new_page();b.insert_text((30,60),"HOP DONG\\nBen A\\nBen B");d.save(sys.argv[1])',
      pdfPath],{cwd:process.cwd(),timeout:10000});
    assert.equal(made.status,0,'PyMuPDF synthetic PDF fixture');
    const pdf=await readFile(pdfPath);
    const core=createCoreModule({pool:asSqlPool(pool)});
    await core.auth.bootstrapOwner({shop_id:shop,username:'owner',password,bootstrap_enabled:true});
    const login=await core.auth.login(shop,'owner',password);
    app=buildIntegratedApp({pool:asSqlPool(pool),syntheticArtifactIngest:{artifactRoot:root,scope}});
    await app.ready();
    const event='evt-'+id,customer='customer-'+id,conversation='chat-'+id;
    await pool.query('INSERT INTO zalo_inbound_events '+
      '(oa_id,event_id,conversation_id,customer_id,occurred_at,payload_json) '+
      'VALUES($1,$2,$3,$4,now(),$5::jsonb)',[oa,event,conversation,customer,
      JSON.stringify({kind:'file',filename:'source.pdf',customer_id:customer,conversation_id:conversation})]);
    const auth={authorization:'Bearer '+login.token};
    const imported=await app.inject({method:'POST',url:'/internal/simulation/inbound-artifacts',
      headers:auth,payload:{event_id:event,filename:'source.pdf',content_base64:pdf.toString('base64')}});
    assert.equal(imported.statusCode,201,imported.body);
    const draft=await app.inject({method:'POST',url:'/internal/simulation/inbound-artifacts/'+event+'/draft',
      headers:auth,payload:{paper:'A4',copies:1,duplex:false}});
    assert.equal(draft.statusCode,201,draft.body);
    const orderId=draft.json().order_id;
    const endpoint=rev=>'/internal/simulation/orders/'+orderId+'/revisions/'+rev+'/first-page-suggestion';
    assert.equal((await app.inject({method:'POST',url:endpoint(1)})).statusCode,401);
    const other='autoin-test-first-page-other-'+id;
    await core.auth.bootstrapOwner({shop_id:other,username:'owner',password,bootstrap_enabled:true});
    const otherSession=await core.auth.login(other,'owner',password);
    assert.equal((await app.inject({method:'POST',url:endpoint(1),
      headers:{authorization:'Bearer '+otherSession.token}})).statusCode,403);
    const response=await app.inject({method:'POST',url:endpoint(1),headers:auth});
    assert.equal(response.statusCode,200,response.body);
    assert.equal(response.headers['cache-control'],'no-store');
    const result=response.json();
    assert.deepEqual({status:result.metadata.status,category:result.metadata.category,
      analyzed_page_count:result.metadata.analyzed_page_count},
      {status:'SUGGESTED',category:'WORKSHEET',analyzed_page_count:1});
    assert.ok(!JSON.stringify(result).includes('Cau 1'));
    assert.deepEqual((await app.inject({method:'POST',url:endpoint(1),headers:auth})).json(),result,
      'replay returns advisory metadata without another classification');
    const questionUrl='/internal/simulation/orders/'+orderId+'/revisions/1/first-page-question';
    assert.equal((await app.inject({method:'GET',url:questionUrl})).statusCode,401);
    const foreignQuestion=await app.inject({method:'GET',url:questionUrl,
      headers:{authorization:'Bearer '+otherSession.token}});
    assert.equal(foreignQuestion.statusCode,200);
    assert.equal(foreignQuestion.json().used_suggestion,false);
    const question=await app.inject({method:'GET',url:questionUrl,headers:auth});
    assert.equal(question.statusCode,200,question.body);
    assert.equal(question.headers['cache-control'],'no-store');
    assert.equal(question.json().used_suggestion,true,question.body);
    assert.match(question.json().text,/phiếu học tập/);
    assert.ok(!question.body.includes('Cau 1'));
    const stored=(await pool.query('SELECT request_hash,artifact_sha256,metadata '+
      'FROM ai0_first_page_suggestions WHERE shop_id=$1 AND order_id=$2',[shop,orderId])).rows;
    assert.equal(stored.length,1);
    assert.equal(stored[0].request_hash,result.request_hash);
    assert.equal(stored[0].artifact_sha256,result.artifact_sha256);
    const requestData=(await pool.query('SELECT request_data FROM core_revisions '+
      'WHERE order_id=$1 AND revision=1',[orderId])).rows[0].request_data;
    // Competing Core revision commits after the consistent read but before
    // the final current-state check: discard the suggestion, never enqueue.
    let raced=false;const db=asSqlPool(second);
    const racePool={...db,async query(sql,args){
      if(!raced&&sql.startsWith('SELECT o.active_revision,r.request_hash,a.sha256')){
        raced=true;
        await core.service.revise(login.principal,orderId,{expected_revision:1,
          request_data:requestData,idempotency_key:'test-read-race-'+id});
      }
      return db.query(sql,args);
    }};
    const racedQuestion=await previewBoundFirstPageQuestion(racePool,root,scope,
      login.principal,orderId,1);
    assert.equal(raced,true);
    assert.equal(racedQuestion.used_suggestion,false);
    assert.equal((await app.inject({method:'POST',url:endpoint(1),headers:auth})).statusCode,409);
    const staleQuestion=await app.inject({method:'GET',url:questionUrl,headers:auth});
    assert.equal(staleQuestion.statusCode,200);
    assert.equal(staleQuestion.json().used_suggestion,false);
    // A competing revision during the child must invalidate the DB insert.
    await assert.rejects(classifyBoundFirstPage(asSqlPool(second),root,scope,login.principal,
      orderId,2,async()=>{
        await core.service.revise(login.principal,orderId,{expected_revision:2,request_data:requestData,
          idempotency_key:'test-race-'+id});
        return result.metadata;
      }),{code:'SUGGESTION_STALE_OR_CONCURRENT'});
    assert.equal((await pool.query('SELECT count(*)::int n FROM ai0_first_page_suggestions '+
      'WHERE order_id=$1 AND revision=2',[orderId])).rows[0].n,0);
    const source=(await pool.query('SELECT artifact_ref FROM ai0_inbound_document_artifacts '+
      'WHERE shop_id=$1 AND oa_id=$2 AND event_id=$3',[shop,oa,event])).rows[0].artifact_ref;
    const file=join(root,source);
    await chmod(file,0o600);await writeFile(file,Buffer.from('tampered source'));
    assert.equal((await app.inject({method:'POST',url:endpoint(3),headers:auth})).statusCode,409);
    const changedSourceQuestion=await app.inject({method:'GET',url:questionUrl,headers:auth});
    assert.equal(changedSourceQuestion.json().used_suggestion,false);
    for(const table of ['core_confirmations','core_approvals','core_print_jobs'])
      assert.equal((await pool.query('SELECT count(*)::int n FROM '+table+' WHERE order_id=$1',[orderId])).rows[0].n,0);
    // A deliberately sleeping executable verifies the parent's hard kill.
    const fake=join(tmp,'sleep-python');
    await writeFile(fake,'#!/bin/sh\nsleep 20\n',{mode:0o700});
    const old=process.env.AUTOIN_PYTHON;process.env.AUTOIN_PYTHON=fake;
    try{await assert.rejects(isolatedFirstPageWorker(Buffer.from('x'),'pdf','0'.repeat(64),200),
      {code:'CLASSIFIER_TIMEOUT'})}finally{
      if(old===undefined)delete process.env.AUTOIN_PYTHON;else process.env.AUTOIN_PYTHON=old;
    }
    console.log('PASS TN005 PG/HTTP page0=true cross_shop=403 stale=409 question_read_race=generic timeout=bounded print_jobs=0');
  }finally{
    if(app)await app.close();await pool.end();await second.end();
    await rm(tmp,{recursive:true,force:true});
  }
});
