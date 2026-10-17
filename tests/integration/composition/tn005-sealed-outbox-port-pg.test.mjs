import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {chmod,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import pg from 'pg';
import {asSqlPool,assertIsolatedSimulationDatabase} from '../../../backend/composition/postgres.ts';
import {createVerifiedSyntheticTn005Outbox} from '../../../backend/composition/tn005-sealed-outbox-port.ts';
import {buildIntegratedApp} from '../../../backend/composition/runtime.ts';
import {createCoreModule} from '../../../backend/core/factory.ts';
import {createSyntheticZaloRuntime} from '../../../backend/composition/zalo-simulation.ts';

const url=process.env.TEST_DATABASE_URL;
const code=(expected)=>error=>error?.code===expected;
test('TN005 composition binds AI1 CAS to verified sealed bytes; fake sender only',{
  skip:!url?'TEST_DATABASE_URL missing: TN005 sealed outbox composition NOT RUN':false,
  timeout:180_000
},async()=>{
  assertIsolatedSimulationDatabase(url);
  const tmp=await mkdtemp(join(tmpdir(),'autoin-tn005-outbox-'));
  const root=join(tmp,'inbound');
  const pool=new pg.Pool({connectionString:url,connectionTimeoutMillis:5000,max:8});
  const id=randomUUID(),shop='autoin-test-tn005-port-'+id,oa='oa-'+id;
  const scope={shop_id:shop,oa_id:oa},password='fixture-'+id;
  const sql=asSqlPool(pool);
  let app;
  try{
    await mkdir(root,{mode:0o700});
    const core=createCoreModule({pool:sql});
    await core.auth.bootstrapOwner({shop_id:shop,username:'owner',password,bootstrap_enabled:true});
    const login=await core.auth.login(shop,'owner',password);
    const zaloRuntime=createSyntheticZaloRuntime(pool,{kind:'synthetic_fixture',
      shop_id:shop,oa_id:oa,fixture_key:randomUUID()+randomUUID()},
      {store:core.store,artifactRoot:root});
    app=buildIntegratedApp({pool:sql,syntheticArtifactIngest:{artifactRoot:root,scope}});
    await app.ready();

    async function createOrder(label){
      const pdfPath=join(tmp,label+'.pdf');
      const made=spawnSync(process.env.AUTOIN_PYTHON??'python3',['-c',
        'import fitz,sys;d=fitz.open();p=d.new_page();p.insert_text((30,60),"BAI TAP TOAN\\nCau 1: tinh\\nHo ten hoc sinh: A");d.save(sys.argv[1])',
        pdfPath],{cwd:process.cwd(),timeout:10_000});
      assert.equal(made.status,0,'PyMuPDF synthetic source fixture');
      const bytes=await readFile(pdfPath);
      const event='evt-'+label+'-'+id,customer='customer-'+label+'-'+id;
      const conversation='chat-'+label+'-'+id;
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
      const orderId=draft.json().order_id;
      const suggestion=await app.inject({method:'POST',
        url:'/internal/simulation/orders/'+orderId+'/revisions/1/first-page-suggestion',headers});
      assert.equal(suggestion.statusCode,200,suggestion.body);
      assert.equal(suggestion.json().metadata.status,'SUGGESTED',suggestion.body);
      const question=await app.inject({method:'GET',
        url:'/internal/simulation/orders/'+orderId+'/revisions/1/first-page-question',headers});
      assert.equal(question.statusCode,200,question.body);
      assert.equal(question.json().used_suggestion,true,question.body);
      const ctrl=(await pool.query('SELECT generation::text AS generation,status FROM core_conversation_controls '+
        'WHERE shop_id=$1 AND conversation_id=$2',[shop,conversation])).rows[0];
      assert.equal(ctrl?.status,'AI');
      const outbound_id=randomUUID();
      const input={outbound_id,idempotency_key:'tn005:'+outbound_id,order_id:orderId,
        revision:1,generation:Number(ctrl.generation),request_hash:suggestion.json().request_hash,
        source_sha256:suggestion.json().artifact_sha256,text:question.json().text};
      const artifact=(await pool.query('SELECT artifact_ref FROM ai0_inbound_document_artifacts '+
        'WHERE shop_id=$1 AND oa_id=$2 AND event_id=$3',[shop,oa,event])).rows[0].artifact_ref;
      return {orderId,customer,conversation,headers,requestData:(await pool.query(
        'SELECT request_data FROM core_revisions WHERE order_id=$1 AND revision=1',[orderId])).rows[0].request_data,
        input,artifactPath:join(root,artifact),sealed:await readFile(join(root,artifact))};
    }

    const outbox=createVerifiedSyntheticTn005Outbox({
      pool:sql,store:core.store,artifactRoot:root,scope
    });
    let providerCalls=0;
    const fakeSender={async send_text(conversation,text){
      providerCalls++;
      assert.equal(conversation,valid.conversation);
      assert.equal(text,valid.input.text);
    }};
    const valid=await createOrder('valid');
    const handed=await createOrder('handover');
    const orderIds=[valid.orderId,handed.orderId];
    const guardsBefore=(await pool.query(
      'SELECT (SELECT count(*)::int FROM core_confirmations WHERE order_id=ANY($1::uuid[])) confirmations,'+
      '(SELECT count(*)::int FROM core_approvals WHERE order_id=ANY($1::uuid[])) approvals,'+
      '(SELECT count(*)::int FROM core_print_jobs WHERE order_id=ANY($1::uuid[])) print_jobs',
      [orderIds])).rows[0];
    assert.deepEqual(guardsBefore,{confirmations:0,approvals:0,print_jobs:0},
      'TN005 starts without confirmation, approval, or print mutations');

    // The composition callback must hash both the registered manifest and the
    // actual bytes; altered bytes cannot create an outbox row.
    await chmod(valid.artifactPath,0o600);
    await writeFile(valid.artifactPath,Buffer.from('tampered sealed bytes'));
    await assert.rejects(outbox.enqueue(valid.input),code('SOURCE_HASH_MISMATCH'));
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM core_tn005_suggested_outbox '+
      'WHERE order_id=$1',[valid.orderId])).rows[0].n,0);
    await writeFile(valid.artifactPath,valid.sealed);
    await chmod(valid.artifactPath,0o400);

    const validScope={shop_id:shop,order_id:valid.orderId,revision:1,oa_id:oa,
      customer_id:valid.customer,conversation_id:valid.conversation};
    const composed=await zaloRuntime.queue_first_page_suggested_question({
      outbound_id:valid.input.outbound_id,scope:validScope});
    assert.deepEqual(composed,{status:'queued',outbound_id:valid.input.outbound_id,
      text:valid.input.text});
    assert.deepEqual(await zaloRuntime.queue_first_page_suggested_question({
      outbound_id:valid.input.outbound_id,scope:validScope}),composed,
      'replaying the same adapter call must remain idempotent');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM core_tn005_suggested_outbox '+
      'WHERE order_id=$1',[valid.orderId])).rows[0].n,1);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM zalo_outbound WHERE shop_id=$1 AND oa_id=$2',
      [shop,oa])).rows[0].n,0,'TN005 must not use the ordinary Zalo outbox');
    const beforeForeign=(await pool.query('SELECT count(*)::int AS n FROM core_tn005_suggested_outbox '+
      'WHERE shop_id=$1',[shop])).rows[0].n;
    assert.equal((await zaloRuntime.queue_first_page_suggested_question({
      outbound_id:randomUUID(),scope:{...validScope,shop_id:'other-shop'}})).status,'blocked');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM core_tn005_suggested_outbox '+
      'WHERE shop_id=$1',[shop])).rows[0].n,beforeForeign,
      'cross-shop conversation input must not create an advisory outbox row');

    // AI2's composition path and AI1's lower-level adapter share the same
    // deterministic idempotency key and cannot create duplicate TN005 rows.
    assert.deepEqual(await outbox.enqueue(valid.input),
      {status:'queued',outbound_id:valid.input.outbound_id});
    const lease=await outbox.reserve(valid.input.outbound_id);
    assert.ok(lease);
    assert.equal(await outbox.deliverReserved(lease,fakeSender),'sent');
    assert.equal((await pool.query('SELECT status FROM core_tn005_suggested_outbox '+
      'WHERE outbound_id=$1',[valid.input.outbound_id])).rows[0].status,'SENT');
    assert.equal(providerCalls,1,'only the controlled in-process fake sender ran');

    // A replay after SENT stays terminal; an old revision cannot create a new row.
    assert.deepEqual(await outbox.enqueue(valid.input),
      {status:'queued',outbound_id:valid.input.outbound_id});
    assert.equal((await pool.query('SELECT status FROM core_tn005_suggested_outbox '+
      'WHERE outbound_id=$1',[valid.input.outbound_id])).rows[0].status,'SENT');
    await core.service.revise(login.principal,valid.orderId,{expected_revision:1,
      request_data:valid.requestData,idempotency_key:'revise-'+id});
    assert.equal((await zaloRuntime.queue_first_page_suggested_question({
      outbound_id:randomUUID(),scope:validScope})).status,'blocked',
      'old first-page evidence must not enqueue after a new order revision');
    await assert.rejects(outbox.enqueue(valid.input),code('TN005_STALE'));

    // Real other-tenant Core order fails closed at AI1's fixed shop scope.
    const other='autoin-test-tn005-other-'+id;
    await core.auth.bootstrapOwner({shop_id:other,username:'owner',password,bootstrap_enabled:true});
    const otherLogin=await core.auth.login(other,'owner',password);
    const foreign=await core.service.createDraft(otherLogin.principal,{customer_id:'foreign-customer-'+id,
      conversation_id:'foreign-chat-'+id,request_data:{documents:[{artifact_name:'foreign.pdf'}]},
      idempotency_key:'foreign-'+id});
    await assert.rejects(outbox.enqueue({...valid.input,outbound_id:randomUUID(),
      order_id:foreign.order_id,idempotency_key:'foreign-outbound-'+id}),code('TN005_STALE'));
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM core_tn005_suggested_outbox '+
      'WHERE order_id=$1',[foreign.order_id])).rows[0].n,0);

    // Handover after reservation cancels the advisory before the fake provider.
    const handedScope={shop_id:shop,order_id:handed.orderId,revision:1,oa_id:oa,
      customer_id:handed.customer,conversation_id:handed.conversation};
    assert.deepEqual(await zaloRuntime.queue_first_page_suggested_question({
      outbound_id:handed.input.outbound_id,scope:handedScope}),
      {status:'queued',outbound_id:handed.input.outbound_id,text:handed.input.text});
    assert.deepEqual(await outbox.enqueue(handed.input),
      {status:'queued',outbound_id:handed.input.outbound_id});
    const handoverLease=await outbox.reserve(handed.input.outbound_id);
    assert.ok(handoverLease);
    await pool.query("UPDATE core_conversation_controls SET status='HUMAN',claimed_by=$3,"+
      'generation=generation+1,updated_at=now() WHERE shop_id=$1 AND conversation_id=$2',
      [shop,handed.conversation,login.principal.id]);
    assert.equal(await outbox.deliverReserved(handoverLease,fakeSender),'blocked');
    assert.equal((await pool.query('SELECT status FROM core_tn005_suggested_outbox '+
      'WHERE outbound_id=$1',[handed.input.outbound_id])).rows[0].status,'CANCELLED');
    assert.equal((await zaloRuntime.queue_first_page_suggested_question({
      outbound_id:randomUUID(),scope:handedScope})).status,'blocked',
      'a human handover blocks a new AI2 TN005 enqueue');
    assert.equal(providerCalls,1,'handover never reached the fake provider');

    const guardsAfter=(await pool.query(
      'SELECT (SELECT count(*)::int FROM core_confirmations WHERE order_id=ANY($1::uuid[])) confirmations,'+
      '(SELECT count(*)::int FROM core_approvals WHERE order_id=ANY($1::uuid[])) approvals,'+
      '(SELECT count(*)::int FROM core_print_jobs WHERE order_id=ANY($1::uuid[])) print_jobs',
      [orderIds])).rows[0];
    assert.deepEqual(guardsAfter,guardsBefore);
    assert.deepEqual(guardsAfter,{confirmations:0,approvals:0,print_jobs:0},
      'TN005 leaves confirmations, approvals, and print jobs at exactly zero');
    console.log('PASS TN005 composition PG/Fastify: real sealed bytes+manifest, cross-shop, stale revision, handover, fake provider only, 0 print mutations');
  }finally{
    if(app)await app.close();
    await pool.end();
    await rm(tmp,{recursive:true,force:true});
  }
});
