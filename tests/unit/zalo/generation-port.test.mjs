import test from "node:test";
import assert from "node:assert/strict";
import {ConversationProcessor} from "../../../backend/conversation/processor.ts";

const ev=(id="evt1",text="In A4")=>({
  event_id:id,oa_id:"oa-safe",customer_id:"customer",conversation_id:"conversation",
  occurred_at:"2026-10-11T00:00:00Z",kind:"text",text
});
const makeBatch=(events=[ev()])=>({key:"batch",first_at:0,deadline_at:100,events});
const aiGate=(generation=7)=>({
  async read(){return {mode:"AI",generation,conversation_id:"conversation"}}
});
const docs={async inspect(){return []}};

test("AI1 stale_generation returned by draft holds batch without outbound",async()=>{
  const proposed=[],outbound=[];
  const orders={
    async suggest_draft(payload){proposed.push(payload);return {status:"stale_generation"}},
    async route_human(){throw Error("unexpected human")}
  };
  const processor=new ConversationProcessor(aiGate(7),docs,orders,
    {async enqueue(reply){outbound.push(reply)}});
  assert.equal(await processor.consume(makeBatch()),"held");
  assert.equal(proposed.length,1);
  assert.equal(proposed[0].expected_generation,7);
  assert.deepEqual(proposed[0].event_ids,["evt1"]);
  assert.match(proposed[0].idempotency_key,/^zalo:[a-f0-9]{64}:draft$/);
  assert.deepEqual(outbound,[]);
});

test("AI1 stale_generation from route_human, including fallback errors, holds without reply",async()=>{
  for(const {text,documents} of [
    {text:"in màu",documents:{async inspect(){return []}}},
    {text:"In A4",documents:{async inspect(){throw Error("preview corrupted")}}},
    {text:"xin tư vấn",documents:{async inspect(){return []}}}
  ]) {
    const replies=[],calls=[];
    const processor=new ConversationProcessor(aiGate(9),documents,{
      async suggest_draft(){throw Error("unexpected draft")},
      async route_human(input){calls.push(input);return {status:"stale_generation"}}
    },{async enqueue(v){replies.push(v)}});
    assert.equal(await processor.consume(makeBatch([ev("e2",text)])),"held");
    assert.equal(calls.length,1);
    assert.equal(calls[0].expected_generation,9);
    assert.match(calls[0].idempotency_key,/^zalo:[a-f0-9]{64}:human:[a-f0-9]{16}$/);
    assert.deepEqual(replies,[]);
  }
});

test("takeover inside AI1 Port after preflight still prevents late draft and reply",async()=>{
  let mode="AI",generation=4,committed=0;
  const reads={async read(){return {mode,generation,conversation_id:"conversation"}}};
  const gateChecked=[];
  const processor=new ConversationProcessor(reads,docs,{
    async suggest_draft(input){
      gateChecked.push(input.expected_generation);
      // Race: a staff handover commits just as the server operation begins.
      mode="HUMAN";generation++;
      if(mode!=="AI"||generation!==input.expected_generation)return {status:"stale_generation"};
      committed++;return {order_id:"o",revision:1};
    },
    async route_human(){throw Error("unexpected")}
  },{async enqueue(){assert.fail("stale outbound") }});
  assert.equal(await processor.consume(makeBatch()),"held");
  assert.equal(committed,0);assert.deepEqual(gateChecked,[4]);
});

test("Port outage AFTER commit is safely retried with stable idempotency key",async()=>{
  const drafts=new Map(),sent=new Map(),calls=[];
  let first=true;
  const orders={
    async suggest_draft(input){
      calls.push(input);
      if(!drafts.has(input.idempotency_key))drafts.set(input.idempotency_key,{order_id:"stable-order",revision:1});
      if(first){first=false;throw Error("lost AI1 ACK");}
      return drafts.get(input.idempotency_key);
    },
    async route_human(){throw Error("unexpected")}
  };
  const processor=new ConversationProcessor(aiGate(12),docs,orders,{
    async enqueue(reply){sent.set(reply.outbound_id,reply)}
  });
  const one=makeBatch([ev("evtB"),ev("evtA")]);
  await assert.rejects(processor.consume(one),/lost AI1 ACK/);
  assert.equal(sent.size,0);
  // Recreated batch order may change after restart; dedupe identity must be stable.
  const two=makeBatch([ev("evtA"),ev("evtB")]);
  assert.equal(await processor.consume(two),"processed");
  assert.equal(drafts.size,1);
  assert.equal(sent.size,1);
  assert.equal(calls[0].idempotency_key,calls[1].idempotency_key);
  assert.equal(calls[0].expected_generation,12);
  assert.deepEqual(calls[0].event_ids,["evtA","evtB"]);
  assert.deepEqual(calls[1].event_ids,["evtA","evtB"]);
});
