import test from "node:test";
import assert from "node:assert/strict";
import {createHash,randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import {createOfficialZaloQuarantineReceiver} from "../../../backend/integrations/zalo/official-quarantine.ts";
import {createZaloTransactions} from "../../../backend/integrations/zalo/transaction-runner.ts";

const url=process.env.TEST_DATABASE_URL??process.env.AUTOIN_TEST_DATABASE_URL;
let pg;
if(url)try{pg=await import("pg")}catch{/* explicit PG SKIP in no-PG mode */}
test("REAL PostgreSQL AI2 signed unsupported OA quarantine: two workers, replay, ACK loss, reviewed gate and wrong MAC",{
 skip:!url?"TEST_DATABASE_URL missing":!pg?"pg dependency unavailable":false
},async()=>{
 const Pool=pg.default?.Pool??pg.Pool;
 const a=new Pool({connectionString:url,max:4});
 const b=new Pool({connectionString:url,max:4});
 const unique=randomUUID().replaceAll("-","");
 const app="app-"+unique,oa="oa-"+unique,secret="synthetic-only-secret-00000";
 const now=1791936000000;
 const config={app_id:app,oa_id:oa,oa_secret_key:secret,now:()=>now,
  resolve_verified_user:sender=>sender==="user-"+unique?
   {customer_id:"trusted-customer-"+unique,conversation_id:"trusted-chat-"+unique}:null};
 const receiverA=createOfficialZaloQuarantineReceiver(config,createZaloTransactions(a));
 const receiverB=createOfficialZaloQuarantineReceiver(config,createZaloTransactions(b));
 const signer=raw=>({"x-zevent-signature":"mac="+createHash("sha256")
  .update(app).update(raw).update(String(now)).update(secret).digest("hex")});
 const raw=(event_name,sender="user-"+unique,id="event-1")=>
  new TextEncoder().encode(JSON.stringify({app_id:app,timestamp:now,event_name,
   sender:{id:sender},recipient:{id:oa},message:{msg_id:id}}));
 const count=async()=> (await a.query(
  "SELECT count(*)::int AS n FROM zalo_official_quarantine WHERE oa_id=$1",[oa])).rows[0].n;
 try{
  assert.match((await a.query("SELECT current_database() AS n")).rows[0].n,/test/i);
  assert.notEqual((await a.query("SELECT pg_backend_pid() AS p")).rows[0].p,
   (await b.query("SELECT pg_backend_pid() AS p")).rows[0].p);
  // AI2 migration only. AI0 must add this migration to the app runner BEFORE
  // any route is enabled. Test does not touch AI1/AI0 schema or approval.
  await a.query(await readFile(new URL("../../../backend/integrations/zalo/migrations/004_official_quarantine.sql",import.meta.url),"utf8"));
  const images=raw("user_send_image");
  const results=await Promise.all([receiverA.receive(images,signer(images)),
   receiverB.receive(images,signer(images))]);
  assert.deepEqual(results.map(x=>x.status).sort(),["duplicate","held"]);
  assert.equal(results[0].receipt_id,results[1].receipt_id);
  assert.equal(await count(),1,"two PG workers have exactly one durable receipt");
  const fields=(await a.query("SELECT kind,customer_id,conversation_id,status FROM zalo_official_quarantine WHERE oa_id=$1",[oa])).rows[0];
  assert.equal(fields.kind,"image");
  assert.equal(fields.customer_id,"trusted-customer-"+unique);
  assert.equal(fields.conversation_id,"trusted-chat-"+unique);
  assert.equal(fields.status,"NEEDS_HUMAN");

  // An OA-wide gate must count even UNMAPPED events. AI0/AI1 must use this
  // INSIDE real OrderService.approve transaction, not as an outside precheck.
  const countPending=async()=> (await a.query(
   "SELECT count(*)::int AS n FROM zalo_official_quarantine WHERE oa_id=$1 AND status='NEEDS_HUMAN'",[oa])).rows[0].n;
  assert.equal(await countPending(),1);
  for(const [kind,id] of [["user_send_file","file"],["user_click_response_button","click"],["unrecognized_event","unknown"]]){
   const event=raw(kind,kind==="unrecognized_event"?"unknown-sender":"user-"+unique,id);
   const result=await receiverB.receive(event,signer(event));
   assert.equal(result.status,"held");
  }
  assert.equal(await count(),4);
  assert.equal(await countPending(),4);
  const rows=(await a.query(
   "SELECT kind,customer_id FROM zalo_official_quarantine WHERE oa_id=$1 ORDER BY kind",[oa])).rows;
  assert.ok(rows.some(x=>x.kind==="unknown"&&x.customer_id===null));
  // Signature rejected BEFORE every DB write, even if payload JSON says OA.
  const tampered=raw("user_send_file","user-"+unique,"invalid-signature");
  await assert.rejects(receiverA.receive(tampered,{"x-zevent-signature":"mac="+("0".repeat(64))}),
   /WEBHOOK_SIGNATURE_REJECTED/);
  assert.equal(await count(),4);
  const wrong=raw("user_send_image","user-"+unique,"scope-mismatch");
  const altered=JSON.parse(new TextDecoder().decode(wrong));altered.oa_id="FOREIGN-OA";
  const wrongBytes=new TextEncoder().encode(JSON.stringify(altered));
  await assert.rejects(receiverB.receive(wrongBytes,signer(wrongBytes)),/INVALID_OFFICIAL_EVENT_SCOPE/);
  assert.equal(await count(),4);

  // An authenticated human reconciliation (AI0-owned API NOT IMPLEMENTED) is
  // modeled explicitly in this PG test. Zero pending ONLY after every row is reviewed.
  await a.query("UPDATE zalo_official_quarantine SET status='REVIEWED',reviewed_at=now(),reviewed_by=$3 WHERE oa_id=$1 AND id=$2",
   [oa,results[0].receipt_id,"test-operator"]);
  assert.equal(await countPending(),3,"one reviewed marker cannot clear other pending");
  const retry=await receiverA.receive(images,signer(images));
  assert.equal(retry.status,"duplicate");
  assert.equal(retry.pending,false);
  assert.equal(retry.receipt_id,results[0].receipt_id);
  assert.equal(await countPending(),3,"lost ACK replay must not reactivate reviewed receipt");
  await a.query("UPDATE zalo_official_quarantine SET status='REVIEWED',reviewed_at=now(),reviewed_by='test-operator' WHERE oa_id=$1 AND status='NEEDS_HUMAN'",[oa]);
  assert.equal(await countPending(),0);
  assert.equal(await count(),4);

  // EXACT two-pool lock-order witness: the 'approval' transaction takes
  // the same OA scope lock AI0's Core approve MUST take after locking order.
  // Real Core HTTP409/zero print-job belongs to AI0/AI1/AI5 integration;
  // this unit test proves AI2's durable DB receipt is timestamped AFTER lock.
  const hold=await a.connect();
  let committed=false;
  try{
   await hold.query("BEGIN");
   await hold.query(
    "INSERT INTO zalo_official_quarantine_scopes(oa_id) VALUES($1) ON CONFLICT DO NOTHING",[oa]);
   await hold.query(
    "SELECT oa_id FROM zalo_official_quarantine_scopes WHERE oa_id=$1 FOR UPDATE",[oa]);
   const before=(await hold.query("SELECT clock_timestamp() t")).rows[0].t;
   const delayed=raw("user_send_file","user-"+unique,"delayed-receipt-after-lock");
   let finished=false;
   const pending=receiverB.receive(delayed,signer(delayed)).then(x=>{finished=true;return x;});
   let observed=false;
   for(let attempt=0;attempt<70;attempt++){
    const q=await hold.query(
     "SELECT EXISTS(SELECT 1 FROM pg_stat_activity s WHERE s.pid<>$1 "+
     "AND s.wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(s.pid))) blocked",
     [hold.processID]);
    if(q.rows[0].blocked){observed=true;break;}
    await new Promise(ok=>setTimeout(ok,30));
   }
   assert.equal(observed,true,"independent inbound must demonstrably wait on the held OA scope lock");
   assert.equal(finished,false,"no premature ACK while waiting for scope lock");
   const releaseAt=(await hold.query("SELECT clock_timestamp() t")).rows[0].t;
   assert.ok(releaseAt>before,"approval-side DB clock advanced while inbound is waiting");
   await hold.query("COMMIT");
   committed=true;
   const result=await pending;
   assert.equal(result.status,"held");
   assert.equal(result.pending,true);
   const stamp=await a.query(
    "SELECT received_at FROM zalo_official_quarantine WHERE id=$1",[result.receipt_id]);
   assert.equal(stamp.rowCount,1);
   assert.ok(stamp.rows[0].received_at>releaseAt,
    "Post-lock clock_timestamp MUST exceed approval's pre-commit DB timestamp; now() is unsafe");
   assert.equal(await countPending(),1,
    "new inbound after the lock-release remains PENDING review");
   const replay=await receiverA.receive(delayed,signer(delayed));
   assert.equal(replay.status,"duplicate");
   assert.equal(replay.receipt_id,result.receipt_id);
   const stored=await a.query(
    "SELECT received_at FROM zalo_official_quarantine WHERE id=$1",[result.receipt_id]);
   assert.deepEqual(stored.rows[0].received_at,stamp.rows[0].received_at,
    "lost-ACK replay MUST keep first commit/receipt time");
   await a.query(
    "UPDATE zalo_official_quarantine SET status='REVIEWED',reviewed_at=clock_timestamp(),reviewed_by='ai2-test-only' WHERE id=$1",
    [result.receipt_id]);
   assert.equal(await countPending(),0);
  }finally{
   if(!committed)await hold.query("ROLLBACK");
   hold.release();
  }
 }finally{
  try{await a.query("DELETE FROM zalo_official_quarantine WHERE oa_id=$1",[oa])}
  finally{await Promise.all([a.end(),b.end()])}
 }
});
