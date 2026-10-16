import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID,createHmac } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import pg from 'pg';
import { PgStore } from '../../../backend/storage/database.ts';
import { createCoreModule } from '../../../backend/core/factory.ts';
import { buildIntegratedApp } from '../../../backend/composition/runtime.ts';
import { asSqlPool, assertIsolatedSimulationDatabase } from '../../../backend/composition/postgres.ts';
import { createSyntheticZaloRuntime } from '../../../backend/composition/zalo-simulation.ts';
import { createTrustedDocumentFactsPort } from '../../../backend/composition/document-facts.ts';
import { prepareSyntheticInboundDraft } from '../../../backend/composition/inbound-draft.ts';
import { adoptSyntheticSuggestedSource } from '../../../backend/composition/synthetic-suggestion-adopt.ts';
import { createVerifiedConfirmationPort } from '../../../backend/core/verified-confirmation-port.ts';
import { loadVerifiedOrderPreviewCatalog } from '../../../backend/composition/preview.ts';

const databaseUrl = process.env.TEST_DATABASE_URL;

/** Real PG + AI2 durable webhook/queue + verified AI0 frozen files +
 * AI3 Python inspect + AI1 generation-locked proposal.
 * Exercises explicit simulated customer confirmation; NEVER live Zalo or a physical printer.
 */
test('AI0 staff adoption HTTP: existing AI2 order, lost-response replay, scope and pending fail closed', {
  skip: !databaseUrl ? 'TEST_DATABASE_URL missing: verified Zalo document worker NOT RUN' : false,
  timeout: 120_000
}, async () => {
  assertIsolatedSimulationDatabase(databaseUrl);
  const scratch = await mkdtemp(join(tmpdir(), 'autoin-zalo-artifact-worker-'));
  const root = join(scratch, 'documents');
  const renderedRoot=join(scratch,'rendered');
  const pngFile = join(scratch, 'fixture.png');
  const python = process.env.AUTOIN_PYTHON ?? 'python3';
  const pool = new pg.Pool({connectionString:databaseUrl, max:5, connectionTimeoutMillis:5000});
  const secondPool = new pg.Pool({connectionString:databaseUrl, max:5, connectionTimeoutMillis:5000});
  const id = randomUUID(), shop = 'autoin-test-zalo-file-' + id, oa = 'oa-' + id;
  const key = randomUUID()+randomUUID(), ownerPassword='synthetic-owner-'+randomUUID();
  const buttonKey=randomUUID()+randomUUID();
  const scope={shop_id:shop,oa_id:oa};
  const headers=token=>({authorization:'Bearer '+token});
  const query=(sql,args=[])=>pool.query(sql,args);
  let app, secondApp, created=false;
  try {
    await mkdir(root,{mode:0o700});
    await mkdir(renderedRoot,{mode:0o700});
    const generated=spawnSync(python,['-c',
      'from PIL import Image;import sys;Image.new("RGB",(95,137),"white").save(sys.argv[1])',
      pngFile],{cwd:process.cwd(),timeout:10000});
    assert.equal(generated.status,0,'AI3 Pillow fixture generation unavailable');
    const png=await readFile(pngFile);
    const core=createCoreModule({pool:asSqlPool(pool)});
    await core.auth.bootstrapOwner({shop_id:shop,username:'owner',
      password:ownerPassword,bootstrap_enabled:true});
    created=true;
    // Fixture-only hours: test real PG + DryRun UNKNOWN, not store hours.
    await pool.query('UPDATE core_shop_settings SET open_at=$2,close_at=$3 WHERE shop_id=$1',
      [shop,'00:00','24:00']);
    // This positive Zalo-proposal flow uses an explicit synthetic shop/OA binding.
    // Missing/unregistered bindings are still covered by negative 409/zero-job tests.
    await pool.query(
      'INSERT INTO core_shop_zalo_oa_registry(shop_id,oa_id,app_id) VALUES($1,$2,$3)',
      [shop,oa,'synthetic-app-'+id]
    );
    const session=await core.auth.login(shop,'owner',ownerPassword);
    const runtime=createSyntheticZaloRuntime(pool,
      {kind:'synthetic_fixture',shop_id:shop,oa_id:oa,fixture_key:key},
      {store:new PgStore(asSqlPool(pool)),artifactRoot:root,python});
    app=buildIntegratedApp({pool:asSqlPool(pool),zaloWebhook:runtime.webhook,
      zaloWorkerConfigured:true,
      syntheticArtifactIngest:{artifactRoot:root,scope},
      syntheticVerifiedButton:{kind:'synthetic_fixture',shop_id:shop,oa_id:oa,fixture_secret:buttonKey},
      previewArtifactRoot:renderedRoot});
    await app.ready();
    secondApp=buildIntegratedApp({pool:asSqlPool(secondPool),
      syntheticArtifactIngest:{artifactRoot:root,scope}});
    await secondApp.ready();
    const fixture=(eventId,customer,conversation)=>({
      synthetic_fixture:true,event_id:eventId,oa_id:oa,customer_id:customer,
      conversation_id:conversation,occurred_at:'2026-10-12T00:00:00Z',
      kind:'image',filename:'fixture.png',file_ref:'untrusted-zalo-customer-path'
    });
    const send=(event)=>app.inject({method:'POST',url:'/webhooks/zalo',
      headers:{'content-type':'application/json','x-test-fixture-key':key},
      payload:JSON.stringify(event)});
    const register=(eventId,bytes)=>app.inject({
      method:'POST',url:'/internal/simulation/inbound-artifacts',
      headers:headers(session.token),
      payload:{event_id:eventId,filename:'fixture.png',content_base64:bytes.toString('base64')}
    });
    const goodId='verified-'+randomUUID(), customer='customer-'+id, conversation='conv-'+id;
    const good=fixture(goodId,customer,conversation);
    assert.equal((await send(good)).json().status,'accepted');
    assert.equal((await send(good)).json().status,'duplicate');
    assert.equal((await app.inject({method:'POST',
      url:'/internal/simulation/inbound-artifacts',
      payload:{event_id:goodId,filename:'fixture.png',content_base64:png.toString('base64')}})).statusCode,401);
    const imported=await register(goodId,png);
    assert.equal(imported.statusCode,201,JSON.stringify(imported.json()));
    assert.equal(imported.json().status,'registered');
    assert.equal(imported.json().preview_trusted,false,'Registration alone cannot claim verified preview');
    assert.equal((await register(goodId,png)).json().status,'existing');

    const documentPort=createTrustedDocumentFactsPort(pool,scope,{artifactRoot:root,python});
    const fact=await documentPort.inspect({
      key:'synthetic-image',first_at:0,deadline_at:0,events:[good]
    });
    assert.deepEqual(fact,[{kind:'image',preview_trusted:true}],
      'Trust requires AI3 actually decoding the DB-bound, hash-frozen file');
    assert.equal((await runtime.tick_inbound()).ingested,1);
    await query("UPDATE zalo_batches SET deadline_at=now()-interval '1 second' WHERE oa_id=$1 AND status='OPEN'",[oa]);
    const result=await runtime.tick_inbound();
    assert.equal(result.processed,1,JSON.stringify(result));
    const proposal=(await query(
      'SELECT order_id,conversation_id,customer_id FROM core_ai_draft_proposals WHERE shop_id=$1',
      [shop])).rows;
    assert.equal(proposal.length,1);
    assert.equal(proposal[0].conversation_id,conversation);
    assert.equal(proposal[0].customer_id,customer);
    const orderId=proposal[0].order_id;
    const order=(await query(
      'SELECT active_revision,customer_id FROM core_orders WHERE id=$1 AND shop_id=$2',
      [orderId,shop])).rows[0];
    assert.equal(order.active_revision,1);
    assert.equal(order.customer_id,customer);
    const revision=(await query(
      'SELECT request_data FROM core_revisions WHERE order_id=$1 AND revision=1',
      [orderId])).rows[0].request_data;
    assert.equal(revision.source,'zalo_ai_suggestion');
    assert.deepEqual(revision.event_ids,[goodId]);
    assert.equal(revision.text,'[AUTO-IN SYSTEM: ATTACHMENT_ONLY; NO_CUSTOMER_TEXT]',
      'The system marker must never be presented as actual customer text');
    assert.ok(!JSON.stringify(revision).includes(good.file_ref),
      'Client-controlled Zalo file_ref must never become a trusted order path');
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM core_confirmations WHERE order_id=$1',[orderId])).rows[0].n,0);
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM core_approvals WHERE order_id=$1',[orderId])).rows[0].n,0);
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM core_print_jobs WHERE order_id=$1',[orderId])).rows[0].n,0);
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM zalo_outbound WHERE shop_id=$1 AND oa_id=$2',[shop,oa])).rows[0].n,1);
    assert.equal((await runtime.tick_outbound()).disabled,true,'No real Zalo sender in simulation');
    assert.equal((await runtime.tick_inbound()).processed,0,'Restart/re-tick cannot duplicate AI1 proposal');
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM core_ai_draft_proposals WHERE shop_id=$1',[shop])).rows[0].n,1);


    const path='/internal/simulation/inbound-artifacts/'+goodId+'/adopt';
    const body={order_id:orderId,paper:'A4',copies:2,duplex:false,
      idempotency_key:'adopt-http-'+id};
    const invoke=(payload=body,token=session.token)=>app.inject({
      method:'POST',url:path,headers:headers(token),payload});
    assert.equal((await app.inject({method:'POST',url:path,payload:body})).statusCode,401);
    assert.equal((await invoke({...body,source_ref:'caller-path'})).statusCode,422);
    assert.equal((await invoke({...body,copies:0})).statusCode,422);
    const otherShop='autoin-test-other-'+id;
    await core.auth.bootstrapOwner({shop_id:otherShop,username:'owner',password:ownerPassword,bootstrap_enabled:true});
    const other=await core.auth.login(otherShop,'owner',ownerPassword);
    assert.equal((await invoke(body,other.token)).statusCode,403);
    assert.equal((await invoke({...body,order_id:randomUUID()})).statusCode,409);
    assert.equal((await query('SELECT count(*)::int n FROM ai0_source_adoption_receipts WHERE shop_id=$1',[shop])).rows[0].n,0,
      'invalid target must not reserve or poison the event');
    // Server succeeds, the hypothetical client discards response and retries.
    const simultaneous=await Promise.all([invoke(),secondApp.inject({
      method:'POST',url:path,headers:headers(session.token),payload:body})]);
    assert.ok(simultaneous.every(r=>[200,409].includes(r.statusCode)),
      simultaneous.map(r=>r.body).join('\n'));
    const first=simultaneous.find(r=>r.statusCode===200);
    assert.ok(first,'one concurrent adoption must commit successfully');
    assert.equal(first.statusCode,200,first.body);
    assert.equal(first.headers['cache-control'],'no-store');
    assert.equal(first.json().status,'adopted');
    assert.equal(first.json().revision,2);
    assert.equal(first.json().order_id,orderId);
    const replay=await invoke();
    assert.equal(replay.statusCode,200,replay.body);
    assert.deepEqual(replay.json(),first.json());
    const conflicts=await invoke({...body,copies:3});
    assert.equal(conflicts.statusCode,409);
    assert.equal(conflicts.json().error.code,'IDEMPOTENCY_CONFLICT');
    assert.equal((await invoke({...body,idempotency_key:'another-key'})).statusCode,409);
    const current=await query('SELECT active_revision FROM core_orders WHERE id=$1',[orderId]);
    assert.equal(current.rows[0].active_revision,2);
    assert.equal((await query('SELECT count(*)::int n FROM core_orders WHERE shop_id=$1',[shop])).rows[0].n,1);
    // A later legitimate staff revision does not cause adoption replay to revise again.
    const revision2=(await query('SELECT request_data FROM core_revisions WHERE order_id=$1 AND revision=2',[orderId])).rows[0].request_data;
    await core.service.revise(session.principal,orderId,{expected_revision:2,
      request_data:revision2,idempotency_key:'later-revision-'+id});
    assert.equal((await invoke()).json().revision,2,'receipt is the committed operation snapshot');
    assert.equal((await query('SELECT active_revision FROM core_orders WHERE id=$1',[orderId])).rows[0].active_revision,3);
    await query("UPDATE core_shop_settings SET mode='safe' WHERE shop_id=$1",[shop]);
    assert.equal((await invoke()).statusCode,409,'replay does not bypass current simulation mode');
    await query("UPDATE core_shop_settings SET mode='simulation' WHERE shop_id=$1",[shop]);
    // Explicit crash fixture: a reserved operation without a durable final response
    // must never re-run Core or infer success from the already changed order.
    await query('UPDATE ai0_source_adoption_receipts SET response=NULL,completed_at=NULL WHERE shop_id=$1',[shop]);
    const pending=await invoke();
    assert.equal(pending.statusCode,409);
    assert.equal(pending.json().error.code,'SOURCE_ADOPTION_PENDING_RECONCILIATION');
    assert.equal((await query('SELECT active_revision FROM core_orders WHERE id=$1',[orderId])).rows[0].active_revision,3);
    for(const table of ['core_confirmations','core_approvals','core_print_jobs'])
      assert.equal((await query('SELECT count(*)::int n FROM '+table+' WHERE order_id=$1',[orderId])).rows[0].n,0);
    console.log('PASS STAFF ADOPT HTTP one_order=true replay_same_receipt=true conflict=409 pending=409 guards=0');
  }finally{
    if(app)await app.close();
    if(secondApp)await secondApp.close();
    await pool.end();
    await secondPool.end();
    await rm(scratch,{recursive:true,force:true});
  }
});
