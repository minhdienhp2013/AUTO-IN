import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {createZaloPipeline} from "../../../backend/integrations/zalo/pipeline.ts";
import {SyntheticFixtureNormalizer,SyntheticTestVerifier} from "../../../backend/integrations/zalo/protocol.ts";
import {createZaloTransactions} from "../../../backend/integrations/zalo/transaction-runner.ts";

const databaseUrl=process.env.AUTOIN_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
let pg;
if(databaseUrl)try{pg=await import("pg")}catch{/* report actual blocker */}
test("CODE-402 REAL PostgreSQL: credential-bound candidates, dual workers, restart, replay and stale generation",{
  skip:!databaseUrl?"AUTOIN_TEST_DATABASE_URL / TEST_DATABASE_URL missing":!pg?"pg unavailable":false
},async()=>{
  const schema="ai2_confirm_"+randomUUID().replaceAll("-","").slice(0,12);
  const pool=new (pg.default?.Pool??pg.Pool)({connectionString:databaseUrl,max:5});
  const admin=await pool.connect();
  const shop="verified-shop",oa="signed-oa",customer="known-customer",conversation="known-conversation";
  const order=randomUUID(),hash="a".repeat(64),hash2="b".repeat(64),secret="synthetic-verified-key";
  const now=new Date().toISOString();
  const fixture=(id,text="OK",occurred_at=now,oa_id=oa,customer_id=customer)=>({
    synthetic_fixture:true,event_id:id,oa_id,customer_id,
    conversation_id:conversation,occurred_at,kind:"text",text
  });
  const raw=(...args)=>new TextEncoder().encode(JSON.stringify(fixture(...args)));
  const headers={"x-test-fixture-key":secret};
  try{
    const dbName=(await admin.query("SELECT current_database() AS name")).rows[0].name;
    assert.match(dbName,/test/i,"requires disposable test database");
    await admin.query('CREATE SCHEMA "'+schema+'"');
    await admin.query('SET search_path TO "'+schema+'"');
    const migrate=async name=>{
      const path=fileURLToPath(new URL("../../../backend/integrations/zalo/migrations/"+name,import.meta.url));
      await admin.query(await readFile(path,"utf8"));
    };
    await admin.query("CREATE TABLE core_shop_settings(shop_id text PRIMARY KEY)");
    await admin.query("CREATE TABLE core_conversation_controls(shop_id text,conversation_id text,generation bigint,status text,PRIMARY KEY(shop_id,conversation_id))");
    await admin.query("CREATE TABLE core_orders(id uuid PRIMARY KEY,shop_id text,customer_id text,conversation_id text,active_revision integer)");
    await admin.query("CREATE TABLE core_revisions(order_id uuid,revision integer,request_hash char(64),PRIMARY KEY(order_id,revision))");
    await admin.query("CREATE TABLE core_quotes(order_id uuid,quote_revision integer)");
    await admin.query("CREATE TABLE core_confirmations(event_id text)");
    await admin.query(`CREATE TABLE test_issued_challenges(
      event_id text PRIMARY KEY,challenge_id text NOT NULL,server_issued boolean NOT NULL,
      shop_id text,oa_id text,customer_id text,conversation_id text,order_id uuid,
      kind text,active_revision integer,request_hash char(64),quote_revision integer,
      expected_generation integer,issued_at timestamptz,expires_at timestamptz)`);
    for(const file of ["001_zalo_durable.sql","002_zalo_oa_scope.sql","003_confirmation_candidates.sql"])await migrate(file);
    await admin.query("INSERT INTO core_shop_settings VALUES($1)",[shop]);
    await admin.query("INSERT INTO core_conversation_controls VALUES($1,$2,3,'AI')",[shop,conversation]);
    await admin.query("INSERT INTO core_orders VALUES($1,$2,$3,$4,1)",[order,shop,customer,conversation]);
    await admin.query("INSERT INTO core_revisions VALUES($1,1,$2)",[order,hash]);
    await admin.query("INSERT INTO core_revisions VALUES($1,2,$2)",[order,hash2]);
    await admin.query("INSERT INTO core_quotes VALUES($1,1)",[order]);
    const db={
      async transaction(work){
        const client=await pool.connect();
        try{
          await client.query("BEGIN");
          await client.query('SET LOCAL search_path TO "'+schema+'"');
          const tx={async query(sql,args=[]){
            const result=await client.query(sql,[...args]);
            return {rows:result.rows,rowCount:result.rowCount};
          }};
          const result=await work(tx);await client.query("COMMIT");return result;
        }catch(e){try{await client.query("ROLLBACK")}catch{}throw e}
        finally{client.release()}
      }
    };
    const query=(sql,args=[])=>db.transaction(tx=>tx.query(sql,args));
    const issue=async(id,overrides={})=>{
      const c={
        challenge_id:overrides.challenge_id??randomUUID(),
        server_issued:overrides.server_issued??true,
        shop_id:overrides.shop_id??shop,oa_id:overrides.oa_id??oa,
        customer_id:overrides.customer_id??customer,
        conversation_id:overrides.conversation_id??conversation,
        order_id:overrides.order_id??order,
        kind:overrides.kind??"request",
        active_revision:overrides.active_revision??1,
        request_hash:overrides.request_hash??hash,
        quote_revision:overrides.quote_revision??null,
        expected_generation:overrides.expected_generation??3,
        issued_offset:overrides.issued_offset??"-5 minutes",
        expires_offset:overrides.expires_offset??"5 minutes"
      };
      await query(`INSERT INTO test_issued_challenges
        (event_id,challenge_id,server_issued,shop_id,oa_id,customer_id,conversation_id,order_id,
         kind,active_revision,request_hash,quote_revision,expected_generation,issued_at,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now()+$14::interval,now()+$15::interval)`,
        [id,c.challenge_id,c.server_issued,c.shop_id,c.oa_id,c.customer_id,c.conversation_id,
         c.order_id,c.kind,c.active_revision,c.request_hash,c.quote_revision,
         c.expected_generation,c.issued_offset,c.expires_offset]);
      return c;
    };
    const challenges={async resolve_verified(tx,scope){
      const found=await tx.query(`SELECT * FROM test_issued_challenges
        WHERE event_id=$1 AND server_issued=true`,[scope.event_id]);
      const c=found.rows[0];if(!c)return null;
      return {proof:"server_verified_event_bound_challenge",
        challenge_id:c.challenge_id,shop_id:c.shop_id,oa_id:c.oa_id,
        customer_id:c.customer_id,conversation_id:c.conversation_id,
        bound_event_id:scope.event_id,order_id:c.order_id,
        kind:c.kind,active_revision:c.active_revision,request_hash:c.request_hash,
        quote_revision:c.quote_revision,expected_generation:c.expected_generation,
        issued_at:new Date(c.issued_at).toISOString(),
        expires_at:new Date(c.expires_at).toISOString()};
    }};
    const options={
      db,trusted_shop_id:shop,trusted_oa_id:oa,
      orders:{
        async suggest_draft(){throw Error("CONFIRMATION_MUST_NOT_CREATE_ORDER")},
        async route_human(){throw Error("CONFIRMATION_MUST_NOT_AUTO_ROUTE")}
      },
      documents:{async inspect(){throw Error("CONFIRMATION_MUST_NOT_INSPECT_DOCUMENTS")}},
      schedule:{allowed:()=>false},clock:{now:()=>new Date()},
      synthetic_provider:{kind:"synthetic_fixture",
        verifier:new SyntheticTestVerifier(secret),normalizer:new SyntheticFixtureNormalizer()},
      confirmation_challenges:challenges
    };
    const a=createZaloPipeline(options),b=createZaloPipeline(options);
    const enqueue=async(id,text="OK",occurred_at=now,oa_id=oa,customer_id=customer)=>{
      return a.receive_webhook(raw(id,text,occurred_at,oa_id,customer_id),headers);
    };
    const ingest=async(p=a)=>{
      const result=await p.tick_inbound();return result;
    };
    const due=async()=>query("UPDATE zalo_batches SET deadline_at=now()-interval '1 second' WHERE status='OPEN'");
    // A floating OK is always held: not a customer confirmation or draft.
    assert.equal((await enqueue("no-challenge")).body.status,"accepted");
    assert.equal((await ingest()).ingested,1);
    await due();
    const noChallenge=await ingest();
    assert.equal(noChallenge.held,1);
    assert.equal((await query("SELECT status FROM zalo_batches WHERE batch_key=$1",
      [JSON.stringify([oa,customer,conversation])])).rows[0].status,"NEEDS_HUMAN");
    assert.equal((await query("SELECT count(*)::int AS n FROM zalo_confirmation_candidates")).rows[0].n,0);
    assert.equal((await query("SELECT count(*)::int AS n FROM core_confirmations")).rows[0].n,0);

    // The same signed inbound event cannot enter twice. Two workers compete
    // for one PostgreSQL leased batch, not two candidate side effects.
    await issue("valid");
    assert.equal((await enqueue("valid")).body.status,"accepted");
    assert.equal((await enqueue("valid")).body.status,"duplicate");
    await ingest();
    await due();
    const [w1,w2]=await Promise.all([a.tick_inbound(),b.tick_inbound()]);
    assert.equal(w1.processed+w2.processed,1);
    assert.equal(w1.claimed+w2.claimed,1);
    assert.equal((await query("SELECT count(*)::int AS n FROM zalo_confirmation_candidates")).rows[0].n,1);
    assert.equal((await query("SELECT count(*)::int AS n FROM core_confirmations")).rows[0].n,0);
    // Lost worker ACK followed by concurrent restart must read the existing
    // committed candidate, never generate a second one or call AI1.confirm.
    const verifiedBatch={key:"retry",first_at:0,deadline_at:0,events:[fixture("valid")]};
    const [replayedA,replayedB]=await Promise.all([
      a.confirmations.consider({batch:verifiedBatch,expected_generation:3}),
      b.confirmations.consider({batch:verifiedBatch,expected_generation:3})
    ]);
    assert.deepEqual([replayedA.status,replayedB.status],["existing","existing"]);
    assert.equal(replayedA.candidate_id,replayedB.candidate_id);
    assert.equal((await query("SELECT count(*)::int AS n FROM zalo_confirmation_candidates")).rows[0].n,1);
    // App restart and repeated webhook never re-process or create a candidate.
    const restarted=createZaloPipeline(options);
    assert.equal((await restarted.receive_webhook(raw("valid"),headers)).body.status,"duplicate");
    assert.equal((await restarted.tick_inbound()).claimed,0);
    assert.equal((await query("SELECT count(*)::int AS n FROM zalo_confirmation_candidates")).rows[0].n,1);
    assert.equal((await restarted.tick_outbound()).disabled,true);

    // Wrong OA fails before persistence; wrong customer/challenge never qualifies.
    assert.equal((await enqueue("wrong-oa","OK",now,"other-oa")).status_code,422);
    await issue("wrong-customer",{customer_id:"another-customer"});
    await enqueue("wrong-customer");await ingest();await due();
    assert.equal((await ingest()).held,1);
    assert.equal((await query("SELECT count(*)::int AS n FROM zalo_confirmation_candidates")).rows[0].n,1);

    // CODE-402: provider clock claims a valid reply, but the authoritative
    // PostgreSQL receipt predates challenge issuance. This is NOT consent.
    // A disposable fixture moves received_at to reproduce a delayed/replayed
    // webhook without changing any production ingress or verification code.
    await issue("forged-time-before-challenge",{issued_offset:"-1 minute"});
    assert.equal((await enqueue("forged-time-before-challenge","OK",now)).body.status,"accepted");
    await query(`UPDATE zalo_inbound_events
      SET received_at=now()-interval '3 minutes'
      WHERE oa_id=$1 AND event_id=$2`,[oa,"forged-time-before-challenge"]);
    await ingest();await due();
    assert.equal((await ingest()).held,1);
    assert.equal((await query("SELECT count(*)::int AS n FROM zalo_confirmation_candidates")).rows[0].n,1);

    // Provider occurred_at also cannot extend the challenge expiry or the
    // server's receipt window, even when the provider timestamp appears valid.
    await issue("forged-time-after-expiry");
    assert.equal((await enqueue("forged-time-after-expiry","OK",now)).body.status,"accepted");
    await query(`UPDATE zalo_inbound_events
      SET received_at=now()+interval '10 minutes'
      WHERE oa_id=$1 AND event_id=$2`,[oa,"forged-time-after-expiry"]);
    await ingest();await due();
    assert.equal((await ingest()).held,1);
    assert.equal((await query("SELECT count(*)::int AS n FROM zalo_confirmation_candidates")).rows[0].n,1);
    assert.equal((await query("SELECT count(*)::int AS n FROM core_confirmations")).rows[0].n,0);

    // Old event before challenge issuance, stale revision/hash, stale quote.
    await issue("old-event",{issued_offset:"-1 minute"});
    const old=new Date(Date.now()-4*60*1000).toISOString();
    await enqueue("old-event","OK",old);await ingest();await due();
    assert.equal((await ingest()).held,1);
    await issue("stale-revision",{request_hash:hash2});
    await enqueue("stale-revision");await ingest();await due();
    assert.equal((await ingest()).held,1);
    await issue("quote-mismatch",{kind:"quote",quote_revision:2});
    await enqueue("quote-mismatch");await ingest();await due();
    assert.equal((await ingest()).held,1);

    // A valid price-specific challenge may only produce a candidate for the
    // exact current quote. It never writes a confirmation or opens a print job.
    await issue("price",{kind:"quote",quote_revision:1});
    await enqueue("price");await ingest();await due();
    assert.equal((await ingest()).processed,1);
    const price=(await query("SELECT kind,quote_revision FROM zalo_confirmation_candidates WHERE event_id='price'")).rows[0];
    assert.deepEqual(price,{kind:"quote",quote_revision:1});

    // Staff takeover/recovery increments generation. Old signed events cannot
    // create candidates even when their challenges remain in server storage.
    await issue("takeover");
    await enqueue("takeover");await ingest();await due();
    await query("UPDATE core_conversation_controls SET generation=4,status='HUMAN' WHERE shop_id=$1 AND conversation_id=$2",[shop,conversation]);
    assert.equal((await ingest()).held,1);
    await query("UPDATE core_conversation_controls SET generation=5,status='AI' WHERE shop_id=$1 AND conversation_id=$2",[shop,conversation]);
    assert.equal((await restarted.tick_inbound()).claimed,0);
    assert.equal((await query("SELECT count(*)::int AS n FROM zalo_confirmation_candidates")).rows[0].n,2);

    // A replay with a reused challenge ID cannot bind a second event.
    const prior=(await query("SELECT challenge_id FROM test_issued_challenges WHERE event_id='valid'")).rows[0].challenge_id;
    await issue("challenge-replay",{challenge_id:prior,expected_generation:5});
    await enqueue("challenge-replay");await ingest();await due();
    assert.equal((await ingest()).held,1);
    assert.equal((await query("SELECT count(*)::int AS n FROM zalo_confirmation_candidates")).rows[0].n,2);
    assert.equal((await query("SELECT count(*)::int AS n FROM core_confirmations")).rows[0].n,0);
  }finally{
    try{await admin.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE')}
    finally{admin.release();await pool.end()}
  }
});
