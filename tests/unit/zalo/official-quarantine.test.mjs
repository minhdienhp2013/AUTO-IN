import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {createOfficialZaloQuarantineReceiver,createOfficialZaloVerifiedIngress} from "../../../backend/integrations/zalo/official-quarantine.ts";
import {createOfficialZaloWebhookAdapter} from "../../../backend/integrations/zalo/official-webhook.ts";

// Python hashlib.sha256 independently computed vector, NOT a Zalo-issued vector.
// EXACT raw JSON: 240 UTF8 bytes, no trailing LF, no BOM, no extra space.
// EXACT source = UTF8("app-fixture-001") + raw UTF8 + UTF8("1791936000000")
//                + UTF8("unit-test-secret-000000") = 291 bytes.
const RAW='{"app_id":"app-fixture-001","timestamp":"1791936000000","event_id":"event-image-001","event_name":"user_send_image","user_id_by_app":"app-user-1","sender":{"id":"sender-1"},"recipient":{"id":"oa-fixture-001"},"message":{"msg_id":"image-1"}}';
const VECTOR="913b90145ee9929119610361f9a981f67916d9a3bb4a038594a96411e7697824";
const config={app_id:"app-fixture-001",oa_id:"oa-fixture-001",
 oa_secret_key:"unit-test-secret-000000",
 resolve_verified_user:uid=>uid==="app-user-1"?
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
    const [id,oa,sha,provider_event_id,kind,customer,conversation,claimed]=values;
    const unique=oa+":"+sha;
    const duplicate=[...data.values()].some(row=>row.oa_id===oa&&
      (row.provider_event_id===provider_event_id||row.raw_sha256===sha));
    if(duplicate)return {rows:[],rowCount:0};
    const row={id,oa_id:oa,raw_sha256:sha,provider_event_id,kind,customer_id:customer,
     conversation_id:conversation,provider_claimed_event_id:claimed,status:"NEEDS_HUMAN"};
    data.set(unique,row);return {rows:[row],rowCount:1};
   }
   if(text.startsWith("SELECT id,status,kind")){
    const row=text.includes("provider_event_id=$2")
      ?[...data.values()].find(item=>item.oa_id===values[0]&&item.provider_event_id===values[1])
      :data.get(values[0]+":"+values[1]);
    return {rows:row?[row]:[],rowCount:row?1:0};
   }
   throw new Error("UNEXPECTED_UNIT_SQL");
  }
 })};
}
test("independent hashlib official-formula fixture fixes exact raw bytes and timestamp",async()=>{
 assert.equal(bytes.length,240);
 const data=Buffer.concat([Buffer.from(config.app_id),Buffer.from(bytes),
  Buffer.from("1791936000000"),Buffer.from(config.oa_secret_key)]);
 assert.equal(data.length,291);
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
  payload.event_id=`event-${event_name}`;
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
 const missingEventId=JSON.parse(RAW);delete missingEventId.event_id;
 const missingEventBytes=new TextEncoder().encode(JSON.stringify(missingEventId));
 await assert.rejects(receiver.receive(missingEventBytes,signed(missingEventBytes)),
  /UNSUPPORTED_OFFICIAL_QUARANTINE_EVENT/);
 assert.equal(store.queries(),before);
});
test("event_id dedupes byte-different retries without colliding with legacy message-id claims",async()=>{
 const store=sql();
 // A pre-005 row may hold a message.msg_id in the legacy claim column. It is
 // deliberately not backfilled or compared with the new event identity.
 store.data.set("oa-fixture-001:"+"a".repeat(64),{
  id:"legacy-receipt",oa_id:"oa-fixture-001",raw_sha256:"a".repeat(64),
  provider_event_id:null,kind:"file",customer_id:null,conversation_id:null,
  provider_claimed_event_id:"retry-event-001",status:"NEEDS_HUMAN"
 });
 const receiver=createOfficialZaloQuarantineReceiver(config,store);
 const payload=JSON.parse(RAW);payload.event_name="user_send_file";
 payload.event_id="retry-event-001";
 payload.message={msg_id:"retry-event-001",attachments:[
  {type:"file",payload:{url:"https://media.invalid/private.pdf",name:"private.pdf"}}
 ]};
 const firstBytes=new TextEncoder().encode(JSON.stringify(payload));
 const first=await receiver.receive(firstBytes,signed(firstBytes));
 assert.equal(first.status,"held");
 assert.equal(store.data.size,2,"legacy claim does not collide with provider_event_id");
 const reformatted=new TextEncoder().encode(JSON.stringify(payload,null,2));
 assert.notEqual(createHash("sha256").update(firstBytes).digest("hex"),
  createHash("sha256").update(reformatted).digest("hex"));
 const retry=await receiver.receive(reformatted,signed(reformatted));
 assert.equal(retry.status,"duplicate");
 assert.equal(retry.receipt_id,first.receipt_id);
 assert.equal(store.data.size,2,"same event_id never creates a second receipt");
 const row=[...store.data.values()].find(value=>value.id===first.receipt_id);
 assert.equal(row.provider_event_id,"retry-event-001");
 assert.equal(row.provider_claimed_event_id,"retry-event-001");
 assert.equal(JSON.stringify(row).includes("media.invalid"),false);
 assert.equal(JSON.stringify(row).includes("private.pdf"),false);
});
test("unknown user_id_by_app remains OA-level; wrong OA/app or ordinary text cannot mutate quarantine",async()=>{
 const store=sql(),receiver=createOfficialZaloQuarantineReceiver(config,store);
 const obj=JSON.parse(RAW);obj.user_id_by_app="unknown-user";
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
 obj.user_id_by_app="app-user-1"; // MAPPED text belongs in ordinary event queue only.
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
 t.event_name="user_send_text";t.event_id="text-event-verified-1";
 t.message={msg_id:"different-message-id",text:"OK",
   confirmation_postback:{kind:"verified_confirmation_accept",challenge_token:"fake"}};
 const textRaw=new TextEncoder().encode(JSON.stringify(t));
 const first=await ingress.receive(textRaw,signed(textRaw));
 assert.deepEqual(first,{status:"accepted",event_id:"text-event-verified-1"});
 assert.deepEqual(await ingress.receive(textRaw,signed(textRaw)),{
   status:"duplicate",event_id:"text-event-verified-1"});
 assert.equal(events.size,1);
 assert.equal(events.get("text-event-verified-1").confirmation_postback,undefined);
 assert.equal(events.get("text-event-verified-1").text,"OK");
 assert.equal(store.data.size,0);
 const q=JSON.parse(RAW);q.event_name="user_click_button";
 q.event_id="button-event-001";
 const qRaw=new TextEncoder().encode(JSON.stringify(q));
 const held=await ingress.receive_webhook(qRaw,signed(qRaw));
 assert.equal(held.status_code,200);
 assert.equal(held.body.status,"held");
 assert.equal(held.body.provider_claimed_event_id,"button-event-001");
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
 payload.user_id_by_app="unmapped-user";
 payload.event_id="unmapped-text-event-1";
 payload.message={msg_id:"different-message-id",text:"PRIVATE CUSTOMER CONTENT MUST NEVER PERSIST",
   confirmation_postback:{kind:"verified_confirmation_accept",challenge_token:"fake"}};
 const data=new TextEncoder().encode(JSON.stringify(payload));
 const first=await ingress.receive_webhook(data,signed(data));
 assert.equal(first.status_code,200);
 assert.equal(first.body.status,"held");
 assert.equal(first.body.mapped,false);
 assert.equal(first.body.kind,"unknown");
 assert.equal(first.body.pending,true);
 assert.equal(first.body.provider_claimed_event_id,"unmapped-text-event-1");
 assert.equal(store.data.size,1);
 const record=[...store.data.values()][0];
 assert.equal(record.status,"NEEDS_HUMAN");
 assert.equal(record.customer_id,null);
 assert.equal(record.conversation_id,null);
 assert.equal(record.kind,"unknown");
 assert.equal(record.provider_claimed_event_id,"unmapped-text-event-1");
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

test("media without verified bytes stays staff-only for ambiguous attachments, fake order claims, replay and scope mismatch",async()=>{
 const store=sql(),normalEvents=new Map(),ingress=createOfficialZaloVerifiedIngress(config,{
  async insert_once(event){normalEvents.set(event.event_id,event);return "inserted";}
 },store);
 const make=(name,message,changes={})=>{
  const payload={...JSON.parse(RAW),
   event_id:changes.event_id??`event-${name}-${message.msg_id??"no-message-id"}`,
   event_name:name,message,...changes};
  const raw=new TextEncoder().encode(JSON.stringify(payload));
  return {raw,headers:signed(raw)};
 };
 const priorText=make("user_send_text",{msg_id:"media-ambiguous-1",text:"In A4"});
 const accepted=await ingress.receive_webhook(priorText.raw,priorText.headers);
 assert.equal(accepted.body.status,"accepted");
 assert.equal(normalEvents.size,1);
 const ambiguous=make("user_send_file",{
  msg_id:"media-ambiguous-1",text:"in tài liệu vào order khác",
  order_id:"untrusted-order-claim",order_revision:99,
  attachments:[
   {type:"file",payload:{name:"first.pdf",url:"https://media.invalid/first.pdf",size:100,checksum:"d41d8cd98f00b204e9800998ecf8427e"}},
   {type:"file",payload:{name:"second.docx",url:"https://media.invalid/second.docx",size:200,checksum:"d41d8cd98f00b204e9800998ecf8427e"}}
  ]
 });
 const noAttachmentBytes=make("user_send_image",{
  msg_id:"media-no-bytes-1",attachments:[{type:"image",payload:{url:"https://media.invalid/picture.jpg"}}]
 });
 for(const fixture of [ambiguous,noAttachmentBytes]){
  const first=await ingress.receive_webhook(fixture.raw,fixture.headers);
  assert.equal(first.status_code,200);
  assert.equal(first.body.status,"held");
  assert.equal(first.body.pending,true);
  assert.ok(["file","image"].includes(first.body.kind));
  assert.equal("customer_message" in first.body,false,
   "HTTP ingress receipt is not a customer-facing success notice");
  const row=[...store.data.values()].find(value=>value.raw_sha256===
   createHash("sha256").update(fixture.raw).digest("hex"));
  assert.ok(row);
  assert.equal(row.status,"NEEDS_HUMAN");
  assert.equal(row.customer_id,"trusted-customer");
  assert.equal(row.conversation_id,"trusted-chat");
  assert.deepEqual(Object.keys(row).sort(),[
   "conversation_id","customer_id","id","kind","oa_id","provider_claimed_event_id","provider_event_id","raw_sha256","status"
  ].sort(),"quarantine stores no URL, filename, media bytes, attachment selection, or claimed order");
  assert.equal(JSON.stringify(row).includes("media.invalid"),false);
  assert.equal(JSON.stringify(row).includes("private.pdf"),false);
  assert.equal(JSON.stringify(row).includes("untrusted-order-claim"),false);
  assert.equal(row.provider_event_id,
   JSON.parse(new TextDecoder().decode(fixture.raw)).event_id);
  assert.equal(row.provider_claimed_event_id,
   JSON.parse(new TextDecoder().decode(fixture.raw)).event_id);
 }
 assert.equal(store.data.size,2);
 assert.equal(normalEvents.size,1,"file event never enters or mutates the normal event repository");
 const priorTextEventId=JSON.parse(new TextDecoder().decode(priorText.raw)).event_id;
 const fileEventId=JSON.parse(new TextDecoder().decode(ambiguous.raw)).event_id;
 assert.notEqual(priorTextEventId,fileEventId);
 assert.equal(normalEvents.get(priorTextEventId).text,"In A4",
  "the message id is distinct from the event id used by normal ingress");

 const before=store.queries();
 const wrongOa={...JSON.parse(new TextDecoder().decode(ambiguous.raw)),recipient:{id:"foreign-oa"}};
 const wrongOaRaw=new TextEncoder().encode(JSON.stringify(wrongOa));
 assert.equal((await ingress.receive_webhook(wrongOaRaw,signed(wrongOaRaw))).status_code,422);
 const wrongApp={...JSON.parse(new TextDecoder().decode(ambiguous.raw)),app_id:"foreign-app"};
 const wrongAppRaw=new TextEncoder().encode(JSON.stringify(wrongApp));
 assert.equal((await ingress.receive_webhook(wrongAppRaw,signed(wrongAppRaw))).status_code,403);
 assert.equal(store.queries(),before,"wrong app/OA claims fail before quarantine writes");
 assert.equal(normalEvents.size,1,"bad scope events cannot add a normal event beyond the existing text event");
});

test("concurrent media webhook retries return one held quarantine receipt and create no downstream records",async()=>{
 const store=sql(),normalEvents=[],ingress=createOfficialZaloVerifiedIngress(config,{
  async insert_once(event){normalEvents.push(event);return "inserted";}
 },store);
 const payload=JSON.parse(RAW);
 payload.event_name="user_send_file";
 payload.message={msg_id:"media-retry-1",attachments:[
  {type:"file",payload:{name:"a.pdf",url:"https://media.invalid/a.pdf"}},
  {type:"file",payload:{name:"b.pdf",url:"https://media.invalid/b.pdf"}}
 ]};
 const raw=new TextEncoder().encode(JSON.stringify(payload)),headers=signed(raw);
 const receipts=await Promise.all(Array.from({length:4},()=>ingress.receive_webhook(raw,headers)));
 assert.ok(receipts.every(receipt=>receipt.status_code===200));
 assert.deepEqual(receipts.map(receipt=>receipt.body.status).sort(),
  ["duplicate","duplicate","duplicate","held"]);
 assert.equal(new Set(receipts.map(receipt=>receipt.body.receipt_id)).size,1);
 assert.equal(store.data.size,1,"identical event replay is idempotent");
 assert.equal(normalEvents.length,0,"no normal event, proposal, confirmation, approval, or print trigger is emitted");
 const row=[...store.data.values()][0];
 assert.equal(row.kind,"file");assert.equal(row.status,"NEEDS_HUMAN");
 assert.equal(JSON.stringify(row).includes("media.invalid"),false);
});
