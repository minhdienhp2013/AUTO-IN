import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {chmod,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import pg from 'pg';
import {asSqlPool,assertIsolatedSimulationDatabase} from '../../../backend/composition/postgres.ts';
import {buildIntegratedApp} from '../../../backend/composition/runtime.ts';
import {createCoreModule} from '../../../backend/core/factory.ts';
import {createSyntheticZaloRuntime} from '../../../backend/composition/zalo-simulation.ts';

const url=process.env.TEST_DATABASE_URL;
const uuid=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

test('TN005 Fastify trigger queues only current SUGGESTED scope; replay/skip/timeout keep authority zero',{
  skip:!url?'TEST_DATABASE_URL missing: TN005 question trigger NOT RUN':false,
  timeout:180_000
},async()=>{
  assertIsolatedSimulationDatabase(url);
  const tmp=await mkdtemp(join(tmpdir(),'autoin-tn005-trigger-'));
  const root=join(tmp,'inbound');
  const pool=new pg.Pool({connectionString:url,connectionTimeoutMillis:5000,max:8});
  const id=randomUUID(),shop='autoin-test-tn005-trigger-'+id,oa='oa-'+id;
  const scope={shop_id:shop,oa_id:oa},password='fixture-'+id,sql=asSqlPool(pool);
  let app;
  const priorPython=process.env.AUTOIN_PYTHON;
  try{
    await mkdir(root,{mode:0o700});
    const core=createCoreModule({pool:sql});
    await core.auth.bootstrapOwner({shop_id:shop,username:'owner',password,bootstrap_enabled:true});
    const login=await core.auth.login(shop,'owner',password);
    const zaloRuntime=createSyntheticZaloRuntime(pool,{kind:'synthetic_fixture',
      shop_id:shop,oa_id:oa,fixture_key:randomUUID()+randomUUID()},
      {store:core.store,artifactRoot:root});
    const queueCalls=[];
    app=buildIntegratedApp({pool:sql,syntheticArtifactIngest:{artifactRoot:root,scope},
      firstPageQuestionQueue:async input=>{
        queueCalls.push(structuredClone(input));
        return zaloRuntime.queue_first_page_suggested_question(input);
      }});
    await app.ready();

    async function createOrder(label,kind){
      const file=join(tmp,label+'.pdf');
      const source=kind==='blank'
        ?'import fitz,sys;d=fitz.open();d.new_page();d.save(sys.argv[1])'
        :'import fitz,sys;d=fitz.open();p=d.new_page();p.insert_text((30,60),"BAI TAP TOAN\\nCau 1: tinh\\nHo ten hoc sinh: A");d.save(sys.argv[1])';
      const made=spawnSync(process.env.AUTOIN_PYTHON??'python3',['-c',source,file],
        {cwd:process.cwd(),timeout:10_000});
      assert.equal(made.status,0,'synthetic PDF fixture');
      const bytes=await readFile(file),event='evt-'+label+'-'+id;
      const customer='customer-'+label+'-'+id,conversation='chat-'+label+'-'+id;
      await pool.query('INSERT INTO zalo_inbound_events '+
        '(oa_id,event_id,conversation_id,customer_id,occurred_at,payload_json) '+
        'VALUES($1,$2,$3,$4,now(),$5::jsonb)',[oa,event,conversation,customer,
          JSON.stringify({kind:'file',filename:'source.pdf',customer_id:customer,conversation_id:conversation})]);
      const headers={authorization:'Bearer '+login.token};
      const imported=await app.inject({method:'POST',url:'/internal/simulation/inbound-artifacts',
        headers,payload:{event_id:event,filename:'source.pdf',content_base64:bytes.toString('base64')}});
      assert.equal(imported.statusCode,201,imported.body);
      const draft=await app.inject({method:'POST',url:'/internal/simulation/inbound-artifacts/'+event+'/draft',
        headers,payload:{paper:'A4',copies:1,duplex:false}});
      assert.equal(draft.statusCode,201,draft.body);
      return {order_id:draft.json().order_id,customer,conversation,headers,
        request_data:(await pool.query('SELECT request_data FROM core_revisions '+
          'WHERE order_id=$1 AND revision=1',[draft.json().order_id])).rows[0].request_data};
    }

    const suggested=await createOrder('suggested','text');
    const unknown=await createOrder('unknown','blank');
    const timeout=await createOrder('timeout','text');
    const ids=[suggested.order_id,unknown.order_id,timeout.order_id];
    const guards=async()=> (await pool.query(
      'SELECT (SELECT count(*)::int FROM core_revisions WHERE order_id=ANY($1::uuid[]) AND plan IS NOT NULL) ready_revisions,'+
      '(SELECT count(*)::int FROM core_confirmations WHERE order_id=ANY($1::uuid[])) confirmations,'+
      '(SELECT count(*)::int FROM core_approvals WHERE order_id=ANY($1::uuid[])) approvals,'+
      '(SELECT count(*)::int FROM core_print_jobs WHERE order_id=ANY($1::uuid[])) print_jobs',
      [ids])).rows[0];
    const before=await guards();
    assert.deepEqual(before,{ready_revisions:0,confirmations:0,approvals:0,print_jobs:0});

    const endpoint=(order,revision=1)=>'/internal/simulation/orders/'+order.order_id+
      '/revisions/'+revision+'/first-page-suggestion';
    const first=await app.inject({method:'POST',url:endpoint(suggested),headers:suggested.headers,
      payload:{shop_id:'attacker-shop',oa_id:'attacker-oa',customer_id:'attacker',
        conversation_id:'attacker-chat',request_hash:'f'.repeat(64),source_sha256:'e'.repeat(64)}});
    assert.equal(first.statusCode,200,first.body);
    assert.equal(first.json().metadata.status,'SUGGESTED');
    assert.equal(first.json().suggested_question_outbox.status,'queued');
    const stableId=first.json().suggested_question_outbox.outbound_id;
    assert.match(stableId,uuid);
    assert.equal(queueCalls.length,1);
    assert.deepEqual(queueCalls[0].scope,{shop_id:shop,order_id:suggested.order_id,
      revision:1,oa_id:oa,customer_id:suggested.customer,conversation_id:suggested.conversation},
      'all customer/OA/conversation scope is read from trusted PostgreSQL');
    assert.equal(queueCalls[0].outbound_id,stableId);
    let rows=(await pool.query('SELECT outbound_id::text,status,shop_id,oa_id,order_id::text,'+
      'customer_id,conversation_id,idempotency_key FROM core_tn005_suggested_outbox WHERE order_id=$1',
      [suggested.order_id])).rows;
    assert.equal(rows.length,1);
    assert.deepEqual(rows[0],{outbound_id:stableId,status:'QUEUED',shop_id:shop,oa_id:oa,
      order_id:suggested.order_id,customer_id:suggested.customer,
      conversation_id:suggested.conversation,idempotency_key:'tn005:'+stableId});

    const replay=await app.inject({method:'POST',url:endpoint(suggested),headers:suggested.headers});
    assert.equal(replay.statusCode,200,replay.body);
    assert.equal(replay.json().suggested_question_outbox.outbound_id,stableId);
    assert.equal(queueCalls.length,2,'same authenticated request replays through AI2 hook');
    assert.equal(queueCalls[1].outbound_id,stableId);
    assert.equal((await pool.query('SELECT count(*)::int n FROM core_tn005_suggested_outbox '+
      'WHERE order_id=$1',[suggested.order_id])).rows[0].n,1,
      'deterministic outbound id and AI1 CAS preserve exactly one row');

    const notSuggested=await app.inject({method:'POST',url:endpoint(unknown),headers:unknown.headers});
    assert.equal(notSuggested.statusCode,200,notSuggested.body);
    assert.equal(notSuggested.json().metadata.status,'UNKNOWN');
    assert.equal(notSuggested.json().suggested_question_outbox.status,'skipped');
    assert.equal(queueCalls.length,2,'UNKNOWN never calls AI2 question queue');
    assert.equal((await pool.query('SELECT count(*)::int n FROM core_tn005_suggested_outbox '+
      'WHERE order_id=$1',[unknown.order_id])).rows[0].n,0);

    const other='autoin-test-tn005-trigger-other-'+id;
    await core.auth.bootstrapOwner({shop_id:other,username:'owner',password,bootstrap_enabled:true});
    const otherLogin=await core.auth.login(other,'owner',password);
    const foreign=await app.inject({method:'POST',url:endpoint(suggested),
      headers:{authorization:'Bearer '+otherLogin.token}});
    assert.equal(foreign.statusCode,403);
    assert.equal(queueCalls.length,2,'cross-shop staff cannot reach queue hook');

    await core.service.revise(login.principal,suggested.order_id,{expected_revision:1,
      request_data:suggested.request_data,idempotency_key:'trigger-revision-'+id});
    const stale=await app.inject({method:'POST',url:endpoint(suggested),headers:suggested.headers});
    assert.equal(stale.statusCode,409);
    assert.equal(queueCalls.length,2,'old revision is rejected before the hook');
    const revised=await app.inject({method:'POST',url:endpoint(suggested,2),headers:suggested.headers});
    assert.equal(revised.statusCode,200,revised.body);
    assert.equal(revised.json().metadata.status,'SUGGESTED');
    assert.equal(revised.json().suggested_question_outbox.status,'queued');
    const revisedId=revised.json().suggested_question_outbox.outbound_id;
    assert.match(revisedId,uuid);
    assert.notEqual(revisedId,stableId,'new revision receives a distinct stable outbound id');
    assert.equal(queueCalls.length,3);
    assert.equal(queueCalls[2].scope.revision,2);
    const revisions=(await pool.query('SELECT revision,status,outbound_id::text FROM '+
      'core_tn005_suggested_outbox WHERE order_id=$1 ORDER BY revision',[suggested.order_id])).rows;
    assert.deepEqual(revisions,[
      {revision:1,status:'QUEUED',outbound_id:stableId},
      {revision:2,status:'QUEUED',outbound_id:revisedId}
    ],'new revision is rebound to its own advisory and never reuses stale evidence');

    const fakePython=join(tmp,'timeout-python');
    await writeFile(fakePython,'#!/bin/sh\nsleep 20\n',{mode:0o700});
    await chmod(fakePython,0o700);
    process.env.AUTOIN_PYTHON=fakePython;
    const timed=await app.inject({method:'POST',url:endpoint(timeout),headers:timeout.headers});
    assert.equal(timed.statusCode,503,timed.body);
    assert.equal(timed.json().error.code,'CLASSIFIER_TIMEOUT');
    assert.equal(queueCalls.length,3,'classifier timeout never reaches AI2 queue');
    assert.equal((await pool.query('SELECT count(*)::int n FROM ai0_first_page_suggestions '+
      'WHERE order_id=$1',[timeout.order_id])).rows[0].n,0);
    assert.equal((await pool.query('SELECT count(*)::int n FROM core_tn005_suggested_outbox '+
      'WHERE order_id=$1',[timeout.order_id])).rows[0].n,0);

    assert.equal((await pool.query('SELECT count(*)::int n FROM zalo_outbound '+
      'WHERE shop_id=$1 AND oa_id=$2',[shop,oa])).rows[0].n,0,
      'question is queued only in advisory outbox; no ordinary Zalo sender');
    assert.equal((await zaloRuntime.tick_outbound()).disabled,true,
      'simulation runtime has no provider sender configured');
    assert.deepEqual(await guards(),before,
      'TN005 metadata/outbox never changes READY, confirmation, approval, or print state');
    console.log('PASS TN005 Fastify trigger: stable replay, trusted scope, UNKNOWN/cross-shop/stale/timeout skipped, 0 READY/confirmation/approval/print mutations, provider disabled');
  }finally{
    if(priorPython===undefined)delete process.env.AUTOIN_PYTHON;
    else process.env.AUTOIN_PYTHON=priorPython;
    if(app)await app.close();
    await pool.end();
    await rm(tmp,{recursive:true,force:true});
  }
});
