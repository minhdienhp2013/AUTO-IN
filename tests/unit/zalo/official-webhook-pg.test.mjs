import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID,createHash} from "node:crypto";
import {createOfficialZaloIngress} from "../../../backend/integrations/zalo/official-webhook.ts";
import {PostgresInboundEventRepository} from "../../../backend/integrations/zalo/postgres-events.ts";
import {createZaloTransactions} from "../../../backend/integrations/zalo/transaction-runner.ts";
import {assertIsolatedSimulationDatabase} from "../../../backend/composition/postgres.ts";

const url=process.env.TEST_DATABASE_URL??process.env.AUTOIN_TEST_DATABASE_URL;
if(url)assertIsolatedSimulationDatabase(url);
let pg;
if(url)try{pg=await import("pg")}catch{/* recorded by explicit test SKIP */}
test("Official documented MAC -> durable PostgreSQL ingress: 2 independent pools, duplicate/invalid sig safe",{
 skip:!url?"TEST_DATABASE_URL missing":!pg?"pg dependency unavailable":false
},async()=>{
 const Pool=pg.default?.Pool??pg.Pool;
 const poolA=new Pool({connectionString:url,max:4});
 const poolB=new Pool({connectionString:url,max:4});
 const unique=randomUUID().replaceAll("-","");
 const oa="oa-"+unique, app="app-"+unique,customer="user-"+unique;
 const secret="synthetic-only-oa-secret-not-for-production";
 const id="message-"+unique;
 const bytes=new TextEncoder().encode(JSON.stringify({
   app_id:app,timestamp:Date.now(),event_name:"user_send_text",
   sender:{id:customer},recipient:{id:oa},
   message:{msg_id:id,text:"In hai bản A4"}
 }));
 const data=JSON.parse(new TextDecoder().decode(bytes));
 const signature="mac="+createHash("sha256")
   .update(app).update(bytes).update(String(data.timestamp)).update(secret).digest("hex");
 const header={"x-zevent-signature":signature};
 const scope={app_id:app,oa_id:oa,oa_secret_key:secret,
   resolve_verified_user:(user)=>user===customer?{customer_id:"trusted-"+customer,conversation_id:"verified-conversation-"+unique}:null};
 const ingressA=createOfficialZaloIngress(scope,
   new PostgresInboundEventRepository(createZaloTransactions(poolA)));
 const ingressB=createOfficialZaloIngress(scope,
   new PostgresInboundEventRepository(createZaloTransactions(poolB)));
 const sql=(query,params=[])=>poolA.query(query,params);
 try{
   const dbname=(await sql("SELECT current_database() AS name")).rows[0].name;
   assert.match(dbname,/test/i,"Isolated TEST database required");
   assert.notEqual((await poolA.query("SELECT pg_backend_pid() AS p")).rows[0].p,
     (await poolB.query("SELECT pg_backend_pid() AS p")).rows[0].p);
   const results=await Promise.all([ingressA.receive(bytes,header),ingressB.receive(bytes,header)]);
   assert.deepEqual(results.map(r=>r.status).sort(),["accepted","duplicate"]);
   const rows=await sql("SELECT payload_json,received_at FROM zalo_inbound_events WHERE oa_id=$1 AND event_id=$2",[oa,id]);
   assert.equal(rows.rowCount,1);
   const payload=rows.rows[0].payload_json;
   assert.equal(payload.oa_id,oa);
   assert.equal(payload.customer_id,"trusted-"+customer);
   assert.equal(payload.conversation_id,"verified-conversation-"+unique);
   assert.equal(payload.kind,"text");
   assert.equal(payload.confirmation_postback,undefined);
   const queue=await sql("SELECT status FROM zalo_process_queue WHERE oa_id=$1 AND event_id=$2",[oa,id]);
   assert.equal(queue.rowCount,1);
   assert.equal(queue.rows[0].status,"QUEUED");
   await assert.rejects(ingressA.receive(bytes,{"x-zevent-signature":"mac="+("0".repeat(64))}),
     /WEBHOOK_SIGNATURE_REJECTED/);
   const again=await sql("SELECT count(*)::int AS n FROM zalo_inbound_events WHERE oa_id=$1",[oa]);
   assert.equal(again.rows[0].n,1);
 }finally{
   try{
     await sql("DELETE FROM zalo_process_queue WHERE oa_id=$1",[oa]);
     await sql("DELETE FROM zalo_inbound_events WHERE oa_id=$1",[oa]);
   }finally{await Promise.all([poolA.end(),poolB.end()])}
 }
});
