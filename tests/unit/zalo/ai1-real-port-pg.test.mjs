import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createZaloPipeline} from '../../../backend/integrations/zalo/pipeline.ts';
import {createZaloTransactions} from '../../../backend/integrations/zalo/transaction-runner.ts';
import {SyntheticFixtureNormalizer,SyntheticTestVerifier} from '../../../backend/integrations/zalo/protocol.ts';

const databaseUrl=process.env.TEST_DATABASE_URL ?? process.env.AUTOIN_TEST_DATABASE_URL;
let pg,ai1,core;
if(databaseUrl) {
  try {
    pg=await import('pg');
    ai1=await import('../../../dist/backend/core/ai-order-port.js');
    core=await import('../../../dist/backend/core/service.js');
    const storage=await import('../../../dist/backend/storage/database.js');
    core={...core,PgStore:storage.PgStore};
  } catch { /* Explicit SKIP if AI1 port not integrated; never replace with mock. */ }
}
test('REAL PostgreSQL + REAL AI1 createAiOrderPort: new conversation, 2 workers, takeover, restart and UNKNOWN',{
  skip:!databaseUrl?'ISOLATED_TEST_DATABASE_URL_UNSET':!pg||!ai1||!core?'AI1_COMPILED_PORT_NOT_IN_INTEGRATION':false
},async()=>{
  const poolA=new (pg.default?.Pool??pg.Pool)({connectionString:databaseUrl,max:5});
  const poolB=new (pg.default?.Pool??pg.Pool)({connectionString:databaseUrl,max:5});
  const unique=randomUUID(),shop='zalo-port-test-'+unique,oa='oa-'+unique;
  const conv='conversation-'+unique,customer='customer-'+unique,staffId=randomUUID();
  const pass='synthetic-'+randomUUID();
  const ids=[0,1,2,3].map(n=>'event-'+n+'-'+unique);
  let createdShop=false;
  const run=(sql,args=[])=>poolA.query(sql,args);
  const bytes=(id,text='In A4')=>new TextEncoder().encode(JSON.stringify({
    synthetic_fixture:true,event_id:id,oa_id:oa,customer_id:customer,
    conversation_id:conv,occurred_at:'2026-10-12T03:00:00Z',
    kind:'text',text
  }));
  const key={'x-test-fixture-key':pass};
  const common={trusted_shop_id:shop,trusted_oa_id:oa,
    schedule:{allowed:()=>false},clock:{now:()=>new Date()},
    synthetic_provider:{kind:'synthetic_fixture',
      verifier:new SyntheticTestVerifier(pass),normalizer:new SyntheticFixtureNormalizer()}};
  try {
    assert.match((await run('SELECT current_database() AS name')).rows[0].name,/test/i);
    const a=await poolA.query('SELECT pg_backend_pid() AS pid');
    const b=await poolB.query('SELECT pg_backend_pid() AS pid');
    assert.notEqual(a.rows[0].pid,b.rows[0].pid);
    // AI1 owns migration 005; this independent AI2 test only invokes it
    // if the integration DB migration runner has not applied it.
    const migration=await readFile(fileURLToPath(new URL('../../../backend/storage/migrations/005_ai_order_port.sql',import.meta.url)),'utf8');
    await run(migration);
    await run('INSERT INTO core_shop_settings(shop_id) VALUES($1)',[shop]);createdShop=true;
    const pids=await run('INSERT INTO core_users(id,shop_id,username,password_hash,role) VALUES($1,$2,$3,$4,\'staff\') RETURNING id',
      [staffId,shop,'staff-'+unique,'fixture-not-a-real-hash']);
    assert.equal(pids.rowCount,1);
    const storeA=new core.PgStore(poolA);
    const storeB=new core.PgStore(poolB);
    const ordersA=ai1.createAiOrderPort({store:storeA,trusted:{shop_id:shop,oa_id:oa}});
    const ordersB=ai1.createAiOrderPort({store:storeB,trusted:{shop_id:shop,oa_id:oa}});
    const baseA={...common,db:createZaloTransactions(poolA),orders:ordersA,documents:{async inspect(){return []}}};
    const baseB={...common,db:createZaloTransactions(poolB),orders:ordersB,documents:{async inspect(){return []}}};
    const one=createZaloPipeline(baseA),two=createZaloPipeline(baseB);
    assert.equal((await one.receive_webhook(bytes(ids[0]),key)).body.status,'accepted');
    assert.equal((await two.receive_webhook(bytes(ids[0]),key)).body.status,'duplicate');
    assert.equal((await one.tick_inbound()).ingested,1);
    await run("UPDATE zalo_batches SET deadline_at=now()-interval '1 second' WHERE oa_id=$1 AND status='OPEN'",[oa]);
    const contenders=await Promise.all([one.tick_inbound(),two.tick_inbound()]);
    assert.equal(contenders.reduce((x,v)=>x+v.processed,0),1);
    const draftRows=(await run('SELECT order_id,idempotency_key FROM core_ai_draft_proposals WHERE shop_id=$1',[shop])).rows;
    assert.equal(draftRows.length,1);
    assert.equal((await run('SELECT count(*)::int AS n FROM core_orders WHERE shop_id=$1',[shop])).rows[0].n,1);
    assert.equal((await run('SELECT count(*)::int AS n FROM zalo_outbound WHERE shop_id=$1 AND oa_id=$2',[shop,oa])).rows[0].n,1);
    assert.deepEqual(await ordersB.suggest_draft({conversation_id:conv,customer_id:customer,
      event_ids:[ids[0]],text:'In A4',idempotency_key:draftRows[0].idempotency_key,
      expected_generation:0}),{status:'existing',order_id:draftRows[0].order_id});

    // Staff takes over DURING the AI3 inspection phase: AI1 Port must
    // not create a draft or stale outbound from the second event.
    let releaseInspection,reportInspection;
    const entered=new Promise(resolve=>{reportInspection=resolve});
    const wait=new Promise(resolve=>{releaseInspection=resolve});
    const slow=createZaloPipeline({...baseB,documents:{async inspect(){reportInspection();await wait;return []}}});
    assert.equal((await slow.receive_webhook(bytes(ids[1]),key)).body.status,'accepted');
    assert.equal((await slow.tick_inbound()).ingested,1);
    await run("UPDATE zalo_batches SET deadline_at=now()-interval '1 second' WHERE oa_id=$1 AND status='OPEN'",[oa]);
    const blocked=slow.tick_inbound();
    await entered;
    const staff={id:staffId,shop_id:shop,role:'staff',verified:true};
    const service=new core.OrderService(storeA);
    let claim;
    try{
      claim=await service.handover(staff,conv,{expected_generation:0,idempotency_key:'take-'+unique});
    }finally{releaseInspection()}
    assert.equal(claim.status,'HUMAN');assert.equal(claim.generation,1);
    const outcome=await blocked;
    assert.equal(outcome.held,1);
    const parked=(await run(`SELECT status,last_error_code FROM zalo_batches
      WHERE oa_id=$1 AND id IN (SELECT batch_id FROM zalo_batch_items WHERE event_id=$2)`,[oa,ids[1]])).rows[0];
    assert.deepEqual(parked,{status:'NEEDS_HUMAN',last_error_code:'GENERATION_HELD'});
    assert.equal((await run('SELECT count(*)::int AS n FROM core_ai_draft_proposals WHERE shop_id=$1',[shop])).rows[0].n,1);
    const returned=await service.returnToAi(staff,conv,{expected_generation:1,idempotency_key:'return-'+unique});
    assert.equal(returned.generation,2);
    assert.equal((await two.tick_inbound()).claimed,0); // held never replays on return
    assert.equal((await two.receive_webhook(bytes(ids[1]),key)).body.status,'duplicate');

    // Old outbound must not be reserved after return (generation 0 != 2).
    const old=(await one.outbox.list_queued()).find(v=>v.generation===0);
    assert.ok(old);
    assert.equal(await two.outbox.reserve_if_current(old.outbound_id,conv,0),false);
    assert.equal((await two.tick_outbound()).disabled,true);

    // New generation is allowed to propose a NEW draft for a new event;
    // intentionally do not send it. Simulate an ambiguous reservation result.
    assert.equal((await one.receive_webhook(bytes(ids[2]),key)).body.status,'accepted');
    await one.tick_inbound();
    await run("UPDATE zalo_batches SET deadline_at=now()-interval '1 second' WHERE oa_id=$1 AND status='OPEN'",[oa]);
    assert.equal((await two.tick_inbound()).processed,1);
    const current=(await two.outbox.list_queued()).find(v=>v.generation===2);
    assert.ok(current);
    assert.equal(await one.outbox.reserve_if_current(current.outbound_id,conv,2),true);
    await one.outbox.mark(current.outbound_id,'UNKNOWN');
    const restarted=createZaloPipeline(baseA);
    assert.equal((await restarted.outbox.list_queued()).some(x=>x.outbound_id===current.outbound_id),false);
    assert.equal((await restarted.tick_outbound()).disabled,true);
    assert.equal((await run('SELECT status FROM zalo_outbound WHERE outbound_id=$1',[current.outbound_id])).rows[0].status,'UNKNOWN');
    assert.equal((await run('SELECT count(*)::int AS n FROM core_ai_draft_proposals WHERE shop_id=$1',[shop])).rows[0].n,2);

    // AI1 route_human Port is separate from suggest_draft: it must move
    // the conversation to unclaimed HUMAN, never impersonate a staff member.
    assert.equal((await one.receive_webhook(bytes(ids[3],'in màu'),key)).body.status,'accepted');
    await one.tick_inbound();
    await run("UPDATE zalo_batches SET deadline_at=now()-interval '1 second' WHERE oa_id=$1 AND status='OPEN'",[oa]);
    const handoff=await two.tick_inbound();
    assert.equal(handoff.held,1); // generation changed by real AI1 Port
    const afterRoute=(await run(
      'SELECT generation::text AS generation,status,claimed_by FROM core_conversation_controls WHERE shop_id=$1 AND conversation_id=$2',
      [shop,conv])).rows[0];
    assert.deepEqual(afterRoute,{generation:'3',status:'HUMAN',claimed_by:null});
    assert.deepEqual(await ordersA.route_human({
      conversation_id:conv,reason:'COLOR_PRINT',event_ids:[ids[3]],expected_generation:2
    }),{status:'already_routed',generation:3});
    assert.deepEqual(await ordersB.route_human({
      conversation_id:conv,reason:'COLOR_PRINT',event_ids:[ids[3]],expected_generation:0
    }),{status:'stale_generation'});
    assert.equal((await run('SELECT count(*)::int AS n FROM core_ai_draft_proposals WHERE shop_id=$1',[shop])).rows[0].n,2);
    assert.equal((await one.receive_webhook(bytes(ids[3],'in màu'),key)).body.status,'duplicate');
    assert.equal((await one.tick_inbound()).claimed,0);

  } finally {
    if(createdShop) {
      // Disposable CI/test DB only, isolated shop and OA.
      await run('DELETE FROM zalo_outbound WHERE shop_id=$1 AND oa_id=$2',[shop,oa]);
      await run('DELETE FROM zalo_batch_items WHERE oa_id=$1',[oa]);
      await run('DELETE FROM zalo_batches WHERE oa_id=$1',[oa]);
      await run('DELETE FROM zalo_process_queue WHERE oa_id=$1',[oa]);
      await run('DELETE FROM core_ai_draft_proposals WHERE shop_id=$1',[shop]);
      await run('DELETE FROM core_audit WHERE shop_id=$1',[shop]);
      await run('DELETE FROM core_idempotency WHERE shop_id=$1',[shop]);
      await run('DELETE FROM core_revisions WHERE order_id IN (SELECT id FROM core_orders WHERE shop_id=$1)',[shop]);
      await run('DELETE FROM core_orders WHERE shop_id=$1',[shop]);
      await run('DELETE FROM core_conversation_controls WHERE shop_id=$1',[shop]);
      await run('DELETE FROM core_users WHERE shop_id=$1',[shop]);
      await run('DELETE FROM core_shop_settings WHERE shop_id=$1',[shop]);
      await run('DELETE FROM zalo_inbound_events WHERE oa_id=$1',[oa]);
    }
    await Promise.all([poolA.end(),poolB.end()]);
  }
});
