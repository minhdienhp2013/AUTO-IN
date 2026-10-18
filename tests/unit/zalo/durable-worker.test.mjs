import test from "node:test";
import assert from "node:assert/strict";
import {DurableConversationWorker} from "../../../backend/conversation/durable-worker.ts";
import {ConversationProcessor} from "../../../backend/conversation/processor.ts";
const batch={batch_id:"1",lease_token:"fixture",attempts:1,key:"c",first_at:0,deadline_at:60,events:[]};
test("worker ingests even when AI has been handed to staff",async()=>{
  const actions=[];
  const queue={
    async ingest_pending(){actions.push("persisted");return 1;},
    async claim_due(){actions.push("claimed");return [batch];},
    async complete(){throw Error("held batch cannot be completed");},
    async hold(){actions.push("NEEDS_HUMAN");return true;},
    async fail(){throw Error("unexpected retry");}
  };
  const worker=new DurableConversationWorker(queue,{async consume(){actions.push("held");return "held";}});
  assert.deepEqual(await worker.tick(),{ingested:1,claimed:1,processed:0,held:1,needs_human:0,retry:0});
  assert.deepEqual(actions,["persisted","claimed","held","NEEDS_HUMAN"]);
});
test("worker retries transient failure and stops after terminal mark",async()=>{
  let errors=0;
  const queue={
    async ingest_pending(){return 0;},
    async claim_due(){return [{...batch,attempts:5}];},
    async complete(){throw Error("not called");},
    async fail(_batch,reason){assert.equal(reason,"PROCESSING_FAILED");errors++;return "needs_human";}
  };
  const worker=new DurableConversationWorker(queue,{async consume(){throw Error("network");}});
  const result=await worker.tick();
  assert.equal(result.needs_human,1);assert.equal(result.retry,0);assert.equal(errors,1);
});

test("ambiguous AI1 Port failure retries the SAME durable batch, not ACK",async()=>{
  const state={completed:0,failed:0,hold:0,attempts:0};
  const queue={
    async ingest_pending(){return 0;},
    async claim_due(){return [{...batch,attempts:++state.attempts}]},
    async complete(){state.completed++;return true;},
    async hold(){state.hold++;return true;},
    async fail(){state.failed++;return "retry";}
  };
  let calls=0;
  const worker=new DurableConversationWorker(queue,{async consume(){
    if(++calls===1)throw Error("uncertain db response");
    return "processed";
  }});
  const first=await worker.tick();
  assert.equal(first.retry,1);assert.equal(state.completed,0);assert.equal(state.failed,1);
  const second=await worker.tick();
  assert.equal(second.processed,1);assert.equal(state.completed,1);
  assert.equal(state.hold,0);assert.equal(calls,2);
});

test("image route commit with lost ACK survives worker restart as NEEDS_HUMAN",async()=>{
  const source={event_id:"image-event-1",kind:"image",oa_id:"oa-1",
    customer_id:"customer-1",conversation_id:"chat-1",
    occurred_at:"2026-10-18T10:00:00Z",file_ref:"custody:sha256:fixture"};
  const original={...batch,events:[source]};
  const state={mode:"AI",status:"OPEN",attempts:0,routeCalls:[],completed:0,
    heldBatch:null,failed:0,inspections:0,orderWrites:0,replies:0};
  const queue={
    async ingest_pending(){return 0;},
    async claim_due(){
      if(state.status!=="OPEN")return [];
      return [{...original,attempts:++state.attempts,
        lease_token:"lease-"+state.attempts}];
    },
    async complete(){state.completed++;state.status="DONE";return true;},
    async hold(value){state.status="NEEDS_HUMAN";state.heldBatch=value;return true;},
    async fail(_value,reason){
      assert.equal(reason,"PROCESSING_FAILED");state.failed++;
      state.status="OPEN";return "retry";
    }
  };
  const gate={async read(){return {conversation_id:"chat-1",mode:state.mode,generation:4};}};
  const orders={
    async apply_incoming_batch(){state.orderWrites++;assert.fail("image must never create an order");},
    async suggest_draft(){state.orderWrites++;assert.fail("image must never create a draft");},
    async route_human(input){
      state.routeCalls.push(input);
      state.mode="HUMAN"; // Represents Core's committed route_human transaction.
      throw Error("lost response after committed handover");
    }
  };
  const processor=new ConversationProcessor(gate,{async inspect(){
    state.inspections++;assert.fail("image bytes must not reach preflight/OCR");
  }},orders,{async enqueue(){state.replies++;}});

  // First worker loses the route_human response; it cannot ACK the batch.
  const first=await new DurableConversationWorker(queue,processor).tick();
  assert.equal(first.retry,1);
  assert.equal(state.failed,1);
  assert.equal(state.completed,0);
  assert.equal(state.status,"OPEN");

  // A restarted worker claims the same durable event. Core already says HUMAN,
  // so it holds the source for staff without repeating the business effect.
  const restarted=await new DurableConversationWorker(queue,processor).tick();
  assert.equal(restarted.held,1);
  assert.equal(state.status,"NEEDS_HUMAN");
  assert.equal(state.heldBatch.events[0].event_id,"image-event-1");
  assert.deepEqual(state.heldBatch.events.map(event=>event.event_id),["image-event-1"]);
  assert.equal(state.routeCalls.length,1);
  assert.equal(state.routeCalls[0].reason,"IMAGE_V1");
  assert.deepEqual(state.routeCalls[0].event_ids,["image-event-1"]);
  assert.equal(state.inspections,0);
  assert.equal(state.orderWrites,0);
  assert.equal(state.replies,0);
  assert.equal(state.completed,0);
});
