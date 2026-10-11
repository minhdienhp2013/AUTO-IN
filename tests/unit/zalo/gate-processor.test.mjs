import test from "node:test";
import assert from "node:assert/strict";
import {OutboundDispatcher} from "../../../backend/conversation/gate.ts";
import {ConversationProcessor} from "../../../backend/conversation/processor.ts";
const event={event_id:"e",oa_id:"oa",customer_id:"c",conversation_id:"s",occurred_at:"2026-10-11T00:00:00Z",kind:"text",text:"In A4"};
test("takeover before reserved send prevents OA outbound",async()=>{
 let sent=0,marked=[],generation=1,mode="AI";
 const gate={async read(){return {conversation_id:"s",generation,mode}}};
 const port={async reserve_if_current(){generation++;mode="HUMAN";return true},async mark(_id,status){marked.push(status)}};
 const dispatcher=new OutboundDispatcher(gate,port,{async send_text(){sent++}},{now:()=>new Date()},{allowed:()=>true});
 assert.equal(await dispatcher.deliver({outbound_id:"r",conversation_id:"s",generation:1,text:"x"}),"blocked");
 assert.equal(sent,0);assert.deepEqual(marked,["CANCELLED"]);
});
test("takeover while DeepSeek is generating blocks stale reply",async()=>{
 let generation=5,mode="AI",drafts=0,replies=0,release;
 const gate={async read(){return {conversation_id:"s",generation,mode}}};
 const processor=new ConversationProcessor(gate,{async inspect(){return []}},
  {async suggest_draft(){drafts++;return {order_id:"o",revision:1}},async route_human(){}},
  {async enqueue(){replies++}},
  {async classify(){await new Promise(r=>{release=r});return {result:{intent:"PRINT",requires_clarification:false}}}});
 const p=processor.consume({key:"s",first_at:0,deadline_at:60000,events:[{...event,text:"xin tư vấn"}]});
 await Promise.resolve();await Promise.resolve();
 mode="HUMAN";generation=6;
 release?.();
 // The fake promise may not yet have registered; exercise deterministic microtasks.
 if(!release){await Promise.resolve();release?.()}
 assert.equal(await p,"held");assert.equal(replies,0);assert.equal(drafts,1);
});
test("unknown outbound never blindly retries; budget outage never loses original events",async()=>{
 let sends=0,statuses=[];
 const gate={async read(){return {conversation_id:"s",generation:2,mode:"AI"}}};
 const outbox={async reserve_if_current(){return sends===0},async mark(_id,status){statuses.push(status)}};
 const dispatcher=new OutboundDispatcher(gate,outbox,{async send_text(){sends++;throw Error("timeout")}},{now:()=>new Date()},{allowed:()=>true});
 const value={outbound_id:"q",conversation_id:"s",generation:2,text:"hello"};
 assert.equal(await dispatcher.deliver(value),"unknown");
 assert.equal(await dispatcher.deliver(value),"blocked");
 assert.equal(sends,1);assert.deepEqual(statuses,["UNKNOWN"]);
});
