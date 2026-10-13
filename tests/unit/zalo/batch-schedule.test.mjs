import test from "node:test";
import assert from "node:assert/strict";
import {MessageBatcher,FixtureBatchStore,batchKey} from "../../../backend/conversation/batch.ts";
import {scheduleDecision} from "../../../backend/conversation/schedule.ts";
const ev=(id,customer="a",at="2026-10-11T01:00:00Z")=>({event_id:id,oa_id:"oa",customer_id:customer,conversation_id:"conv-"+customer,kind:"text",occurred_at:at,text:"in"});
test("first wait 60s, subsequent waits 10s, never beyond 60s",async()=>{
 let now=0;const clock={now:()=>now},batcher=new MessageBatcher(new FixtureBatchStore(),clock);
 let b=await batcher.add(ev("1"));assert.equal(b.deadline_at,60000);
 now=15000;b=await batcher.add(ev("2"));assert.equal(b.deadline_at,25000);
 now=22000;b=await batcher.add(ev("3"));assert.equal(b.deadline_at,32000);
 now=31000;assert.equal(await batcher.flushDue(async()=>{}),0);
 now=32000;let result;assert.equal(await batcher.flushDue(async b=>{result=b}),1);
 assert.deepEqual(result.events.map(e=>e.event_id),["1","2","3"]);
 now=99000;b=await batcher.add(ev("4"));assert.equal(b.deadline_at,159000);
});
test("customer and OA/session isolation, chronological order, early complete",async()=>{
 let now=0;const store=new FixtureBatchStore(),m=new MessageBatcher(store,{now:()=>now});
 await m.add(ev("late","a","2026-10-11T01:01:00Z"));
 await m.add(ev("first","a","2026-10-11T01:00:00Z"));
 await m.add(ev("other","b"));
 let seen=[];
 assert.equal(await m.flushComplete(batchKey(ev("late")),async b=>{seen=b.events.map(x=>x.event_id)}),true);
 assert.deepEqual(seen,["first","late"]);
 assert.equal(await m.flushComplete(batchKey(ev("late")),async()=>{}),false);
 now=61000;assert.equal(await m.flushDue(async b=>{seen.push(b.events[0].event_id)}),1);
 assert.equal(seen.at(-1),"other");
});
test("Vietnam 07:00 inclusive, 21:30 exclusive; holiday advise only, override, pause",()=>{
 const schedule={paused:false,overrides:{}};
 assert.equal(scheduleDecision(new Date("2026-10-11T00:00:00Z"),schedule).ai_allowed,true);
 assert.equal(scheduleDecision(new Date("2026-10-11T14:30:00Z"),schedule).ai_allowed,false);
 assert.equal(scheduleDecision(new Date("2026-10-10T23:59:00Z"),schedule).ai_allowed,false);
 schedule.overrides["2026-10-11"]={date:"2026-10-11",open:"05:00",close:"23:00",shop_holiday:true};
 const open=scheduleDecision(new Date("2026-10-11T00:00:00Z"),schedule);
 assert.equal(open.ai_allowed,true);assert.equal(open.shop_holiday,true);
 schedule.paused=true;assert.equal(scheduleDecision(new Date("2026-10-11T00:00:00Z"),schedule).ai_allowed,false);
});
