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
test('AI0 REAL PG: ONE Zalo PDF -> AI2 suggestion -> staff-scoped AI3 preview -> challenge/quote -> staff DryRun UNKNOWN; tamper -> HUMAN', {
  skip: !databaseUrl ? 'TEST_DATABASE_URL missing: verified Zalo document worker NOT RUN' : false,
  timeout: 120_000
}, async () => {
  assertIsolatedSimulationDatabase(databaseUrl);
  const scratch = await mkdtemp(join(tmpdir(), 'autoin-zalo-artifact-worker-'));
  const root = join(scratch, 'documents');
  const renderedRoot=join(scratch,'rendered');
  const pdfFile = join(scratch, 'fixture.pdf');
  const python = process.env.AUTOIN_PYTHON ?? 'python3';
  const pool = new pg.Pool({connectionString:databaseUrl, max:5, connectionTimeoutMillis:5000});
  const id = randomUUID(), shop = 'autoin-test-zalo-file-' + id, oa = 'oa-' + id;
  const key = randomUUID()+randomUUID(), ownerPassword='synthetic-owner-'+randomUUID();
  const buttonKey=randomUUID()+randomUUID();
  const scope={shop_id:shop,oa_id:oa};
  const headers=token=>({authorization:'Bearer '+token});
  const query=(sql,args=[])=>pool.query(sql,args);
  let app, created=false;
  try {
    await mkdir(root,{mode:0o700});
    await mkdir(renderedRoot,{mode:0o700});
    const generated=spawnSync(python,['-c',
      'import fitz,sys;d=fitz.open();p=d.new_page(width=595,height=842);p.insert_text((72,72),"AUTO-IN public PDF fixture");d.save(sys.argv[1]);d.close()',
      pdfFile],{cwd:process.cwd(),timeout:10000});
    assert.equal(generated.status,0,'AI3 Pillow fixture generation unavailable');
    const pdf=await readFile(pdfFile);
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
    const fixture=(eventId,customer,conversation)=>({
      synthetic_fixture:true,event_id:eventId,oa_id:oa,customer_id:customer,
      conversation_id:conversation,occurred_at:'2026-10-12T00:00:00Z',
      kind:'file',filename:'fixture.pdf',mime_type:'application/pdf',file_ref:'untrusted-zalo-customer-path'
    });
    const send=(event)=>app.inject({method:'POST',url:'/webhooks/zalo',
      headers:{'content-type':'application/json','x-test-fixture-key':key},
      payload:JSON.stringify(event)});
    const register=(eventId,bytes)=>app.inject({
      method:'POST',url:'/internal/simulation/inbound-artifacts',
      headers:headers(session.token),
      payload:{event_id:eventId,filename:'fixture.pdf',content_base64:bytes.toString('base64')}
    });
    const goodId='verified-'+randomUUID(), customer='customer-'+id, conversation='conv-'+id;
    const good=fixture(goodId,customer,conversation);
    assert.equal((await send(good)).json().status,'accepted');
    assert.equal((await send(good)).json().status,'duplicate');
    assert.equal((await app.inject({method:'POST',
      url:'/internal/simulation/inbound-artifacts',
      payload:{event_id:goodId,filename:'fixture.pdf',content_base64:pdf.toString('base64')}})).statusCode,401);
    const imported=await register(goodId,pdf);
    assert.equal(imported.statusCode,201,JSON.stringify(imported.json()));
    assert.equal(imported.json().status,'registered');
    assert.equal(imported.json().preview_trusted,false,'Registration alone cannot claim verified preview');
    assert.equal((await register(goodId,pdf)).json().status,'existing');

    const documentPort=createTrustedDocumentFactsPort(pool,scope,{artifactRoot:root,python});
    const fact=await documentPort.inspect({
      key:'synthetic-image',first_at:0,deadline_at:0,events:[good]
    });
    assert.deepEqual(fact,[{kind:'pdf',preview_trusted:true}],
      'PDF intake requires AI3 to decode the DB-bound, hash-frozen original');
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

    // One and the SAME AI2-created order goes through staff-bound source choice,
    // real AI3 rendering and the two independently authenticated customer gates.
    // Staff alone may choose printing settings; neither AI nor a webhook may
    // promote the customer's arbitrary file_ref into an authoritative path.
    const settings={event_id:goodId,paper:'A4',copies:2,duplex:false};
    const prepared=await prepareSyntheticInboundDraft(asSqlPool(pool),root,scope,settings);
    assert.equal(prepared.source.customer_id,customer);
    assert.equal(prepared.source.conversation_id,conversation);
    assert.notEqual(prepared.source.artifact_ref,good.file_ref);
    const staff=session.principal;
    const adopted=await adoptSyntheticSuggestedSource(asSqlPool(pool),core.service,
      root,scope,staff,{order_id:orderId,...settings});
    assert.equal(adopted.revision,2);
    assert.equal(adopted.order_id,orderId);
    assert.equal(adopted.status,'adopted');
    await assert.rejects(
      adoptSyntheticSuggestedSource(asSqlPool(pool),core.service,root,scope,staff,
        {order_id:orderId,...settings}),
      e=>e.code==='SOURCE_ADOPTION_PROVENANCE_MISMATCH',
      'No automatic second revision or order after an already finalized source'
    );
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM core_orders WHERE shop_id=$1',[shop])).rows[0].n,1,
      'Source adoption MUST NOT create a second order');
    const processor=spawnSync(process.execPath,
      ['--import','tsx','scripts/process-order.ts',shop,orderId],{
        cwd:process.cwd(),encoding:'utf8',timeout:90000,maxBuffer:1024*1024,
        env:{...process.env,DATABASE_URL:databaseUrl,AUTOIN_INPUT_ROOT:root,
          AUTOIN_ARTIFACT_ROOT:renderedRoot,AUTOIN_PROCESSOR_ID:'ai0-e2e-verified',
          AUTOIN_PYTHON:python}
      });
    assert.equal(processor.status,0,processor.stderr||processor.stdout);
    const done=JSON.parse(processor.stdout);
    assert.equal(done.revision,3);
    const catalog=await loadVerifiedOrderPreviewCatalog(asSqlPool(pool),renderedRoot,staff,orderId,3);
    assert.equal(catalog.preview_verified,true);
    assert.equal(catalog.files?.[0]?.physical_sheets,2);
    assert.ok(catalog.preview_count>=1);

    const quote=await core.service.setQuote(staff,orderId,{
      expected_revision:3,amount_vnd:32000,deposit_required_vnd:8000,
      significant_cost:true,idempotency_key:'staff-quote-'+id
    });
    assert.equal(quote.quote_revision,1);
    const confirm=createVerifiedConfirmationPort({
      store:new PgStore(asSqlPool(pool)),trusted:scope});
    const target={order_id:orderId,expected_revision:3,request_hash:(await query('SELECT request_hash FROM core_revisions WHERE order_id=$1 AND revision=3',[orderId])).rows[0].request_hash,
      kind:'request',expected_generation:0};
    const requestChallenge=await confirm.issue_challenge(target);
    assert.equal(requestChallenge.status,'issued');
    await assert.rejects(core.service.approve(staff,orderId,{
      expected_revision:3,quote_revision:1,acknowledge_deposit_shortage:true,
      idempotency_key:'not-confirmed-'+id
    }),e=>e.code==='CUSTOMER_NOT_CONFIRMED');
    const press=async(challenge,eventId,overrides={})=>{
      const payload={synthetic_fixture:true,type:'explicit_button_accept',event_id:eventId,
        oa_id:oa,customer_id:customer,conversation_id:conversation,
        occurred_at:new Date().toISOString(),
        challenge_id:challenge.challenge_id,challenge_token:challenge.challenge_token,
        ...overrides};
      const raw=JSON.stringify(payload);
      return app.inject({method:'POST',url:'/internal/simulation/verified-button',
        headers:{'content-type':'application/vnd.autoin.synthetic-button+json',
          'x-autoin-fixture-hmac':createHmac('sha256',buttonKey).update(raw).digest('hex')},
        payload:raw});
    };
    const firstClick=await press(requestChallenge,'request-'+randomUUID());
    assert.equal(firstClick.statusCode,201,JSON.stringify(firstClick.json()));
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM core_print_jobs WHERE order_id=$1',[orderId])).rows[0].n,0);
    await assert.rejects(core.service.approve(staff,orderId,{
      expected_revision:3,quote_revision:1,acknowledge_deposit_shortage:true,
      idempotency_key:'no-price-confirm-'+id
    }),e=>e.code==='PRICE_CONFIRMATION_REQUIRED');
    const price={...target,kind:'quote',quote_revision:1};
    const priceChallenge=await confirm.issue_challenge(price);
    assert.equal(priceChallenge.status,'issued');
    assert.equal((await press(priceChallenge,'price-'+randomUUID())).statusCode,201);
    await assert.rejects(core.service.approve(staff,orderId,{
      expected_revision:3,quote_revision:1,acknowledge_deposit_shortage:false,
      idempotency_key:'deposit-warning-'+id
    }),e=>e.code==='DEPOSIT_WARNING_REQUIRED');
    const approved=await core.service.approve(staff,orderId,{
      expected_revision:3,quote_revision:1,acknowledge_deposit_shortage:true,
      idempotency_key:'staff-approve-'+id
    });
    assert.equal(approved.deposit_short_vnd,8000);
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM core_approvals WHERE order_id=$1',[orderId])).rows[0].n,1);
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM core_print_jobs WHERE order_id=$1',[orderId])).rows[0].n,1);
    const printAgent={id:'simulated-agent-'+id,shop_id:shop,role:'print_agent',
      verified:true,printer_ids:['RMP7000']};
    const claim=await core.service.claim(printAgent,{
      printer_id:'RMP7000',idempotency_key:'claim-'+id});
    assert.equal(claim.job?.order_id,orderId);
    assert.equal(claim.job?.mode,'simulation');
    const sending=await core.service.markSending(printAgent,claim.job.job_id,{
      expected_revision:3,lease_token:claim.job.lease_token,
      idempotency_key:'send-'+id
    });
    assert.equal(sending.state,'SENDING');
    const uncertain=await core.service.report(printAgent,claim.job.job_id,{
      expected_revision:3,lease_token:claim.job.lease_token,
      result:'unknown',evidence_kind:'agent_uncertain',
      idempotency_key:'uncertain-'+id
    });
    assert.equal(uncertain.state,'UNKNOWN');
    assert.deepEqual(await core.service.claim(printAgent,{
      printer_id:'RMP7000',idempotency_key:'no-resend-'+id
    }),{job:null});

    // A delayed event from the past arrives after approval. Its provider
    // occurred_at is old, so it is HELD instead of becoming a new order.
    const delayedId='late-before-approval-'+randomUUID();
    assert.equal((await send(fixture(delayedId,customer,conversation))).json().status,'accepted');
    assert.equal((await register(delayedId,pdf)).statusCode,201);
    assert.equal((await runtime.tick_inbound()).ingested,1);
    await query("UPDATE zalo_batches SET deadline_at=now()-interval '1 second' "+
      "WHERE oa_id=$1 AND status='OPEN'",[oa]);
    const delayedResult=await runtime.tick_inbound();
    assert.equal(delayedResult.held,1,'Pre-approval event delivered late must be held');
    assert.equal((await query('SELECT count(*)::int AS n FROM core_orders WHERE shop_id=$1',
      [shop])).rows[0].n,1);

    // A genuinely NEW print request after the first staff approval is a
    // different order in the same Zalo chat, never an append to UNKNOWN.
    const newEventId='new-after-approval-'+randomUUID();
    const newRequest={...fixture(newEventId,customer,conversation),
      occurred_at:new Date(Date.now()+2000).toISOString()};
    assert.equal((await send(newRequest)).json().status,'accepted');
    assert.equal((await register(newEventId,pdf)).statusCode,201);
    assert.equal((await runtime.tick_inbound()).ingested,1);
    await query("UPDATE zalo_batches SET deadline_at=now()-interval '1 second' "+
      "WHERE oa_id=$1 AND status='OPEN'",[oa]);
    const newResult=await runtime.tick_inbound();
    assert.equal(newResult.processed,1,JSON.stringify(newResult));
    assert.equal((await query('SELECT count(*)::int AS n FROM core_orders WHERE shop_id=$1',
      [shop])).rows[0].n,2,'After staff approval a NEW request can open a NEW order');
    const newest=(await query(
      'SELECT order_id FROM core_ai_draft_proposals WHERE shop_id=$1 AND event_fingerprint<>$2',
      [shop,'unmatched-fixture-fingerprint'])).rows.map(x=>x.order_id);
    assert.equal(newest.length,2);
    assert.equal(new Set(newest).size,2);
    const newOrderId=newest.find(x=>x!==orderId);
    assert.ok(newOrderId);
    assert.equal((await query('SELECT count(*)::int AS n FROM core_print_jobs WHERE order_id=$1',
      [newOrderId])).rows[0].n,0,'No new order auto-approved/printed');

    // CODE-008: a second FILE batch >60s later belongs to the same OPEN
    // order. AI1 appends its verified event and invalidates old confirmation.
    const nextEventId='followup-'+randomUUID();
    const followup=fixture(nextEventId,customer,conversation);
    followup.occurred_at=new Date(Date.now()+90_000).toISOString();
    assert.equal((await send(followup)).json().status,'accepted');
    assert.equal((await register(nextEventId,pdf)).statusCode,201);
    assert.equal((await runtime.tick_inbound()).ingested,1);
    await query("UPDATE zalo_batches SET deadline_at=now()-interval '1 second' "+
      "WHERE oa_id=$1 AND status='OPEN'",[oa]);
    const followResult=await runtime.tick_inbound();
    assert.equal(followResult.processed,1,JSON.stringify(followResult));
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM core_orders WHERE shop_id=$1',[shop])).rows[0].n,2,
      'More than 60 seconds does NOT close order or authorize a third one');
    assert.equal((await query('SELECT active_revision FROM core_orders WHERE id=$1',[newOrderId])).rows[0].active_revision,2,
      'Verified follow-up file creates a new revision on the same order');
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM core_order_inbound_reviews WHERE order_id=$1 AND event_id=$2',
      [newOrderId,nextEventId])).rows[0].n,1);
    const followBatch=(await query(
      'SELECT b.status FROM zalo_batches b JOIN zalo_batch_items i ON i.batch_id=b.id '+
      'WHERE i.oa_id=$1 AND i.event_id=$2',
      [oa,nextEventId])).rows;
    assert.equal(followBatch.length,1);
    assert.equal(followBatch[0].status,'DONE','Appended event has durable reviewed provenance');
    const sourceEvent=(await query(
      'SELECT count(*)::int AS n FROM zalo_inbound_events WHERE oa_id=$1 AND event_id=$2',
      [oa,nextEventId])).rows[0];
    assert.equal(sourceEvent.n,1);
    assert.equal((await runtime.tick_inbound()).processed,0,
      'Re-tick/restart cannot duplicate the open order');

    // A different conversation has a valid event and sealed manifest, but the
    // frozen source is changed after registration. The worker must route HUMAN,
    // never convert its customer-provided file_ref into a trusted draft.
    const badId='tampered-'+randomUUID();
    const bad=fixture(badId,'bad-customer-'+id,'bad-conversation-'+id);
    assert.equal((await send(bad)).json().status,'accepted');
    const badImport=await register(badId,pdf);
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
    assert.equal((await query('SELECT COUNT(*)::int AS n FROM core_ai_draft_proposals WHERE shop_id=$1',[shop])).rows[0].n,2,
      'Tampered different conversation must NOT create a third draft');
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
      await query('DELETE FROM core_verified_confirmation_events WHERE shop_id=$1',[shop]);
      await query('DELETE FROM core_confirmation_challenges WHERE shop_id=$1',[shop]);
      await query('DELETE FROM core_print_jobs WHERE order_id IN (SELECT id FROM core_orders WHERE shop_id=$1)',[shop]);
      await query('DELETE FROM core_approvals WHERE order_id IN (SELECT id FROM core_orders WHERE shop_id=$1)',[shop]);
      await query('DELETE FROM core_confirmations WHERE order_id IN (SELECT id FROM core_orders WHERE shop_id=$1)',[shop]);
      await query('DELETE FROM core_quotes WHERE order_id IN (SELECT id FROM core_orders WHERE shop_id=$1)',[shop]);
      await query('DELETE FROM ai0_verified_plan_manifests WHERE shop_id=$1',[shop]);
      await query('DELETE FROM core_ai_draft_proposals WHERE shop_id=$1',[shop]);
      await query('DELETE FROM core_order_inbound_reviews WHERE shop_id=$1',[shop]);
      await query('DELETE FROM core_order_supplement_batches WHERE shop_id=$1',[shop]);
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
