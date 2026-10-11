import test from "node:test";
import assert from "node:assert/strict";
import {randomBytes} from "node:crypto";
import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {PostgresInboundEventRepository} from "../../../backend/integrations/zalo/postgres-events.ts";
import {PostgresConversationQueue,PostgresOutboundRepository} from "../../../backend/integrations/zalo/postgres-durable.ts";
import {OutboundDispatcher} from "../../../backend/conversation/gate.ts";
import {CoreConversationGate} from "../../../backend/integrations/zalo/core-gate.ts";

const databaseUrl=process.env.AUTOIN_TEST_DATABASE_URL;
let pg;
if(databaseUrl)try{pg=await import("pg")}catch{ /* clearly SKIP if dependency absent */ }
test("CODE-202 PostgreSQL real transaction/restart/concurrency",{
  skip:!databaseUrl?"AUTOIN_TEST_DATABASE_URL not set":
    !pg?"pg package not installed":false
},async()=>{
  const schema="ai2_test_"+randomBytes(7).toString("hex");
  const pool=new (pg.default?.Pool??pg.Pool)({connectionString:databaseUrl,max:5});
  const admin=await pool.connect();
  try {
    // Isolated schema in a test database. Never alter production schema.
    await admin.query('CREATE SCHEMA "'+schema+'"');
    await admin.query('SET search_path TO "'+schema+'"');
    const migration=await readFile(fileURLToPath(new URL("../../../backend/integrations/zalo/migrations/001_zalo_durable.sql",import.meta.url)),"utf8");
    await admin.query(migration);
    // Mirrors the AI1 migration 004 control row layout; isolated disposable schema.
    await admin.query(`CREATE TABLE core_conversation_controls (
      shop_id text NOT NULL,conversation_id text NOT NULL,generation bigint NOT NULL,
      status text NOT NULL CHECK(status IN ('AI','HUMAN')),
      PRIMARY KEY(shop_id,conversation_id))`);
    await admin.query("INSERT INTO core_conversation_controls VALUES ('trusted-shop','c1',1,'AI')");
    const db={
      async transaction(body){
        const cx=await pool.connect();
        try {
          await cx.query("BEGIN");
          await cx.query('SET LOCAL search_path TO "'+schema+'"');
          const result=await body({query:(sql,args=[])=>cx.query(sql,[...args])});
          await cx.query("COMMIT");return result;
        } catch(e){await cx.query("ROLLBACK");throw e;}
        finally{cx.release();}
      }
    };
    const run=(sql,args=[])=>db.transaction(tx=>tx.query(sql,args));
    const incoming=new PostgresInboundEventRepository(db);
    const event=id=>({event_id:id,oa_id:"oa",customer_id:"p1",
      conversation_id:"c1",occurred_at:"2026-10-11T07:00:00Z",kind:"text",text:"In A4"});
    const inserted=await Promise.all([incoming.insert_once(event("e1")),incoming.insert_once(event("e1"))]);
    assert.deepEqual(inserted.sort(),["duplicate","inserted"]);
    await incoming.insert_once(event("e2"));
    const durable=new PostgresConversationQueue(db);
    assert.equal(await durable.ingest_pending(),2);
    assert.equal(await durable.ingest_pending(),0);
    let batches=await run("SELECT event_count FROM zalo_batches WHERE status='OPEN'");
    assert.equal(batches.rows.length,1);assert.equal(batches.rows[0].event_count,2);
    await run("UPDATE zalo_batches SET deadline_at=now()-interval '1 second'");
    const claimed=await durable.claim_due();
    assert.equal(claimed.length,1);
    assert.deepEqual(claimed[0].events.map(e=>e.event_id),["e1","e2"]);
    // Simulated worker crash: lease expires, next worker recovers same batch.
    await run("UPDATE zalo_batches SET lease_until=now()-interval '1 second'");
    const recovered=await durable.claim_due();
    assert.equal(recovered.length,1);
    assert.equal(recovered[0].attempts,2);
    assert.equal(await durable.complete(claimed[0]),false);
    assert.equal(await durable.complete(recovered[0]),true);
    assert.equal((await durable.claim_due()).length,0);

    const gate=new CoreConversationGate(db,"trusted-shop");
    const outbox=new PostgresOutboundRepository(db,gate);
    const data={outbound_id:"r1",conversation_id:"c1",generation:1,text:"Vui lòng xác nhận"};
    await outbox.enqueue(data);await outbox.enqueue(data);
    let sent=0;
    const dispatcher=new OutboundDispatcher(
      gate,
      outbox,{async send_text(){sent++;throw Error("ambiguous provider timeout")}},
      {now:()=>new Date("2026-10-11T03:00:00Z")},{allowed:()=>true});
    assert.equal(await dispatcher.deliver(data),"unknown");
    assert.equal(await dispatcher.deliver(data),"blocked");
    assert.equal(sent,1);
    await outbox.enqueue(data);
    assert.equal((await run("SELECT status FROM zalo_outbound WHERE outbound_id='r1'")).rows[0].status,"UNKNOWN");
    await run("UPDATE core_conversation_controls SET generation=2,status='HUMAN' WHERE shop_id='trusted-shop' AND conversation_id='c1'");
    await outbox.enqueue({...data,outbound_id:"stale"});
    assert.equal(await outbox.reserve_if_current("stale","c1",1),false);
    assert.equal((await run("SELECT status FROM zalo_outbound WHERE outbound_id='stale'")).rows[0].status,"QUEUED");
    await run("UPDATE core_conversation_controls SET generation=3,status='AI' WHERE shop_id='trusted-shop' AND conversation_id='c1'");
    assert.equal(await outbox.reserve_if_current("stale","c1",1),false);

    // RESERVED after crash is uncertain, never automatically sent again.
    await outbox.enqueue({...data,outbound_id:"reserved",generation:3});
    assert.equal(await outbox.reserve_if_current("reserved","c1",3),true);
    await run("UPDATE zalo_outbound SET reserved_at=now()-interval '5 minutes' WHERE outbound_id='reserved'");
    assert.equal(await outbox.reconcile_stale_reserved(),1);
    assert.equal(await outbox.reserve_if_current("reserved","c1",3),false);

    // Two independent pool connections must not claim the same due batch.
    await Promise.all([incoming.insert_once(event("e3")),incoming.insert_once(event("e4"))]);
    const secondWorker=new PostgresConversationQueue(db);
    const moved=await Promise.all([durable.ingest_pending(),secondWorker.ingest_pending()]);
    assert.equal(moved.reduce((a,b)=>a+b,0),2);
    await run("UPDATE zalo_batches SET deadline_at=now()-interval '1 second' WHERE status='OPEN'");
    const claims=await Promise.all([durable.claim_due(1),secondWorker.claim_due(1)]);
    assert.equal(claims[0].length+claims[1].length,1);
    const only=claims[0][0]??claims[1][0];
    assert.deepEqual(only.events.map(e=>e.event_id),["e3","e4"]);
    assert.equal(await secondWorker.complete(only),true);

    // AI1 handover owns the row lock; reservation must see its NEW generation.
    await outbox.enqueue({...data,outbound_id:"race",generation:3});
    const controller=await pool.connect();
    try {
      await controller.query('BEGIN');
      await controller.query('SET LOCAL search_path TO "'+schema+'"');
      await controller.query("SELECT generation FROM core_conversation_controls WHERE shop_id='trusted-shop' AND conversation_id='c1' FOR UPDATE");
      const pending=outbox.reserve_if_current("race","c1",3);
      await controller.query("UPDATE core_conversation_controls SET generation=4,status='HUMAN' WHERE shop_id='trusted-shop' AND conversation_id='c1'");
      await controller.query('COMMIT');
      assert.equal(await pending,false);
    } catch(error) {await controller.query('ROLLBACK');throw error;}
    finally {controller.release();}
    assert.equal((await run("SELECT status FROM zalo_outbound WHERE outbound_id='race'")).rows[0].status,'QUEUED');

  } finally {
    try{await admin.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE')}finally{admin.release();await pool.end();}
  }
});
