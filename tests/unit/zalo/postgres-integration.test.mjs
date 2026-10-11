import test from "node:test";
import assert from "node:assert/strict";
import {randomBytes} from "node:crypto";
import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {PostgresInboundEventRepository} from "../../../backend/integrations/zalo/postgres-events.ts";
import {PostgresConversationQueue,PostgresOutboundRepository} from "../../../backend/integrations/zalo/postgres-durable.ts";
import {OutboundDispatcher} from "../../../backend/conversation/gate.ts";

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
    await admin.query(`CREATE TABLE gate_controls (
      conversation_id text PRIMARY KEY,generation integer NOT NULL,
      mode text NOT NULL CHECK(mode IN ('AI','HUMAN','PAUSED')))`);
    await admin.query("INSERT INTO gate_controls VALUES ('c1',1,'AI')");
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

    const authority={
      async lock_if_current(tx,conversation_id,generation){
        const found=await tx.query("SELECT generation,mode FROM gate_controls WHERE conversation_id=$1 FOR UPDATE",[conversation_id]);
        return found.rows[0]?.generation===generation && found.rows[0]?.mode==="AI";
      }
    };
    const outbox=new PostgresOutboundRepository(db,authority);
    const data={outbound_id:"r1",conversation_id:"c1",generation:1,text:"Vui lòng xác nhận"};
    await outbox.enqueue(data);await outbox.enqueue(data);
    let sent=0;
    const dispatcher=new OutboundDispatcher(
      {async read(cid){return (await run("SELECT conversation_id,generation,mode FROM gate_controls WHERE conversation_id=$1",[cid])).rows[0];}},
      outbox,{async send_text(){sent++;throw Error("ambiguous provider timeout")}},
      {now:()=>new Date("2026-10-11T03:00:00Z")},{allowed:()=>true});
    assert.equal(await dispatcher.deliver(data),"unknown");
    assert.equal(await dispatcher.deliver(data),"blocked");
    assert.equal(sent,1);
    await outbox.enqueue(data);
    assert.equal((await run("SELECT status FROM zalo_outbound WHERE outbound_id='r1'")).rows[0].status,"UNKNOWN");
    await run("UPDATE gate_controls SET generation=2,mode='HUMAN' WHERE conversation_id='c1'");
    await outbox.enqueue({...data,outbound_id:"stale"});
    assert.equal(await outbox.reserve_if_current("stale","c1",1),false);
    assert.equal((await run("SELECT status FROM zalo_outbound WHERE outbound_id='stale'")).rows[0].status,"QUEUED");
    await run("UPDATE gate_controls SET generation=3,mode='AI' WHERE conversation_id='c1'");
    assert.equal(await outbox.reserve_if_current("stale","c1",1),false);

    // RESERVED after crash is uncertain, never automatically sent again.
    await outbox.enqueue({...data,outbound_id:"reserved",generation:3});
    assert.equal(await outbox.reserve_if_current("reserved","c1",3),true);
    await run("UPDATE zalo_outbound SET reserved_at=now()-interval '5 minutes' WHERE outbound_id='reserved'");
    assert.equal(await outbox.reconcile_stale_reserved(),1);
    assert.equal(await outbox.reserve_if_current("reserved","c1",3),false);
  } finally {
    try{await admin.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE')}finally{admin.release();await pool.end();}
  }
});
