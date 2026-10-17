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
test('AI0 image route PG: durable file handover, no AI draft or print', {
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

        // V1 routes images directly to staff. The durable event and frozen source
    //     // remain available; image bytes never enter document preflight/OCR.
    assert.equal((await runtime.tick_inbound()).ingested,1);
    await query("UPDATE zalo_batches SET deadline_at=now()-interval '1 second' WHERE oa_id=$1 AND status='OPEN'",[oa]);
    const routed=await runtime.tick_inbound();
    assert.equal(routed.processed,1,JSON.stringify(routed));
    assert.equal(routed.held,0);
    const control=(await query(
      'SELECT status,generation,ai_route_reason FROM core_conversation_controls WHERE shop_id=$1 AND conversation_id=$2',
      [shop,conversation])).rows[0];
    assert.equal(control.status,'HUMAN');
    assert.equal(Number(control.generation),1);
    assert.equal(control.ai_route_reason,'IMAGE_V1');
    assert.equal((await query('SELECT count(*)::int n FROM zalo_inbound_events WHERE oa_id=$1 AND event_id=$2',[oa,goodId])).rows[0].n,1);
    assert.equal((await query('SELECT count(*)::int n FROM ai0_inbound_document_artifacts WHERE shop_id=$1 AND oa_id=$2 AND event_id=$3',[shop,oa,goodId])).rows[0].n,1,
      'The original file remains durably registered for staff');
    assert.equal((await query('SELECT count(*)::int n FROM core_ai_draft_proposals WHERE shop_id=$1',[shop])).rows[0].n,0,
      'Image intake must not create an automatic proposal');
    assert.equal((await query('SELECT count(*)::int n FROM core_orders WHERE shop_id=$1',[shop])).rows[0].n,0);
    for(const table of ['core_confirmations','core_approvals','core_print_jobs'])
      assert.equal((await query('SELECT count(*)::int n FROM '+table+' WHERE order_id IN (SELECT id FROM core_orders WHERE shop_id=$1)',[shop])).rows[0].n,0);
    assert.equal((await runtime.tick_outbound()).disabled,true,'No real Zalo sender in simulation');
    assert.equal((await runtime.tick_inbound()).processed,0,'Re-tick cannot create an order from the routed image');
    console.log('PASS V1 IMAGE route=HUMAN durable_event=true durable_source=true proposals=0 confirmations=0 approvals=0 print_jobs=0');
  }finally{
    if(app)await app.close();
    if(secondApp)await secondApp.close();
    await pool.end();
    await secondPool.end();
    await rm(scratch,{recursive:true,force:true});
  }
});
