import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { asSqlPool, assertIsolatedSimulationDatabase } from '../../../backend/composition/postgres.ts';
import { createCoreModule } from '../../../backend/core/factory.ts';
import { createSyntheticZaloIngress } from '../../../backend/composition/zalo-simulation.ts';
import { buildIntegratedApp } from '../../../backend/composition/runtime.ts';
import { preflightSyntheticConfirmationCandidate } from '../../../backend/composition/confirmation-candidate.ts';
import { createVerifiedConfirmationPort } from '../../../backend/core/verified-confirmation-port.ts';
import { PgStore } from '../../../backend/storage/database.ts';

const url=process.env.TEST_DATABASE_URL;

/**
 * A signed synthetic Zalo message + a matching order only produce an
 * UNPRIVILEGED CANDIDATE, never a customer confirmation, approval, or job.
 */
test('CODE-007 real PG: signed OK requires credential; stale/wrong tenant/generation/quote fail closed', {
  skip:!url?'TEST_DATABASE_URL missing: CODE-007 customer-candidate NOT RUN':false,
  timeout:120_000
},async()=>{
  assertIsolatedSimulationDatabase(url);
  const pool=new pg.Pool({connectionString:url,connectionTimeoutMillis:5000,max:3});
  const shop='autoin-test-confirm-'+randomUUID();
  const oa='oa-'+randomUUID(),key=randomUUID()+randomUUID();
  const conversation='conv-'+randomUUID(),customer='customer-'+randomUUID();
  const scope={kind:'synthetic_fixture',shop_id:shop,oa_id:oa};
  const sql=asSqlPool(pool),core=createCoreModule({pool:sql});
  const eventId='evt-'+randomUUID(),wrongEvent='wrong-'+randomUUID();
  let app, orderId, created=false;
  try{
    await core.auth.bootstrapOwner({shop_id:shop,username:'owner',
      password:'synthetic-password-'+randomUUID(),bootstrap_enabled:true});
    created=true;
    const login=await pool.query(
      'SELECT id FROM core_users WHERE shop_id=$1 AND username=$2',[shop,'owner']);
    const staff={id:login.rows[0].id,shop_id:shop,role:'owner',verified:true};
    const draft=await core.service.createDraft(staff,{
      customer_id:customer,conversation_id:conversation,
      request_data:{documents:[{artifact_name:'fixture.png',paper:'A4',copies:1,duplex:false}]},
      idempotency_key:'candidate-draft-'+randomUUID()
    });
    orderId=draft.order_id;
    const requestHash=draft.request_hash;
    const webhook=createSyntheticZaloIngress(pool,{...scope,fixture_key:key});
    app=buildIntegratedApp({pool:sql,zaloWebhook:webhook});
    await app.ready();
    const fixture=(event_id,customer_id)=>({
      synthetic_fixture:true,event_id,oa_id:oa,
      conversation_id:conversation,customer_id,
      occurred_at:'2026-10-12T00:00:00Z',kind:'text',text:'OK'
    });
    const send=(payload)=>app.inject({method:'POST',url:'/webhooks/zalo',
      headers:{'content-type':'application/json','x-test-fixture-key':key},
      payload:JSON.stringify(payload)});
    assert.equal((await send(fixture(eventId,customer))).json().status,'accepted');
    assert.equal((await send(fixture(eventId,customer))).json().status,'duplicate');
    assert.equal((await send(fixture(wrongEvent,'not-'+customer))).json().status,'accepted');
    const input={order_id:orderId,event_id:eventId,expected_revision:1,
      expected_request_hash:requestHash,expected_generation:0,kind:'request'};
    const guard=changes=>preflightSyntheticConfirmationCandidate(sql,scope,{...input,...changes});
    assert.deepEqual(await guard({}),{status:'blocked',reason:'PLAN_NOT_VERIFIED'});
    const plan={ready:true,request_hash:requestHash,verified_by:'synthetic-test-only',
      artifact_ref:'doc-synthetic/manifest.json',printer_id:'NO_REAL_PRINTER',
      document_pages:1,printed_faces:1,physical_sheets:1};
    await pool.query('UPDATE core_revisions SET plan=$1::jsonb WHERE order_id=$2 AND revision=1',
      [JSON.stringify(plan),orderId]);
    const candidate=await guard({});
    assert.deepEqual(candidate,{status:'candidate_requires_credential',
      order_id:orderId,revision:1,request_hash:requestHash,kind:'request',
      quote_revision:null,customer_credential_verified:false});
    assert.deepEqual(await guard({event_id:wrongEvent}),
      {status:'blocked',reason:'SOURCE_NOT_BOUND'});
    assert.deepEqual(await preflightSyntheticConfirmationCandidate(sql,
      {...scope,oa_id:'other-oa'},input),
      {status:'blocked',reason:'SOURCE_NOT_BOUND'});
    assert.deepEqual(await preflightSyntheticConfirmationCandidate(sql,
      {...scope,shop_id:'other-shop'},input),
      {status:'blocked',reason:'SOURCE_NOT_BOUND'});
    assert.deepEqual(await guard({expected_generation:1}),
      {status:'blocked',reason:'GENERATION_CHANGED'});
    assert.deepEqual(await guard({expected_request_hash:'b'.repeat(64)}),
      {status:'blocked',reason:'STALE_REVISION'});
    assert.deepEqual(await guard({kind:'quote',quote_revision:1}),
      {status:'blocked',reason:'QUOTE_CHANGED'});
    const setQuote=await core.service.setQuote(staff,orderId,{
      expected_revision:1,amount_vnd:10000,deposit_required_vnd:0,
      significant_cost:false,idempotency_key:'quote-'+randomUUID()
    });
    assert.equal(setQuote.quote_revision,1);
    // CODE-007 boundary: even signed raw JSON cannot assert a postback token.
    // The AI2 normalizer explicitly discards customer-provided extra fields.
    // AI1 may only confirm a VERIFIED provider-specific button event, which
    // is NOT enabled in this synthetic text-only Zalo adapter.
    const confirmationPort=createVerifiedConfirmationPort({
      store:new PgStore(sql),trusted:{shop_id:shop,oa_id:oa}
    });
    const challenge=await confirmationPort.issue_challenge({
      order_id:orderId,expected_revision:1,request_hash:requestHash,
      expected_generation:0,kind:'request'
    });
    assert.equal(challenge.status,'issued');
    const maliciousId='forged-postback-'+randomUUID();
    const claimed={...fixture(maliciousId,customer),
      confirmation_postback:{
        kind:'verified_confirmation_accept',
        challenge_id:challenge.challenge_id,
        challenge_token:challenge.challenge_token
      }
    };
    const signed=await send(claimed);
    assert.equal(signed.statusCode,200,JSON.stringify(signed.json()));
    assert.equal(signed.json().status,'accepted');
    const storedMalicious=(await pool.query(
      'SELECT payload_json FROM zalo_inbound_events WHERE oa_id=$1 AND event_id=$2',
      [oa,maliciousId])).rows[0].payload_json;
    assert.equal(storedMalicious.confirmation_postback,undefined,
      'Synthetic verifier must not promote raw postback fields to trusted evidence');
    await assert.rejects(
      confirmationPort.confirm_verified_event({
        order_id:orderId,event_id:maliciousId,
        expected_revision:1,request_hash:requestHash,
        expected_generation:0,kind:'request'
      }),
      error=>error.code==='CONFIRMATION_CHALLENGE_REQUIRED'
    );
    const challengeAfter=(await pool.query(
      'SELECT consumed_event_id,confirmation_id FROM core_confirmation_challenges WHERE id=$1',
      [challenge.challenge_id])).rows[0];
    assert.equal(challengeAfter.consumed_event_id,null);
    assert.equal(challengeAfter.confirmation_id,null);
    assert.deepEqual(await guard({kind:'quote',quote_revision:2}),
      {status:'blocked',reason:'QUOTE_CHANGED'});
    assert.deepEqual(await guard({kind:'quote',quote_revision:1}),
      {status:'candidate_requires_credential',order_id:orderId,
       revision:1,request_hash:requestHash,kind:'quote',
       quote_revision:1,customer_credential_verified:false});
    await pool.query("UPDATE core_conversation_controls SET status='HUMAN',generation=1 WHERE shop_id=$1 AND conversation_id=$2",
      [shop,conversation]);
    assert.deepEqual(await guard({}),{status:'blocked',reason:'HUMAN_TAKEOVER'});
    await pool.query("UPDATE core_conversation_controls SET status='AI',generation=2 WHERE shop_id=$1 AND conversation_id=$2",
      [shop,conversation]);
    assert.deepEqual(await guard({}),{status:'blocked',reason:'GENERATION_CHANGED'});
    await pool.query('UPDATE core_orders SET manual_lock=true WHERE id=$1',[orderId]);
    assert.deepEqual(await guard({expected_generation:2}),{status:'blocked',reason:'ORDER_LOCKED'});
    await pool.query('UPDATE core_orders SET manual_lock=false,active_revision=2 WHERE id=$1',[orderId]);
    await pool.query('INSERT INTO core_revisions(order_id,revision,request_hash,request_data) VALUES($1,2,$2,$3::jsonb)',
      [orderId,'c'.repeat(64),JSON.stringify({documents:[]})]);
    assert.deepEqual(await guard({expected_generation:2}),{status:'blocked',reason:'STALE_REVISION'});
    // If a text candidate alone could create confirmations this would fail.
    for(const table of ['core_confirmations','core_approvals','core_print_jobs']){
      const n=await pool.query('SELECT count(*)::int AS count FROM '+table+' WHERE order_id=$1',[orderId]);
      assert.equal(n.rows[0].count,0,table+' must remain empty');
    }
  }finally{
    if(app)await app.close();
    if(created){
      await pool.query('DELETE FROM zalo_process_queue WHERE oa_id=$1',[oa]);
      await pool.query('DELETE FROM zalo_inbound_events WHERE oa_id=$1',[oa]);
      await pool.query('DELETE FROM core_ai_draft_proposals WHERE shop_id=$1',[shop]);
      await pool.query('DELETE FROM core_verified_confirmation_events WHERE shop_id=$1',[shop]);
      await pool.query('DELETE FROM core_confirmation_challenges WHERE shop_id=$1',[shop]);
      await pool.query('DELETE FROM core_quotes WHERE order_id=$1',[orderId]);
      await pool.query('DELETE FROM core_audit WHERE shop_id=$1',[shop]);
      await pool.query('DELETE FROM core_revisions WHERE order_id=$1',[orderId]);
      await pool.query('DELETE FROM core_orders WHERE shop_id=$1',[shop]);
      await pool.query('DELETE FROM core_conversation_controls WHERE shop_id=$1',[shop]);
      await pool.query('DELETE FROM core_sessions WHERE user_id IN (SELECT id FROM core_users WHERE shop_id=$1)',[shop]);
      await pool.query('DELETE FROM core_users WHERE shop_id=$1',[shop]);
      await pool.query('DELETE FROM core_shop_settings WHERE shop_id=$1',[shop]);
    }
    await pool.end();
  }
});
