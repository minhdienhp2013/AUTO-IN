import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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

const databaseUrl = process.env.TEST_DATABASE_URL;

/** Real PG + AI2 durable webhook/queue + verified AI0 frozen files +
 * AI3 Python inspect + AI1 generation-locked proposal.
 * Never exercises live Zalo, customer confirmation, or a physical printer.
 */
test('AI0 REAL PG: signed synthetic Zalo image + frozen manifest -> AI3 verified fact -> AI2 worker -> one AI1 proposal; tamper -> HUMAN', {
  skip: !databaseUrl ? 'TEST_DATABASE_URL missing: verified Zalo document worker NOT RUN' : false,
  timeout: 120_000
}, async () => {
  assertIsolatedSimulationDatabase(databaseUrl);
  const scratch = await mkdtemp(join(tmpdir(), 'autoin-zalo-artifact-worker-'));
  const root = join(scratch, 'documents');
  const pngFile = join(scratch, 'fixture.png');
  const python = process.env.AUTOIN_PYTHON ?? 'python3';
  const pool = new pg.Pool({connectionString:databaseUrl, max:5, connectionTimeoutMillis:5000});
  const id = randomUUID(), shop = 'autoin-test-zalo-file-' + id, oa = 'oa-' + id;
  const key = randomUUID()+randomUUID(), ownerPassword='synthetic-owner-'+randomUUID();
  const scope={shop_id:shop,oa_id:oa};
  const headers=token=>({authorization:'Bearer '+token});
  const query=(sql,args=[])=>pool.query(sql,args);
  let app, created=false;
  try {
    await mkdir(root,{mode:0o700});
    const generated=spawnSync(python,['-c',
      'from PIL import Image;import sys;Image.new("RGB",(95,137),"white").save(sys.argv[1])',
      pngFile],{cwd:process.cwd(),timeout:10000});
    assert.equal(generated.status,0,'AI3 Pillow fixture generation unavailable');
    const png=await readFile(pngFile);
    const core=createCoreModule({pool:asSqlPool(pool)});
    await core.auth.bootstrapOwner({shop_id:shop,username:'owner',
      password:ownerPassword,bootstrap_enabled:true});
    created=true;
    const session=await core.auth.login(shop,'owner',ownerPassword);
    const runtime=createSyntheticZaloRuntime(pool,
      {kind:'synthetic_fixture',shop_id:shop,oa_id:oa,fixture_key:key},
      {store:new PgStore(asSqlPool(pool)),artifactRoot:root,python});
    app=buildIntegratedApp({pool:asSqlPool(pool),zaloWebhook:runtime.webhook,
      zaloWorkerConfigured:true,
      syntheticArtifactIngest:{artifactRoot:root,scope}});
    await app.ready();
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
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM core_confirmations WHERE order_id=$1',[orderId])).rows[0].n,0);
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM core_approvals WHERE order_id=$1',[orderId])).rows[0].n,0);
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM core_print_jobs WHERE order_id=$1',[orderId])).rows[0].n,0);
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM zalo_outbound WHERE shop_id=$1 AND oa_id=$2',[shop,oa])).rows[0].n,1);
    assert.equal((await runtime.tick_outbound()).disabled,true,'No real Zalo sender in simulation');
    assert.equal((await runtime.tick_inbound()).processed,0,'Restart/re-tick cannot duplicate AI1 proposal');
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM core_ai_draft_proposals WHERE shop_id=$1',[shop])).rows[0].n,1);

    // A different conversation has a valid event and sealed manifest, but the
    // frozen source is changed after registration. The worker must route HUMAN,
    // never convert its customer-provided file_ref into a trusted draft.
    const badId='tampered-'+randomUUID();
    const bad=fixture(badId,'bad-customer-'+id,'bad-conversation-'+id);
    assert.equal((await send(bad)).json().status,'accepted');
    const badImport=await register(badId,png);
    assert.equal(badImport.statusCode,201,JSON.stringify(badImport.json()));
    const stored=(await query(
      'SELECT artifact_ref FROM ai0_inbound_document_artifacts WHERE shop_id=$1 AND oa_id=$2 AND event_id=$3',
      [shop,oa,badId])).rows[0];
    assert.ok(stored?.artifact_ref && !stored.artifact_ref.includes('..'));
    const frozen=join(root,stored.artifact_ref);
    await chmod(frozen,0o600);
    await writeFile(frozen,Buffer.from('tampered after registered hash'));
    assert.deepEqual(await documentPort.inspect({
      key:'synthetic-bad',first_at:0,deadline_at:0,events:[bad]
    }),[{kind:'unknown',preview_trusted:false}]);
    assert.equal((await runtime.tick_inbound()).ingested,1);
    await query("UPDATE zalo_batches SET deadline_at=now()-interval '1 second' WHERE oa_id=$1 AND status='OPEN'",[oa]);
    const blocked=await runtime.tick_inbound();
    assert.equal(blocked.held,1,JSON.stringify(blocked));
    const control=(await query(
      'SELECT status FROM core_conversation_controls WHERE shop_id=$1 AND conversation_id=$2',
      [shop,bad.conversation_id])).rows[0];
    assert.equal(control.status,'HUMAN','Hash mismatch must require staff takeover');
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM core_ai_draft_proposals WHERE shop_id=$1',[shop])).rows[0].n,1);
    assert.equal((await runtime.tick_outbound()).disabled,true);
  } finally {
    if(app)await app.close();
    if(created) {
      // Only synthetic, uniquely prefixed test shop/OA data. Never affect other
      // tenants or truncate shared test tables.
      await query('DELETE FROM ai0_inbound_artifact_drafts WHERE shop_id=$1',[shop]);
      await query('DELETE FROM ai0_inbound_document_artifacts WHERE shop_id=$1',[shop]);
      await query('DELETE FROM zalo_outbound WHERE shop_id=$1 AND oa_id=$2',[shop,oa]);
      await query('DELETE FROM zalo_batch_items WHERE oa_id=$1',[oa]);
      await query('DELETE FROM zalo_batches WHERE oa_id=$1',[oa]);
      await query('DELETE FROM zalo_process_queue WHERE oa_id=$1',[oa]);
      await query('DELETE FROM core_ai_draft_proposals WHERE shop_id=$1',[shop]);
      await query('DELETE FROM core_audit WHERE shop_id=$1',[shop]);
      await query('DELETE FROM core_sessions WHERE user_id IN (SELECT id FROM core_users WHERE shop_id=$1)',[shop]);
      await query('DELETE FROM core_idempotency WHERE shop_id=$1',[shop]);
      await query('DELETE FROM core_revisions WHERE order_id IN (SELECT id FROM core_orders WHERE shop_id=$1)',[shop]);
      await query('DELETE FROM core_orders WHERE shop_id=$1',[shop]);
      await query('DELETE FROM core_conversation_controls WHERE shop_id=$1',[shop]);
      await query('DELETE FROM core_users WHERE shop_id=$1',[shop]);
      await query('DELETE FROM core_shop_settings WHERE shop_id=$1',[shop]);
      await query('DELETE FROM zalo_inbound_events WHERE oa_id=$1',[oa]);
    }
    await pool.end();
    await rm(scratch,{recursive:true,force:true});
  }
});