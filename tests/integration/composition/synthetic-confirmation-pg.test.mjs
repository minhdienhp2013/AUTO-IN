import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {chmod,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {loadVerifiedOrderPreviewCatalog} from '../../../backend/composition/preview.ts';
import pg from 'pg';
import {asSqlPool,assertIsolatedSimulationDatabase} from '../../../backend/composition/postgres.ts';
import {createCoreModule} from '../../../backend/core/factory.ts';
import {createVerifiedConfirmationPort} from '../../../backend/core/verified-confirmation-port.ts';
import {createSyntheticZaloIngress} from '../../../backend/composition/zalo-simulation.ts';
import {PostgresConfirmationCandidates} from '../../../backend/integrations/zalo/confirmation-candidates.ts';
import {buildIntegratedApp} from '../../../backend/composition/runtime.ts';

const url=process.env.TEST_DATABASE_URL;
test('CODE-007 real HTTP/PG: AI2 signed OK pending, explicit signed button -> AI1 challenge -> staff approval -> DryRun UNKNOWN',{
  skip:!url?'TEST_DATABASE_URL required: CODE007 end-to-end NOT RUN':false,
  timeout:120000
},async()=>{
  assertIsolatedSimulationDatabase(url);
  const pool=new pg.Pool({connectionString:url,connectionTimeoutMillis:5000,max:9});
  const scratch=await mkdtemp(join(tmpdir(),'autoin-code007-button-'));
  const inputRoot=join(scratch,'input'),artifactRoot=join(scratch,'artifacts');
  await mkdir(inputRoot,{mode:0o700});await mkdir(artifactRoot,{mode:0o700});
  const sql=asSqlPool(pool),core=createCoreModule({pool:sql});
  const shop='autoin-test-button-'+randomUUID(),oa='oa-'+randomUUID();
  const conv='conv-'+randomUUID(),customer='customer-'+randomUUID();
  const inboundKey=randomUUID()+randomUUID(),buttonKey=randomUUID()+randomUUID();
  const printer='RMP7000'; // AI3 plan printer ID; never attached to a real device
  const textId='ok-'+randomUUID();
  let app,orderId,created=false;
  const count=async table=>Number((await pool.query(
    'SELECT count(*)::int AS n FROM '+table+' WHERE order_id=$1',[orderId])).rows[0].n);
  const button=(challenge,event_id,changes={})=>({
    synthetic_fixture:true,type:'explicit_button_accept',event_id,oa_id:oa,
    customer_id:customer,conversation_id:conv,occurred_at:new Date().toISOString(),
    challenge_id:challenge.challenge_id,challenge_token:challenge.challenge_token,...changes
  });
  const submit=async(payload,{secret=buttonKey,signature,raw}={})=>{
    const body=raw??JSON.stringify(payload);
    const mac=signature??createHmac('sha256',secret).update(body).digest('hex');
    return app.inject({method:'POST',url:'/internal/simulation/verified-button',
      headers:{'content-type':'application/vnd.autoin.synthetic-button+json',
        'x-autoin-fixture-hmac':mac},payload:body});
  };
  try{
    await core.auth.bootstrapOwner({shop_id:shop,username:'owner',
      password:'isolated-test-password-'+randomUUID(),bootstrap_enabled:true});
    created=true;
    const user=(await pool.query("SELECT id FROM core_users WHERE shop_id=$1 AND username='owner'",[shop])).rows[0].id;
    const staff={id:user,shop_id:shop,role:'owner',verified:true};
    const agent={id:'agent-synthetic',shop_id:shop,role:'print_agent',
      verified:true,printer_ids:[printer]};
    const draft=await core.service.createDraft(staff,{
      customer_id:customer,conversation_id:conv,
      request_data:{documents:[{artifact_name:'fixture.png',
        copies:151,paper:'A4',duplex:false,orientation:'portrait'}]},
      idempotency_key:'draft-'+randomUUID()
    });
    orderId=draft.order_id;
    // Exercise the REAL AI3 processor and SHA-anchored manifest/preview
    // with a generated local PNG, not a manually fabricated print plan.
    const fixturePath=join(inputRoot,'fixture.png');
    execFileSync('python3',['-c',
      'from PIL import Image;import sys;Image.new("RGB",(120,160),"white").save(sys.argv[1])',
      fixturePath],{timeout:15000});
    const run=execFileSync(process.execPath,['--import','tsx','scripts/process-order.ts',shop,orderId],{
      cwd:process.cwd(),encoding:'utf8',timeout:85000,maxBuffer:1024*1024,
      env:{...process.env,DATABASE_URL:url,AUTOIN_INPUT_ROOT:inputRoot,
        AUTOIN_ARTIFACT_ROOT:artifactRoot,AUTOIN_PROCESSOR_ID:'ai0-verified-e2e',
        AUTOIN_PYTHON:'python3'}
    });
    const revision=JSON.parse(run);
    assert.equal(revision.revision,2);
    assert.equal(revision.requires_reconfirmation,true);
    const catalog=await loadVerifiedOrderPreviewCatalog(sql,artifactRoot,staff,orderId,2);
    assert.equal(catalog.preview_verified,true);
    assert.equal(catalog.files?.[0]?.physical_sheets,151);
    assert.ok(catalog.preview_count>=1,'AI3 must render a verifiable preview');
    // A changed *frozen source*, even with intact PNG, revokes every
    // verified preview and per-file metric. Restore to finish the same order.
    const planRow=(await pool.query(
      'SELECT plan FROM core_revisions WHERE order_id=$1 AND revision=2',
      [orderId])).rows[0].plan;
    const manifest=JSON.parse(await readFile(join(artifactRoot,planRow.artifact_ref),'utf8'));
    const source=join(artifactRoot,manifest.files[0].source_artifact_ref);
    const frozen=await readFile(source);
    await chmod(source,0o600);
    await writeFile(source,Buffer.from('SOURCE_CHANGED_AFTER_AI3_RENDER'));
    await assert.rejects(
      loadVerifiedOrderPreviewCatalog(sql,artifactRoot,staff,orderId,2),
      error=>error.code==='DOCUMENT_SOURCE_CHANGED'
    );
    await writeFile(source,frozen);
    assert.equal((await loadVerifiedOrderPreviewCatalog(sql,artifactRoot,staff,orderId,2)).preview_verified,true);

    const quote=await core.service.setQuote(staff,orderId,{
      expected_revision:2,amount_vnd:30000,deposit_required_vnd:6000,
      significant_cost:false,idempotency_key:'quote-'+randomUUID()});
    assert.equal(quote.quote_revision,1);

    const webhook=createSyntheticZaloIngress(pool,{
      kind:'synthetic_fixture',shop_id:shop,oa_id:oa,fixture_key:inboundKey});
    app=buildIntegratedApp({pool:sql,zaloWebhook:webhook,
      syntheticVerifiedButton:{kind:'synthetic_fixture',shop_id:shop,oa_id:oa,fixture_secret:buttonKey}});
    await app.ready();
    const now=new Date().toISOString();
    const textPayload={synthetic_fixture:true,event_id:textId,oa_id:oa,
      customer_id:customer,conversation_id:conv,occurred_at:now,kind:'text',text:'OK'};
    const rawOk=await app.inject({method:'POST',url:'/webhooks/zalo',
      headers:{'content-type':'application/json','x-test-fixture-key':inboundKey},
      payload:JSON.stringify(textPayload)});
    assert.equal(rawOk.statusCode,200,JSON.stringify(rawOk.json()));
    assert.equal(rawOk.json().status,'accepted');
    const candidates=new PostgresConfirmationCandidates({
      transaction:fn=>core.store.tx(tx=>fn({query:(q,args=[])=>tx.query(q,[...args])}))
    },shop,oa);
    const batch={key:'isolated',first_at:Date.now(),deadline_at:Date.now(),
      events:[{event_id:textId,oa_id:oa,customer_id:customer,
        conversation_id:conv,occurred_at:now,kind:'text',text:'OK'}]};
    assert.deepEqual(await candidates.consider({batch,expected_generation:0}),
      {status:'pending',reason:'CHALLENGE_PORT_UNAVAILABLE'});
    assert.equal(await count('core_confirmations'),0,'Plain OK is never consent');

    const port=createVerifiedConfirmationPort({store:core.store,trusted:{shop_id:shop,oa_id:oa}});
    const request={order_id:orderId,expected_revision:2,
      request_hash:draft.request_hash,kind:'request',expected_generation:0};
    const rc=await port.issue_challenge(request);
    assert.equal(rc.status,'issued');
    await assert.rejects(core.service.approve(staff,orderId,{
      expected_revision:2,quote_revision:1,acknowledge_deposit_shortage:true,
      idempotency_key:'approve-before-'+randomUUID()
    }),e=>e.code==='CUSTOMER_NOT_CONFIRMED');
    assert.equal(await count('core_print_jobs'),0);
    const good=button(rc,'clicked-'+randomUUID());
    assert.equal((await submit(good,{signature:'0'.repeat(64)})).statusCode,403);
    assert.equal((await submit({...good,oa_id:'wrong-oa'})).statusCode,422);
    assert.equal((await submit({...good,customer_id:'wrong-customer'})).statusCode,403);
    assert.equal((await submit({...good,type:'text',text:'OK'})).statusCode,422);
    assert.equal((await submit(button(rc,'bad-token-'+randomUUID(),{challenge_token:'not-real'}))).statusCode,403);
    // The invalid token is signed by the fixture but rejected inside AI1.
    // It must never record a confirmation; the previous response is a 403.
    assert.equal(await count('core_confirmations'),0);
    const [clickA,clickB]=await Promise.all([submit(good),submit(good)]);
    assert.deepEqual([clickA.statusCode,clickB.statusCode].sort(),[200,201]);
    assert.deepEqual([clickA.json().status,clickB.json().status].sort(),['confirmed','existing']);
    assert.equal(await count('core_confirmations'),1);
    assert.equal(await count('core_approvals'),0);
    assert.equal(await count('core_print_jobs'),0);
    assert.equal((await submit(good)).json().status,'existing','Lost ACK must be idempotent');
    const replayConflict=await submit(button(rc,good.event_id,{challenge_token:'different'}));
    assert.equal(replayConflict.statusCode,409);

    await assert.rejects(core.service.approve(staff,orderId,{
      expected_revision:2,quote_revision:1,acknowledge_deposit_shortage:true,
      idempotency_key:'before-price-'+randomUUID()
    }),e=>e.code==='PRICE_CONFIRMATION_REQUIRED');
    const price={...request,kind:'quote',quote_revision:1};
    const priceChallenge=await port.issue_challenge(price);
    assert.equal(priceChallenge.status,'issued');
    assert.equal((await submit(button(priceChallenge,'price-'+randomUUID()))).statusCode,201);
    assert.equal(await count('core_confirmations'),2);
    assert.equal(await count('core_print_jobs'),0);
    await assert.rejects(core.service.approve(staff,orderId,{
      expected_revision:2,quote_revision:1,acknowledge_deposit_shortage:false,
      idempotency_key:'no-deposit-warning-'+randomUUID()
    }),e=>e.code==='DEPOSIT_WARNING_REQUIRED');
    const approved=await core.service.approve(staff,orderId,{
      expected_revision:2,quote_revision:1,acknowledge_deposit_shortage:true,
      idempotency_key:'staff-approval-'+randomUUID()
    });
    assert.equal(approved.deposit_short_vnd,6000);
    assert.equal(await count('core_print_jobs'),1);
    assert.equal(await count('core_approvals'),1);
    const claimed=await core.service.claim(agent,{printer_id:printer,idempotency_key:'claim-'+randomUUID()});
    assert.equal(claimed.job?.order_id,orderId);
    assert.equal(claimed.job.mode,'simulation');
    const sent=await core.service.markSending(agent,claimed.job.job_id,{
      expected_revision:2,lease_token:claimed.job.lease_token,
      idempotency_key:'sending-'+randomUUID()});
    assert.equal(sent.state,'SENDING');
    const unknown=await core.service.report(agent,claimed.job.job_id,{
      expected_revision:2,lease_token:claimed.job.lease_token,
      result:'unknown',evidence_kind:'agent_uncertain',
      idempotency_key:'unknown-'+randomUUID()});
    assert.equal(unknown.state,'UNKNOWN');
    assert.deepEqual(await core.service.claim(agent,{
      printer_id:printer,idempotency_key:'no-resend-'+randomUUID()
    }),{job:null},'UNKNOWN must never resend');
  }finally{
    if(app)await app.close();
    if(created){
      await pool.query('DELETE FROM zalo_process_queue WHERE oa_id=$1',[oa]);
      await pool.query('DELETE FROM zalo_inbound_events WHERE oa_id=$1',[oa]);
      await pool.query('DELETE FROM core_verified_confirmation_events WHERE shop_id=$1',[shop]);
      await pool.query('DELETE FROM core_confirmation_challenges WHERE shop_id=$1',[shop]);
      await pool.query('DELETE FROM core_print_jobs WHERE order_id=$1',[orderId]);
      await pool.query('DELETE FROM core_approvals WHERE order_id=$1',[orderId]);
      await pool.query('DELETE FROM core_confirmations WHERE order_id=$1',[orderId]);
      await pool.query('DELETE FROM core_quotes WHERE order_id=$1',[orderId]);
      await pool.query('DELETE FROM core_audit WHERE shop_id=$1',[shop]);
      await pool.query('DELETE FROM ai0_verified_plan_manifests WHERE shop_id=$1',[shop]);
      await pool.query('DELETE FROM core_revisions WHERE order_id=$1',[orderId]);
      await pool.query('DELETE FROM core_orders WHERE shop_id=$1',[shop]);
      await pool.query('DELETE FROM core_conversation_controls WHERE shop_id=$1',[shop]);
      await pool.query('DELETE FROM core_idempotency WHERE shop_id=$1',[shop]);
      await pool.query('DELETE FROM core_sessions WHERE user_id IN (SELECT id FROM core_users WHERE shop_id=$1)',[shop]);
      await pool.query('DELETE FROM core_users WHERE shop_id=$1',[shop]);
      await pool.query('DELETE FROM core_shop_settings WHERE shop_id=$1',[shop]);
    }
    await pool.end();
    await rm(scratch,{recursive:true,force:true});
  }
});
