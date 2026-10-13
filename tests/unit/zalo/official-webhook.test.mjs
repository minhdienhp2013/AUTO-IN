import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {createOfficialZaloWebhookAdapter} from "../../../backend/integrations/zalo/official-webhook.ts";
import {ZaloIngress} from "../../../backend/integrations/zalo/protocol.ts";

const now=Date.parse("2026-10-14T04:00:00Z");
const app_id="123456789012345678",oa_id="987654321098765432";
const secret="unit-test-secret-NOT-real-do-not-deploy";
const signedObject=(more={})=>({
 app_id,event_name:"user_send_text",timestamp:now,
 sender:{id:"246845883529697922"},recipient:{id:oa_id},
 message:{msg_id:"msg-001",text:"In giúp em 2 bản A4"},...more
});
const raw=o=>new TextEncoder().encode(JSON.stringify(o));
const sign=(bytes,app=app_id,ts=String(now),key=secret)=>{
 const mac=createHash("sha256").update(app).update(bytes).update(ts).update(key).digest("hex");
 return {"x-zevent-signature":"mac="+mac};
};
const make=(extra={})=>createOfficialZaloWebhookAdapter({
 app_id,oa_id,oa_secret_key:secret,
 resolve_verified_user:uid=>uid==="246845883529697922"?{customer_id:"trusted-customer",conversation_id:"trusted-oa-conversation"}:null,
 now:()=>now,...extra
});
test("official documented SHA-256 MAC is computed from ORIGINAL raw bytes",async()=>{
 const {verifier,normalizer}=make();
 const bytes=raw(signedObject());
 assert.equal(await verifier.verify(bytes,sign(bytes)),true);
 const spaced=new TextEncoder().encode(JSON.stringify(signedObject(),null,2));
 assert.equal(await verifier.verify(spaced,sign(bytes)),false);
 assert.equal(await verifier.verify(spaced,sign(spaced)),true);
 assert.deepEqual(normalizer.normalize(bytes),{
  event_id:"msg-001",oa_id,customer_id:"trusted-customer",
  conversation_id:"trusted-oa-conversation",
  occurred_at:new Date(now).toISOString(),kind:"text",text:"In giúp em 2 bản A4"
 });
});
test("wrong MAC/app/secret/missing signature/expired timestamp fail closed",async()=>{
 const {verifier}=make(),bytes=raw(signedObject());
 const wrongMac={...sign(bytes),"x-zevent-signature":"mac="+("0".repeat(64))};
 const missing={};
 assert.equal(await verifier.verify(bytes,wrongMac),false);
 assert.equal(await verifier.verify(bytes,missing),false);
 assert.equal(await verifier.verify(bytes,{"x-zevent-signature":"garbage"}),false);
 assert.equal(await verifier.verify(bytes,sign(bytes,app_id,String(now),"wrong-secret")),false);
 const wrongApp=raw(signedObject({app_id:"another-app"}));
 assert.equal(await verifier.verify(wrongApp,sign(wrongApp,"another-app")),false);
 for(const drift of [now-300001,now+300001]) {
  const old=raw(signedObject({timestamp:drift}));
  assert.equal(await verifier.verify(old,sign(old,app_id,String(drift))),false);
 }
 const invalid=raw(signedObject({timestamp:"2026-10-14T04:00:00Z"}));
 assert.equal(await verifier.verify(invalid,sign(invalid,app_id,"2026-10-14T04:00:00Z")),false);
});
test("signed sender/recipient mismatch, unknown user and event types cannot enter orders",async()=>{
 const normal=make().normalizer;
 const samples=[
  signedObject({recipient:{id:"OTHER-OA"}}),
  signedObject({sender:{id:"unknown-customer"}}),
  signedObject({sender:{id:"246845883529697922"},event_name:"oa_send_text"}),
  signedObject({event_name:"user_send_image",message:{msg_id:"img",attachments:[]}}),
  signedObject({event_name:"user_send_file",message:{msg_id:"file",attachments:[]}}),
  signedObject({event_name:"user_click_button",message:{msg_id:"button",payload:"approve"}}),
  signedObject({event_name:"user_send_text",message:{text:"OK"}}),
  signedObject({event_name:"user_send_text",message:{msg_id:"unsafe id",text:"OK"}})
 ];
 for(const e of samples)assert.throws(()=>normal.normalize(raw(e)),/INVALID_OFFICIAL_EVENT/);
});
test("signed ordinary OK or forged postback metadata NEVER becomes a confirmation",async()=>{
 const {verifier,normalizer}=make();
 const inserts=[];
 const ingress=new ZaloIngress(verifier,normalizer,{async insert_once(event){
  inserts.push(event);return "inserted";
 }});
 const forged=signedObject({message:{msg_id:"msg-ok",text:"OK",
   postback:{kind:"verified_confirmation_accept",challenge_id:"fake",challenge_token:"forged"}},
   confirmation_postback:{kind:"verified_confirmation_accept"}});
 const bytes=raw(forged),receipt=await ingress.receive(bytes,sign(bytes));
 assert.equal(receipt.status,"accepted");
 assert.equal(inserts.length,1);
 assert.equal(inserts[0].text,"OK");
 assert.equal(inserts[0].confirmation_postback,undefined);
 assert.equal(inserts[0].kind,"text");
});
test("server mapping and verifier required; missing or forged OA never persists",async()=>{
 for(const config of [
  {app_id:"",oa_id,oa_secret_key:secret,resolve_verified_user:()=>null},
  {app_id,oa_id,oa_secret_key:"short",resolve_verified_user:()=>null},
  {app_id,oa_id,oa_secret_key:secret,resolve_verified_user:null}
 ])assert.throws(()=>createOfficialZaloWebhookAdapter(config),/OFFICIAL_ZALO_SERVER_CONFIG_REQUIRED/);
 const {verifier,normalizer}=make();
 let persisted=0;
 const ingress=new ZaloIngress(verifier,normalizer,{
   async insert_once(){persisted++;return "inserted"}
 });
 const event=signedObject({recipient:{id:"untrusted-shop"}});
 const bytes=raw(event);
 await assert.rejects(ingress.receive(bytes,sign(bytes)),/INVALID_OFFICIAL_EVENT/);
 await assert.rejects(ingress.receive(bytes,{"x-zevent-signature":"mac="+("a".repeat(64))}),/WEBHOOK_SIGNATURE_REJECTED/);
 assert.equal(persisted,0);
});
