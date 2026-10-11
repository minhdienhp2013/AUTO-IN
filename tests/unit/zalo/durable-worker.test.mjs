import test from "node:test";
import assert from "node:assert/strict";
import {DurableConversationWorker} from "../../../backend/conversation/durable-worker.ts";
const batch={batch_id:"1",lease_token:"fixture",attempts:1,key:"c",first_at:0,deadline_at:60,events:[]};
test("worker ingests even when AI has been handed to staff",async()=>{
  const actions=[];
  const queue={
    async ingest_pending(){actions.push("persisted");return 1;},
    async claim_due(){actions.push("claimed");return [batch];},
    async complete(){actions.push("complete");return true;},
    async fail(){throw Error("unexpected retry");}
  };
  const worker=new DurableConversationWorker(queue,{async consume(){actions.push("held");return "held";}});
  assert.deepEqual(await worker.tick(),{ingested:1,claimed:1,processed:0,held:1,needs_human:0,retry:0});
  assert.deepEqual(actions,["persisted","claimed","held","complete"]);
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
