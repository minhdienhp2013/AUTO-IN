import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import {createZaloPipeline} from "../../../backend/integrations/zalo/pipeline.ts";
import {SyntheticFixtureNormalizer,SyntheticTestVerifier} from "../../../backend/integrations/zalo/protocol.ts";
import {createZaloTransactions} from "../../../backend/integrations/zalo/transaction-runner.ts";

const databaseUrl=process.env.TEST_DATABASE_URL??process.env.AUTOIN_TEST_DATABASE_URL;
let pg;
if(databaseUrl)try{pg=await import("pg")}catch{/* report PostgreSQL dependency as SKIP */}

test("REAL PostgreSQL AI2: image HUMAN route survives committed lost ACK and worker restart",{
  skip:!databaseUrl?"TEST_DATABASE_URL missing: image handover recovery NOT RUN":
    !pg?"pg dependency unavailable: image handover recovery NOT RUN":false,
  timeout:30_000
},async()=>{
  const Pool=pg.default?.Pool??pg.Pool;
  const pool=new Pool({connectionString:databaseUrl,max:8,connectionTimeoutMillis:5_000});
  const schema="ai2_image_handover_"+randomUUID().replaceAll("-","").slice(0,16);
  let schemaCreated=false;
  const id=randomUUID().replaceAll("-","");
  const shop="synthetic-shop-"+id,oa="synthetic-oa-"+id;
  const customer="synthetic-customer-"+id,conversation="synthetic-chat-"+id;
  const eventId="synthetic-image-"+id;

  const scopedPool={
    async connect(){
      const client=await pool.connect();
      try{await client.query(`SET search_path TO "${schema}"`);return client}
      catch(error){client.release();throw error}
    },
    async query(sql,params=[]){
      const client=await this.connect();
      try{return params.length?await client.query(sql,params):await client.query(sql)}
      finally{client.release()}
    }
  };
  const db=createZaloTransactions(scopedPool);
  const query=(sql,params=[])=>scopedPool.query(sql,params);

  const event={synthetic_fixture:true,event_id:eventId,oa_id:oa,customer_id:customer,
    conversation_id:conversation,occurred_at:new Date().toISOString(),kind:"image",
    file_ref:`custody:synthetic:sha256:${"a".repeat(64)}`,
    filename:"sample.jpg",mime_type:"image/jpeg"};
  const raw=new TextEncoder().encode(JSON.stringify(event));
  const fixtureKey="synthetic-fixture-key-"+id;
  const headers={"x-test-fixture-key":fixtureKey};
  const sideEffects={routeCalls:[],documents:0,classifier:0,drafts:0,appends:0};
  let loseRouteAck=true;

  // AI1's route_human Port is represented by a real PostgreSQL CAS transaction.
  // The error is injected only after COMMIT to model an ACK lost in transit.
  const orders={
    async route_human(input){
      sideEffects.routeCalls.push(structuredClone(input));
      const result=await db.transaction(async tx=>{
        const current=await tx.query(`SELECT generation::text AS generation,status
          FROM core_conversation_controls WHERE shop_id=$1 AND conversation_id=$2 FOR UPDATE`,
          [shop,input.conversation_id]);
        const row=current.rows[0];
        if(!row||Number(row.generation)!==input.expected_generation)
          return {status:"stale_generation"};
        if(row.status==="HUMAN")
          return {status:"already_routed",generation:Number(row.generation)};
        const next=input.expected_generation+1;
        const changed=await tx.query(`UPDATE core_conversation_controls
          SET status='HUMAN',claimed_by=NULL,generation=$3,ai_route_reason=$4,updated_at=now()
          WHERE shop_id=$1 AND conversation_id=$2 AND status='AI' AND generation=$5`,
          [shop,input.conversation_id,next,input.reason,input.expected_generation]);
        if(changed.rowCount!==1)return {status:"stale_generation"};
        return {status:"routed",generation:next};
      });
      if(loseRouteAck&&result.status==="routed"){
        loseRouteAck=false;
        throw new Error("SYNTHETIC_ROUTE_ACK_LOST");
      }
      return result;
    },
    async suggest_draft(){sideEffects.drafts++;throw new Error("IMAGE_MUST_NOT_CREATE_DRAFT")},
    async apply_incoming_batch(){sideEffects.appends++;throw new Error("IMAGE_MUST_NOT_CREATE_ORDER")}
  };
  const options={db,trusted_shop_id:shop,trusted_oa_id:oa,orders,
    documents:{async inspect(){sideEffects.documents++;throw new Error("IMAGE_MUST_NOT_REACH_OCR")}},
    classifier:{async classify(){sideEffects.classifier++;throw new Error("IMAGE_MUST_NOT_REACH_AI")}},
    schedule:{allowed:()=>true},clock:{now:()=>new Date()},
    synthetic_provider:{kind:"synthetic_fixture",
      verifier:new SyntheticTestVerifier(fixtureKey),normalizer:new SyntheticFixtureNormalizer()},
    mode:"simulation"};

  try{
    const dbName=(await pool.query("SELECT current_database() AS name")).rows[0].name;
    assert.match(dbName,/test/i,"requires a disposable PostgreSQL test database");
    await pool.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated=true;

    // Keep every run in a unique schema and use the repository's actual DDL.
    for(const migration of [
      "001_core.sql","002_send_mode.sql","003_confirmed_queue.sql",
      "004_conversation_generation.sql","005_ai_order_port.sql"
    ]){
      const sql=await readFile(new URL(`../../../backend/storage/migrations/${migration}`,import.meta.url),"utf8");
      await query(sql);
    }
    for(const migration of [
      "001_zalo_durable.sql","002_zalo_oa_scope.sql","003_confirmation_candidates.sql"
    ]){
      const sql=await readFile(new URL(`../../../backend/integrations/zalo/migrations/${migration}`,import.meta.url),"utf8");
      await query(sql);
    }

    await query("INSERT INTO core_shop_settings(shop_id) VALUES($1)",[shop]);
    await query(`INSERT INTO core_conversation_controls(shop_id,conversation_id,generation,status)
      VALUES($1,$2,7,'AI')`,[shop,conversation]);

    const firstRuntime=createZaloPipeline(options);
    const accepted=await firstRuntime.receive_webhook(raw,headers);
    assert.deepEqual(accepted,{status_code:200,body:{status:"accepted",event_id:eventId}});
    assert.equal((await firstRuntime.queue.ingest_pending()),1);
    await query("UPDATE zalo_batches SET deadline_at=clock_timestamp()-interval '1 second' WHERE oa_id=$1 AND status='OPEN'",[oa]);

    const first=await firstRuntime.tick_inbound();
    assert.deepEqual(first,{ingested:0,claimed:1,processed:0,held:0,needs_human:0,retry:1});
    assert.equal(sideEffects.routeCalls.length,1,"the Core HUMAN transaction committed exactly once");
    assert.equal(sideEffects.routeCalls[0].reason,"IMAGE_V1");
    assert.deepEqual(sideEffects.routeCalls[0].event_ids,[eventId]);
    assert.equal(sideEffects.routeCalls[0].expected_generation,7);

    const afterLostAck=(await query(`SELECT b.status,b.attempts,b.last_error_code,
        c.status AS control_status,c.generation::text AS generation,
        e.kind,e.file_ref,q.status AS ingress_status
      FROM zalo_batches b
      JOIN zalo_batch_items i ON i.batch_id=b.id
      JOIN zalo_inbound_events e ON e.oa_id=i.oa_id AND e.event_id=i.event_id
      JOIN zalo_process_queue q ON q.oa_id=i.oa_id AND q.event_id=i.event_id
      JOIN core_conversation_controls c ON c.shop_id=$1 AND c.conversation_id=$2
      WHERE i.oa_id=$3 AND i.event_id=$4`,[shop,conversation,oa,eventId])).rows[0];
    assert.equal(afterLostAck.status,"OPEN","lost worker ACK retries the durable batch");
    assert.equal(afterLostAck.attempts,1);
    assert.equal(afterLostAck.last_error_code,"SYNTHETIC_ROUTE_ACK_LOST");
    assert.equal(afterLostAck.control_status,"HUMAN");
    assert.equal(afterLostAck.generation,"8");
    assert.equal(afterLostAck.kind,"image");
    assert.equal(afterLostAck.file_ref,event.file_ref);
    assert.equal(afterLostAck.ingress_status,"COMMITTED");

    // A new pipeline instance represents process restart. Make the retry due
    // immediately; persisted HUMAN must hold the source rather than route again.
    await query("UPDATE zalo_batches SET deadline_at=clock_timestamp()-interval '1 second' WHERE oa_id=$1 AND status='OPEN'",[oa]);
    const restarted=createZaloPipeline(options);
    const recovered=await restarted.tick_inbound();
    assert.deepEqual(recovered,{ingested:0,claimed:1,processed:0,held:1,needs_human:0,retry:0});
    const replay=await restarted.receive_webhook(raw,headers);
    assert.deepEqual(replay,{status_code:200,body:{status:"duplicate",event_id:eventId}});
    assert.equal((await restarted.tick_inbound()).claimed,0,"terminal NEEDS_HUMAN is not auto-replayed");

    const finalRows=(await query(`SELECT b.status,b.attempts,b.event_count,c.status AS control_status,
        c.generation::text AS generation,e.kind,e.file_ref,q.status AS ingress_status
      FROM zalo_batches b
      JOIN zalo_batch_items i ON i.batch_id=b.id
      JOIN zalo_inbound_events e ON e.oa_id=i.oa_id AND e.event_id=i.event_id
      JOIN zalo_process_queue q ON q.oa_id=i.oa_id AND q.event_id=i.event_id
      JOIN core_conversation_controls c ON c.shop_id=$1 AND c.conversation_id=$2
      WHERE i.oa_id=$3 AND i.event_id=$4`,[shop,conversation,oa,eventId])).rows;
    assert.equal(finalRows.length,1,"one durable source remains linked to one batch");
    assert.deepEqual(finalRows[0],{status:"NEEDS_HUMAN",attempts:2,event_count:1,
      control_status:"HUMAN",generation:"8",kind:"image",file_ref:event.file_ref,
      ingress_status:"COMMITTED"});
    assert.equal(sideEffects.routeCalls.length,1,"restart cannot duplicate route_human");
    assert.equal(sideEffects.documents,0,"image never reaches document inspection/OCR");
    assert.equal(sideEffects.classifier,0,"image never reaches AI classification");
    assert.equal(sideEffects.drafts,0);
    assert.equal(sideEffects.appends,0);
    assert.equal((await query("SELECT count(*)::int AS n FROM core_orders WHERE shop_id=$1",[shop])).rows[0].n,0);
    assert.equal((await query("SELECT count(*)::int AS n FROM core_ai_draft_proposals WHERE shop_id=$1",[shop])).rows[0].n,0);
    assert.equal((await query("SELECT count(*)::int AS n FROM zalo_confirmation_candidates WHERE shop_id=$1",[shop])).rows[0].n,0);
    assert.equal((await query("SELECT count(*)::int AS n FROM core_confirmations WHERE order_id IN (SELECT id FROM core_orders WHERE shop_id=$1)",[shop])).rows[0].n,0);
    assert.equal((await query("SELECT count(*)::int AS n FROM core_approvals WHERE order_id IN (SELECT id FROM core_orders WHERE shop_id=$1)",[shop])).rows[0].n,0);
    assert.equal((await query("SELECT count(*)::int AS n FROM core_print_jobs WHERE order_id IN (SELECT id FROM core_orders WHERE shop_id=$1)",[shop])).rows[0].n,0);
    assert.equal((await query("SELECT count(*)::int AS n FROM zalo_outbound WHERE shop_id=$1 AND oa_id=$2",[shop,oa])).rows[0].n,0);
    assert.deepEqual(await restarted.tick_outbound(),
      {attempted:0,sent:0,unknown:0,blocked:0,disabled:true});
  }finally{
    if(schemaCreated)await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool.end();
  }
});
