import test from "node:test";
import assert from "node:assert/strict";
import {DurableConversationWorker} from "../../../backend/conversation/durable-worker.ts";
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
