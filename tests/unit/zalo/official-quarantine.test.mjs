import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {createOfficialZaloQuarantineReceiver,createOfficialZaloVerifiedIngress} from "../../../backend/integrations/zalo/official-quarantine.ts";
import {createOfficialZaloWebhookAdapter} from "../../../backend/integrations/zalo/official-webhook.ts";

// Python hashlib.sha256 independently computed vector, NOT a Zalo-issued vector.
// EXACT raw JSON: 181 UTF8 bytes, no trailing LF, no BOM, no extra space.
// EXACT source = UTF8("app-fixture-001") + raw UTF8 + UTF8("1791936000000")
//                + UTF8("unit-test-secret-000000") = 232 bytes.
const RAW='{"app_id":"app-fixture-001","timestamp":"1791936000000","event_name":"user_send_image","sender":{"id":"sender-1"},"recipient":{"id":"oa-fixture-001"},"message":{"msg_id":"image-1"}}';
const VECTOR="a96d60bae80a7f5657a4ced70615f7756ed0490daa6f697168d4b586a81413cb";
const config={app_id:"app-fixture-001",oa_id:"oa-fixture-001",
 oa_secret_key:"unit-test-secret-000000",
 resolve_verified_user:uid=>uid==="sender-1"?
   {customer_id:"trusted-customer",conversation_id:"trusted-chat"}:null,
 now:()=>1791936000000};
const bytes=new TextEncoder().encode(RAW);
function signed(rawBytes,app=config.app_id,ts="1791936000000",key=config.oa_secret_key){
 return {"x-zevent-signature":"mac="+createHash("sha256")
  .update(app,"utf8").update(rawBytes).update(ts,"utf8").update(key,"utf8").digest("hex")};
}
function sql(){
 const data=new Map();let queries=0;
 return {data,queries:()=>queries,transaction:async action=>action({
  async query(text,values=[]){
   queries++;
   if(text.startsWith("INSERT INTO zalo_official_quarantine_scopes"))
     return {rows:[],rowCount:1};
   if(text.startsWith("SELECT oa_id FROM zalo_official_quarantine_scopes"))
     return {rows:[{oa_id:values[0]}],rowCount:1};
   if(text.startsWith("INSERT INTO zalo_official_quarantine")){
    const [id,oa,sha,kind,customer,conversation,claimed]=values,unique=oa+":"+sha;
    if(data.has(unique))return {rows:[],rowCount:0};
    const row={id,oa_id:oa,raw_sha256:sha,kind,customer_id:customer,
     conversation_id:conversation,provider_claimed_event_id:claimed,status:"NEEDS_HUMAN"};
    data.set(unique,row);return {rows:[row],rowCount:1};
   }
   if(text.startsWith("SELECT id,status,kind")){
    const row=data.get(values[0]+":"+values[1]);
    return {rows:row?[row]:[],rowCount:row?1:0};
   }
   throw new Error("UNEXPECTED_UNIT_SQL");
  }
 })};
}
test("independent hashlib official-formula fixture fixes exact raw bytes and timestamp",async()=>{
 assert.equal(bytes.length,181);
 const data=Buffer.concat([Buffer.from(config.app_id),Buffer.from(bytes),
  Buffer.from("1791936000000"),Buffer.from(config.oa_secret_key)]);
 assert.equal(data.length,232);
 assert.equal(data.toString("utf8"),config.app_id+RAW+"1791936000000"+config.oa_secret_key);
 const verifier=createOfficialZaloWebhookAdapter(config).verifier;
 assert.equal(await verifier.verify(bytes,{"x-zevent-signature":"mac="+VECTOR}),true);
 const padded=Buffer.from(RAW+"\n");
 assert.equal(await verifier.verify(padded,{"x-zevent-signature":"mac="+VECTOR}),false);
 // Documentation has no signed Zalo golden vector. This is an assumption test only.
});
test("signed unsupported image/file/click/unknown all persist held, bad signature zero-write",async()=>{
 const store=sql(),receiver=createOfficialZaloQuarantineReceiver(config,store);
 const objects=[
  ["user_send_image","image"],["user_send_file","file"],
  ["user_click_response_button","click"],["totally_unknown_event","unknown"]
 ];
 for(const [event_name,kind] of objects){
  const payload=JSON.parse(RAW);payload.event_name=event_name;
  const raw=new TextEncoder().encode(JSON.stringify(payload));
  const response=await receiver.receive(raw,signed(raw));
  assert.equal(response.status,"held");
  assert.equal(response.kind,kind);
  assert.equal(response.mapped,true);
  assert.equal(response.pending,true);
  const replay=await receiver.receive(raw,signed(raw));
  assert.equal(replay.status,"duplicate");
  assert.equal(replay.receipt_id,response.receipt_id);
 }
 assert.equal(store.data.size,4);
 const before=store.queries();
 await assert.rejects(receiver.receive(bytes,{"x-zevent-signature":"mac="+("0".repeat(64))}),
  /WEBHOOK_SIGNATURE_REJECTED/);
 assert.equal(store.queries(),before);
});
test("unknown sender remains OA-level; wrong OA/app or ordinary text cannot mutate quarantine",async()=>{
 const store=sql(),receiver=createOfficialZaloQuarantineReceiver(config,store);
 const obj=JSON.parse(RAW);obj.sender.id="unknown-sender";
 let raw=new TextEncoder().encode(JSON.stringify(obj));
 const response=await receiver.receive(raw,signed(raw));
 assert.equal(response.mapped,false);
 const row=[...store.data.values()][0];
 assert.equal(row.customer_id,null);
 assert.equal(row.conversation_id,null);
 assert.equal(store.data.size,1);
 obj.recipient.id="FOREIGN-OA";raw=new TextEncoder().encode(JSON.stringify(obj));
 await assert.rejects(receiver.receive(raw,signed(raw)),/INVALID_OFFICIAL_EVENT_SCOPE/);
 obj.recipient.id=config.oa_id;obj.oa_id="FOREIGN-OA";
 raw=new TextEncoder().encode(JSON.stringify(obj));
 await assert.rejects(receiver.receive(raw,signed(raw)),/INVALID_OFFICIAL_EVENT_SCOPE/);
 obj.oa_id=config.oa_id;obj.event_name="user_send_text";
 obj.sender.id="sender-1"; // MAPPED text belongs in ordinary event queue only.
 raw=new TextEncoder().encode(JSON.stringify(obj));
 await assert.rejects(receiver.receive(raw,signed(raw)),/UNSUPPORTED_OFFICIAL_QUARANTINE_EVENT/);
 assert.equal(store.data.size,1);
});


test("single signed ingress dispatches text and unsupported to distinct durable ports, no consent",async()=>{
 const store=sql(),events=new Map();
 const repo={async insert_once(event) {
   if(events.has(event.event_id))return "duplicate";
   events.set(event.event_id,event);return "inserted";
 }};
 const ingress=createOfficialZaloVerifiedIngress(config,repo,store);
 const t=JSON.parse(RAW);
 t.event_name="user_send_text";t.message={msg_id:"text-verified-1",text:"OK",
   confirmation_postback:{kind:"verified_confirmation_accept",challenge_token:"fake"}};
 const textRaw=new TextEncoder().encode(JSON.stringify(t));
 const first=await ingress.receive(textRaw,signed(textRaw));
 assert.deepEqual(first,{status:"accepted",event_id:"text-verified-1"});
 assert.deepEqual(await ingress.receive(textRaw,signed(textRaw)),{
   status:"duplicate",event_id:"text-verified-1"});
 assert.equal(events.size,1);
 assert.equal(events.get("text-verified-1").confirmation_postback,undefined);
 assert.equal(events.get("text-verified-1").text,"OK");
 assert.equal(store.data.size,0);
 const q=JSON.parse(RAW);q.event_name="user_click_button";
 const qRaw=new TextEncoder().encode(JSON.stringify(q));
 const held=await ingress.receive_webhook(qRaw,signed(qRaw));
 assert.equal(held.status_code,200);
 assert.equal(held.body.status,"held");
 assert.equal(held.body.provider_claimed_event_id,"image-1");
 assert.equal(store.data.size,1);
 assert.equal(events.size,1,"unknown click must not enter normal conversation processing");
 const replay=await ingress.receive_webhook(qRaw,signed(qRaw));
 assert.equal(replay.status_code,200);
 assert.equal(replay.body.status,"duplicate");
 assert.equal(replay.body.receipt_id,held.body.receipt_id);
 const before=store.queries();
 assert.equal((await ingress.receive_webhook(qRaw,{"x-zevent-signature":"mac="+("f".repeat(64))})).status_code,403);
 const scope={...q,oa_id:"OTHER-OA"};
 const forgedRaw=new TextEncoder().encode(JSON.stringify(scope));
 assert.equal((await ingress.receive_webhook(forgedRaw,signed(forgedRaw))).status_code,422);
 assert.equal(store.queries(),before,"bad MAC/scope cannot write quarantine");
});
test("missing/broken quarantine transaction cannot ACK unsupported events as delivered",async()=>{
 const repo={async insert_once(){throw new Error("unexpected text insert")}};
 assert.throws(()=>createOfficialZaloVerifiedIngress(config,repo,null),/OFFICIAL_QUARANTINE_PG_REQUIRED/);
 const failing={async transaction(){throw new Error("PG_IN_MIGRATION_OR_OUTAGE")}};
 const ingress=createOfficialZaloVerifiedIngress(config,repo,failing);
 const received=await ingress.receive_webhook(bytes,signed(bytes));
 assert.equal(received.status_code,503);
 assert.equal(received.body.error.code,"OFFICIAL_INGRESS_UNAVAILABLE");
});


test("CODE402 signed unmapped text is durable OA-only, no body; 2 retries and bad MAC zero-write",async()=>{
 const store=sql(),events=[];
 const ingress=createOfficialZaloVerifiedIngress(config,{
   async insert_once(e){events.push(e);return "inserted";}
 },store);
 const payload=JSON.parse(RAW);
 payload.event_name="user_send_text";
 payload.sender.id="unmapped-user";
 payload.message={msg_id:"unmapped-text-1",text:"PRIVATE CUSTOMER CONTENT MUST NEVER PERSIST",
   confirmation_postback:{kind:"verified_confirmation_accept",challenge_token:"fake"}};
 const data=new TextEncoder().encode(JSON.stringify(payload));
 const first=await ingress.receive_webhook(data,signed(data));
 assert.equal(first.status_code,200);
 assert.equal(first.body.status,"held");
 assert.equal(first.body.mapped,false);
 assert.equal(first.body.kind,"unknown");
 assert.equal(first.body.pending,true);
 assert.equal(first.body.provider_claimed_event_id,"unmapped-text-1");
 assert.equal(store.data.size,1);
 const record=[...store.data.values()][0];
 assert.equal(record.status,"NEEDS_HUMAN");
 assert.equal(record.customer_id,null);
 assert.equal(record.conversation_id,null);
 assert.equal(record.kind,"unknown");
 assert.equal(record.provider_claimed_event_id,"unmapped-text-1");
 assert.equal(Object.values(record).some(v=>typeof v==="string"&&v.includes("PRIVATE CUSTOMER CONTENT")),false);
 assert.equal(events.length,0,"unmapped TEXT must never reach normal processing");
 const retry=await ingress.receive_webhook(data,signed(data));
 assert.equal(retry.status_code,200);
 assert.equal(retry.body.status,"duplicate");
 assert.equal(retry.body.receipt_id,first.body.receipt_id);
 assert.equal(store.data.size,1);
 const before=store.queries();
 assert.equal((await ingress.receive_webhook(data,{"x-zevent-signature":"mac="+("0".repeat(64))})).status_code,403);
 const wrong={...payload,recipient:{id:"foreign-oa"}};
 const wrongRaw=new TextEncoder().encode(JSON.stringify(wrong));
 assert.equal((await ingress.receive_webhook(wrongRaw,signed(wrongRaw))).status_code,422);
 assert.equal(store.queries(),before);
 assert.equal(events.length,0);
});
