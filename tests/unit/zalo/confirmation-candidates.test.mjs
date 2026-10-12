import test from "node:test";
import assert from "node:assert/strict";
import {confirmationIntent} from "../../../backend/conversation/confirmation-candidate.ts";
import {ConversationProcessor} from "../../../backend/conversation/processor.ts";
import {createZaloPipeline} from "../../../backend/integrations/zalo/pipeline.ts";

const evt=(text="OK",id="e1")=>({event_id:id,oa_id:"oa",customer_id:"customer",
  conversation_id:"conversation",kind:"text",text,occurred_at:"2026-10-12T03:00:00Z"});
const batch=(events=[evt()])=>({key:"fixture",first_at:0,deadline_at:1,events});
test("Only a standalone literal acknowledgement is a possible intent",()=>{
 for(const text of ["OK","oke","ĐỒNG Ý","tôi đồng ý","xác nhận","đúng rồi"])
   assert.equal(confirmationIntent(batch([evt(text)]))?.event_id,"e1");
 for(const text of ["OK in A4","giá bao nhiêu","Tôi OK nếu giảm giá","ok nhé","", "OK?"])
   assert.equal(confirmationIntent(batch([evt(text)])),undefined);
 assert.equal(confirmationIntent(batch([evt("OK"),evt("OK","e2")])),undefined);
 assert.equal(confirmationIntent(batch([{...evt(),kind:"image",text:undefined}])),undefined);
});
const gate={async read(){return {mode:"AI",generation:9,conversation_id:"conversation"}}};
test("Without server confirmation Port: floating OK is held; AI1 draft, DeepSeek and sender are not called",async()=>{
 let effects=0;
 const processor=new ConversationProcessor(gate,{async inspect(){effects++ ;return []}},{
   async suggest_draft(){effects++;throw Error("NO_ORDER")},
   async route_human(){effects++;throw Error("NO_ROUTE")}
 },{async enqueue(){effects++;throw Error("NO_REPLY")}},
 {async classify(){effects++;throw Error("NO_DEEPSEEK")}});
 assert.equal(await processor.consume(batch()),"held");
 assert.equal(effects,0);
});
test("Server Port only persists candidate; pending/stale/missing challenge holds without reply",async()=>{
 for(const status of ["pending","needs_human","stale_generation"]){
   let portCalls=0,outbound=0;
   const processor=new ConversationProcessor(gate,{async inspect(){throw Error("NO_INSPECTION")}},{
     async suggest_draft(){throw Error("NO_DRAFT")},async route_human(){throw Error("NO_ROUTE")}
   },{async enqueue(){outbound++}},undefined,{async consider(input){
     portCalls++;assert.equal(input.expected_generation,9);
     return {status,reason:"CHALLENGE_NOT_VERIFIED"};
   }});
   assert.equal(await processor.consume(batch()),"held");
   assert.equal(portCalls,1);assert.equal(outbound,0);
 }
});
test("Candidate and duplicate candidate are journaled once, never treated as a customer confirmation",async()=>{
 for(const status of ["candidate","existing"]){
   let callback=0;
   const processor=new ConversationProcessor(gate,{async inspect(){throw Error("NO_INSPECT")}},{
     async suggest_draft(){throw Error("NO_DRAFT")},async route_human(){throw Error("NO_ROUTE")}
   },{async enqueue(){throw Error("NO_OUTBOUND")}},undefined,{async consider(){
     callback++;return {status,candidate_id:"synthetic-uuid"};
   }});
   assert.equal(await processor.consume(batch()),"processed");
   assert.equal(callback,1);
 }
});
test("Malformed candidate Port response fails closed; never accepts an empty ACK",async()=>{
 const processor=new ConversationProcessor(gate,{async inspect(){throw Error("NO_INSPECT")}},{
   async suggest_draft(){throw Error("NO_DRAFT")},async route_human(){throw Error("NO_ROUTE")}
 },{async enqueue(){throw Error("NO_OUTBOUND")}},undefined,{async consider(){return undefined}});
 await assert.rejects(processor.consume(batch()),/Cannot read properties|INVALID_CONFIRMATION_CANDIDATE_RESULT/);
});
test("Pipeline without live verifier/sender is denied even for textual OK",async()=>{
 const db={async transaction(){throw Error("NO_DB_REQUIRED")}};
 const pipeline=createZaloPipeline({db,trusted_shop_id:"shop",trusted_oa_id:"oa",
   orders:{async suggest_draft(){throw Error("NO_DRAFT")},async route_human(){throw Error("NO_ROUTE")}},
   documents:{async inspect(){throw Error("NO_DOC")}},
   schedule:{allowed:()=>false},clock:{now:()=>new Date()}});
 const raw=new TextEncoder().encode(JSON.stringify({...evt(),synthetic_fixture:true}));
 assert.equal((await pipeline.receive_webhook(raw,{})).status_code,403);
 assert.equal((await pipeline.tick_outbound()).disabled,true);
});
