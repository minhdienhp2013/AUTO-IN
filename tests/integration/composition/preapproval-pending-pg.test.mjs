import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {asSqlPool,assertIsolatedSimulationDatabase} from '../../../backend/composition/postgres.ts';
import {createCoreModule} from '../../../backend/core/factory.ts';
import {createAiOrderPort} from '../../../backend/core/ai-order-port.ts';
import {createSyntheticZaloIngress} from '../../../backend/composition/zalo-simulation.ts';
import {buildIntegratedApp} from '../../../backend/composition/runtime.ts';
import {pendingReviewSqlPool} from '../../../backend/composition/pending-review-errors.ts';

const databaseUrl=process.env.TEST_DATABASE_URL;

/**
 * AI0 P0 real-PG regression: a pre-approval inbound event that has not been
 * reconciled into the original order makes EVEN a direct SQL approval fail.
 * The trigger runs inside Core's actual PostgreSQL transaction; it is not
 * an HTTP-only, race-prone read precheck.
 *
 * This is an isolated/synthetic gate only: AI1 still owns production approval
 * authorization, and AI2 must implement append-to-current-order safely.
 */
test('CODE-008 real PG: unresolved signed Zalo event prevents approval despite forged future occurred_at',{
  skip:!databaseUrl?'TEST_DATABASE_URL missing: CODE-008 approval-gate NOT RUN':false,
  timeout:120000
},async()=>{
  assertIsolatedSimulationDatabase(databaseUrl);
  const pool=new pg.Pool({connectionString:databaseUrl,max:4,connectionTimeoutMillis:5000});
  const shop='autoin-test-gate-'+randomUUID(),oa='oa-'+randomUUID();
  const customer='customer-'+randomUUID(),conv='conversation-'+randomUUID();
  const key=randomUUID()+randomUUID();
  const core=createCoreModule({pool:asSqlPool(pool)});
  const svc=createAiOrderPort({store:core.store,trusted:{shop_id:shop,oa_id:oa}});
  let app,bootstrapped=false;
  const send=async(evt)=>{
    const response=await app.inject({method:'POST',url:'/webhooks/zalo',
      headers:{'content-type':'application/json','x-test-fixture-key':key},
      payload:JSON.stringify(evt)});
    assert.equal(response.statusCode,200,JSON.stringify(response.json()));
    return response.json();
  };
  const fixture=(eventId,kind='text',occurred_at=new Date().toISOString())=>({
    synthetic_fixture:true,event_id:eventId,oa_id:oa,
    customer_id:customer,conversation_id:conv,occurred_at,
    kind,...(kind==='text'?{text:'In A4'}:
      {filename:'additional.png',file_ref:'UNTRUSTED-CUSTOMER-PATH'})
  });
  try{
    const password='isolated-'+randomUUID();
    await core.auth.bootstrapOwner({shop_id:shop,username:'owner',
      password,bootstrap_enabled:true});
    bootstrapped=true;
    const actor=(await pool.query(
      "SELECT id FROM core_users WHERE shop_id=$1 AND username='owner'",[shop])).rows[0].id;
    app=buildIntegratedApp({pool:asSqlPool(pool),
      zaloWebhook:createSyntheticZaloIngress(pool,{
        kind:'synthetic_fixture',shop_id:shop,oa_id:oa,fixture_key:key
      })});
    await app.ready();
    const initialId='initial-'+randomUUID();
    assert.equal((await send(fixture(initialId))).status,'accepted');
    const proposal=await svc.suggest_draft({
      conversation_id:conv,customer_id:customer,event_ids:[initialId],
      text:'In A4',idempotency_key:'initial-'+randomUUID(),
      expected_generation:0
    });
    assert.equal(proposal.status,'created');
    const orderId=proposal.order_id;
    const rev=(await pool.query(
      'SELECT request_hash FROM core_revisions WHERE order_id=$1 AND revision=1',
      [orderId])).rows[0].request_hash;
    const insert=()=>pool.query(
      'INSERT INTO core_approvals(id,order_id,revision,request_hash,actor_id) VALUES($1,$2,1,$3,$4)',
      [randomUUID(),orderId,rev,actor]);

    // First original event is represented in immutable revision #1, so the
    // isolated DB admission check does not accidentally block the same event.
    // Roll back: an unsigned direct SQL approval is not valid business approval.
    const conn=await pool.connect();
    try{
      await conn.query('BEGIN');
      await conn.query('INSERT INTO core_approvals(id,order_id,revision,request_hash,actor_id) VALUES($1,$2,1,$3,$4)',
        [randomUUID(),orderId,rev,actor]);
      await conn.query('ROLLBACK');
    }finally{conn.release()}

    // Synthetic plan/credential only, NOT AI3 or real customer evidence.
    // Enough to reach the real staff admission boundary via authenticated HTTP.
    const plan={request_hash:rev,ready:true,printer_id:'RMP7000',
      verified_by:'TEST_ONLY_NOT_AI3',artifact_ref:'synthetic/no-real-artifact',
      document_pages:1,printed_faces:1,physical_sheets:1};
    await core.service.publishVerifiedPlan({id:'fixture-processor',shop_id:shop,role:'processor',verified:true},
      orderId,{expected_revision:1,plan,idempotency_key:'plan-'+randomUUID()});
    await core.service.confirm({id:'fixture-customer',shop_id:shop,customer_id:customer,role:'customer',verified:true},
      orderId,{expected_revision:2,kind:'request',idempotency_key:'confirm-'+randomUUID()});
    const session=await core.auth.login(shop,'owner',password);

    // A second signed file arrives BEFORE approval. The provider timestamp
    // is deliberately 60 seconds in the FUTURE; trusted received_at is NOW.
    const extraId='extra-'+randomUUID();
    const now=new Date(Date.now()+60_000).toISOString();
    assert.equal((await send(fixture(extraId,'image',now))).status,'accepted');
    const source=(await pool.query(
      'SELECT received_at,occurred_at FROM zalo_inbound_events WHERE oa_id=$1 AND event_id=$2',
      [oa,extraId])).rows[0];
    assert.ok(source.received_at.getTime()<source.occurred_at.getTime());
    await assert.rejects(insert(),error=>
      error.code==='P0001'&&error.message.includes('AI0_PENDING_INBOUND_REVIEW'));
    // Raw PostgreSQL still raises P0001. Only AI0's Core boundary translates it.
    const boundary=pendingReviewSqlPool(asSqlPool(pool));
    await assert.rejects(boundary.query(
      'INSERT INTO core_approvals(id,order_id,revision,request_hash,actor_id) VALUES($1,$2,1,$3,$4)',
      [randomUUID(),orderId,rev,actor]),error=>
      error.code==='PENDING_INBOUND_REVIEW'&&error.status===409&&!error.retryable);
    // Two staff requests, same real DB, must both reject with zero jobs.
    const responses=await Promise.all([1,2].map(()=>app.inject({method:'POST',
      url:'/api/v1/orders/'+orderId+'/approvals',
      headers:{authorization:'Bearer '+session.token},
      payload:{expected_revision:2,acknowledge_deposit_shortage:false,idempotency_key:'approval-'+randomUUID()}})));
    for(const response of responses){
      assert.equal(response.statusCode,409,response.body);
      assert.equal(response.json().error.code,'PENDING_INBOUND_REVIEW');
      assert.equal(response.json().error.retryable,false);
      assert.doesNotMatch(response.body,/P0001|AI0_PENDING|DETAIL|INSERT INTO/);
    }
    assert.equal((await pool.query(
      'SELECT count(*)::int AS n FROM core_approvals WHERE order_id=$1',
      [orderId])).rows[0].n,0);
    assert.equal((await pool.query(
      'SELECT count(*)::int AS n FROM core_print_jobs WHERE order_id=$1',
      [orderId])).rows[0].n,0);
    // The inbound event remains durable for staff. No auto-replay or deletion.
    assert.equal((await pool.query(
      'SELECT count(*)::int AS n FROM zalo_inbound_events WHERE oa_id=$1 AND event_id=$2',
      [oa,extraId])).rows[0].n,1);
    assert.equal((await pool.query(
      'SELECT count(*)::int AS n FROM core_orders WHERE shop_id=$1',[shop])).rows[0].n,1);
    assert.equal((await send(fixture(extraId,'image',now))).status,'duplicate');
    await assert.rejects(insert(),error=>
      error.code==='P0001'&&error.message.includes('AI0_PENDING_INBOUND_REVIEW'));
  }finally{
    if(app)await app.close();
    if(bootstrapped){
      await pool.query('DELETE FROM zalo_outbound WHERE shop_id=$1',[shop]);
      await pool.query('DELETE FROM zalo_batch_items WHERE oa_id=$1',[oa]);
      await pool.query('DELETE FROM zalo_batches WHERE oa_id=$1',[oa]);
      await pool.query('DELETE FROM zalo_process_queue WHERE oa_id=$1',[oa]);
      await pool.query('DELETE FROM zalo_inbound_events WHERE oa_id=$1',[oa]);
      await pool.query('DELETE FROM core_ai_draft_proposals WHERE shop_id=$1',[shop]);
      await pool.query('DELETE FROM core_audit WHERE shop_id=$1',[shop]);
      await pool.query('DELETE FROM core_idempotency WHERE shop_id=$1',[shop]);
      await pool.query('DELETE FROM core_confirmations WHERE order_id IN (SELECT id FROM core_orders WHERE shop_id=$1)',[shop]);
      await pool.query('DELETE FROM core_revisions WHERE order_id IN (SELECT id FROM core_orders WHERE shop_id=$1)',[shop]);
      await pool.query('DELETE FROM core_orders WHERE shop_id=$1',[shop]);
      await pool.query('DELETE FROM core_conversation_controls WHERE shop_id=$1',[shop]);
      await pool.query('DELETE FROM core_sessions WHERE user_id IN (SELECT id FROM core_users WHERE shop_id=$1)',[shop]);
      await pool.query('DELETE FROM core_users WHERE shop_id=$1',[shop]);
      await pool.query('DELETE FROM core_shop_settings WHERE shop_id=$1',[shop]);
    }
    await pool.end();
  }
});
