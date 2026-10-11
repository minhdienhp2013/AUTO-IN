import test from "node:test";
import assert from "node:assert/strict";
import {DeepSeekIntentAdapter,validateAiOutput,budgetAlerts} from "../../../backend/ai/deepseek.ts";

test("DeepSeek uses JSON mode, parses bounded intent, records usage with mock transport",async()=>{
 const sent=[],records=[];
 const fetchMock=async(url,init)=>{sent.push({url,options:JSON.parse(init.body)});
   return {ok:true,async json(){return {choices:[{finish_reason:"stop",message:{content:JSON.stringify({
     intent:"PRINT",requires_clarification:false
   })}}],usage:{prompt_tokens:120,completion_tokens:20}}}}};
 };
 const adapter=new DeepSeekIntentAdapter({
  api_key:"synthetic-not-a-token",model:"synthetic-test-model",
  rate_micro_usd_per_million_input:1000000,
  rate_micro_usd_per_million_output:3000000,
  transport:fetchMock,
 },{async can_spend(){return true},async record(usage){records.push(usage)}});
 const response=await adapter.classify("in 2 mặt");
 assert.equal(response.result.intent,"PRINT");
 assert.equal(records.length,1);
 assert.equal(records[0].cost_micro_usd,180);
 assert.equal(sent[0].url,"https://api.deepseek.com/chat/completions");
 assert.deepEqual(sent[0].options.response_format,{type:"json_object"});
 assert.ok(!JSON.stringify(sent[0].options).includes("synthetic-not-a-token"));
});
test("budget exhaustion prevents network request and customer events remain upstream",async()=>{
 let called=0;
 const adapter=new DeepSeekIntentAdapter({
  api_key:"synthetic-not-a-token",model:"mock",
  rate_micro_usd_per_million_input:1,rate_micro_usd_per_million_output:1,
  transport:async()=>{called++;throw Error("unexpected");}
 },{async can_spend(){return false},async record(){}});
 await assert.rejects(adapter.classify("in giấy"),/BUDGET_EXHAUSTED/);
 assert.equal(called,0);
});
test("malicious JSON with tool/price keys is rejected, no provider empty output",()=>{
 assert.throws(()=>validateAiOutput({intent:"PRINT",requires_clarification:false,tool:"approve"}),/INVALID_AI_SCHEMA/);
 assert.throws(()=>validateAiOutput({intent:"PRINT",requires_clarification:true,question:"Giá 10000 VND"}),/UNSAFE_AI_QUESTION/);
 assert.deepEqual(budgetAlerts(79,100),[]);
});
