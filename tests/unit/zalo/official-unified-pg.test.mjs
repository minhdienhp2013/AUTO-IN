import test from "node:test";
import assert from "node:assert/strict";
import {createHash,randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import {createOfficialZaloVerifiedIngress} from "../../../backend/integrations/zalo/official-quarantine.ts";
import {PostgresInboundEventRepository} from "../../../backend/integrations/zalo/postgres-events.ts";
import {createZaloTransactions} from "../../../backend/integrations/zalo/transaction-runner.ts";

const url=process.env.TEST_DATABASE_URL??process.env.AUTOIN_TEST_DATABASE_URL;
let pg;
if(url)try{pg=await import("pg")}catch{/* explicit PG SKIP */}
test("REAL PostgreSQL AI2 unified verified official ingress: text/held image-file-button, 2 pools, replay, no false consent",{
  skip:!url?"TEST_DATABASE_URL missing":!pg?"pg dependency unavailable":false,
  timeout:80000
},async()=>{
 const Pool=pg.default?.Pool??pg.Pool,unique=randomUUID().replaceAll("-","");
 const a=new Pool({connectionString:url,max:4}),b=new Pool({connectionString:url,max:4});
 const app="app-"+unique,oa="oa-"+unique,user="user-"+unique;
 const customer="trusted-customer-"+unique,conversation="trusted-conversation-"+unique;
 const secret="fixture-secret-for-isolated-pg-not-live",now=Date.now();
 const config={app_id:app,oa_id:oa,oa_secret_key:secret,now:()=>now,
  resolve_verified_user:uid=>uid===user?{customer_id:customer,conversation_id:conversation}:null};
 const ingressA=createOfficialZaloVerifiedIngress(config,
  new PostgresInboundEventRepository(createZaloTransactions(a)),createZaloTransactions(a));
 const ingressB=createOfficialZaloVerifiedIngress(config,
  new PostgresInboundEventRepository(createZaloTransactions(b)),createZaloTransactions(b));
 const create=(name,msg,sender=user,extra={})=>{
  const payload={app_id:app,timestamp:now,event_name:name,sender:{id:sender},
   recipient:{id:oa},message:msg,...extra};
  const bytes=new TextEncoder().encode(JSON.stringify(payload));
  const sig="mac="+createHash("sha256").update(app).update(bytes)
    .update(String(now)).update(secret).digest("hex");
  return {bytes,headers:{"x-zevent-signature":sig}};
 };
 const count=async(table)=>Number((await a.query("SELECT count(*)::int AS n FROM "+table+" WHERE oa_id=$1",[oa])).rows[0].n);
 try{
  assert.match((await a.query("SELECT current_database() n")).rows[0].n,/test/i);
  assert.notEqual((await a.query("SELECT pg_backend_pid() pid")).rows[0].pid,
    (await b.query("SELECT pg_backend_pid() pid")).rows[0].pid);
  // Only the OWNED AI2 migration is applied within this isolated test.
  // The AI0 production migration runner and approval trigger are NOT modified.
  await a.query(await readFile(new URL("../../../backend/integrations/zalo/migrations/004_official_quarantine.sql",import.meta.url),"utf8"));
  const t=create("user_send_text",{msg_id:"text-"+unique,text:"In A4 2 ban"});
  const [ta,tb]=await Promise.all([ingressA.receive(t.bytes,t.headers),ingressB.receive(t.bytes,t.headers)]);
  assert.deepEqual([ta.status,tb.status].sort(),["accepted","duplicate"]);
  assert.equal(await count("zalo_inbound_events"),1);
  assert.equal(await count("zalo_process_queue"),1);
  let text=(await a.query("SELECT payload_json,received_at FROM zalo_inbound_events WHERE oa_id=$1",[oa])).rows[0];
  assert.equal(text.payload_json.customer_id,customer);
  assert.equal(text.payload_json.conversation_id,conversation);
  assert.equal(text.payload_json.confirmation_postback,undefined);
  assert.ok(text.received_at);

  const cases=[["user_send_image","image"],["user_send_file","file"],
    ["user_click_button","click"],["unsupported_from_provider","unknown"]];
  for(const [name,kind] of cases){
   const id=name+"-"+unique,w=create(name,{msg_id:id,text:"untrusted:OK"});
   const [first,retry]=await Promise.all([ingressA.receive(w.bytes,w.headers),ingressB.receive(w.bytes,w.headers)]);
   assert.deepEqual([first.status,retry.status].sort(),["duplicate","held"]);
   assert.equal(first.receipt_id,retry.receipt_id);
   assert.equal(first.pending,true);
   assert.equal(first.kind,kind);
   assert.equal(first.provider_claimed_event_id,id);
   const rows=await a.query("SELECT kind,status,received_at,provider_claimed_event_id,customer_id,conversation_id FROM zalo_official_quarantine WHERE id=$1",[first.receipt_id]);
   assert.equal(rows.rowCount,1);
   assert.equal(rows.rows[0].kind,kind);
   assert.equal(rows.rows[0].status,"NEEDS_HUMAN");
   assert.ok(rows.rows[0].received_at);
   assert.equal(rows.rows[0].provider_claimed_event_id,id);
   assert.equal(rows.rows[0].customer_id,customer);
   assert.equal(rows.rows[0].conversation_id,conversation);
   assert.equal(await count("zalo_inbound_events"),1,"unknowns MUST NOT become trusted normal inbox events");
   assert.equal(await count("zalo_process_queue"),1,"unknowns MUST NOT enter AI's normal processing");
  }
  assert.equal(await count("zalo_official_quarantine"),4);
  const unknown=create("user_send_image",{msg_id:"stranger-"+unique},"unknown-user");
  const oaHeld=await ingressB.receive(unknown.bytes,unknown.headers);
  assert.equal(oaHeld.status,"held");
  assert.equal(oaHeld.mapped,false);
  assert.equal(oaHeld.pending,true);
  const missing=await a.query("SELECT customer_id,conversation_id FROM zalo_official_quarantine WHERE id=$1",[oaHeld.receipt_id]);
  assert.equal(missing.rows[0].customer_id,null);
  assert.equal(missing.rows[0].conversation_id,null);

  const before=await count("zalo_official_quarantine");
  assert.equal((await ingressA.receive_webhook(unknown.bytes,{"x-zevent-signature":"mac="+("0".repeat(64))})).status_code,403);
  const wrong=create("user_send_file",{msg_id:"wrong-"+unique},user,{oa_id:"wrong-oa"});
  assert.equal((await ingressB.receive_webhook(wrong.bytes,wrong.headers)).status_code,422);
  assert.equal(await count("zalo_official_quarantine"),before);
  const quarantined=(await a.query("SELECT id FROM zalo_official_quarantine WHERE oa_id=$1 ORDER BY id LIMIT 1",[oa])).rows[0].id;
  await a.query("UPDATE zalo_official_quarantine SET status='REVIEWED',reviewed_at=now(),reviewed_by='ai2-test-only' WHERE id=$1",[quarantined]);
  const pending=(await a.query("SELECT count(*)::int AS n FROM zalo_official_quarantine WHERE oa_id=$1 AND status='NEEDS_HUMAN'",[oa])).rows[0].n;
  assert.equal(pending,before-1);
 }finally{
  try{
   await a.query("DELETE FROM zalo_process_queue WHERE oa_id=$1",[oa]);
   await a.query("DELETE FROM zalo_inbound_events WHERE oa_id=$1",[oa]);
   await a.query("DELETE FROM zalo_official_quarantine WHERE oa_id=$1",[oa]);
  }finally{await Promise.all([a.end(),b.end()]);}
 }
});
