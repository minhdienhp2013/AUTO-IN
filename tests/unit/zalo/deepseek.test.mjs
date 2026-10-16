import test from "node:test";
import assert from "node:assert/strict";
import {DeepSeekIntentAdapter,validateAiOutput,budgetAlerts} from "../../../backend/ai/deepseek.ts";

test("DeepSeek uses JSON mode, parses bounded intent, records usage with mock transport",async()=>{
 const sent=[],records=[];
 const fetchMock=async(url,init)=>{sent.push({url,options:JSON.parse(init.body)});
   return {ok:true,async json(){return {choices:[{finish_reason:"stop",message:{content:JSON.stringify({
     intent:"PRINT",requires_clarification:false
   })}}],usage:{prompt_tokens:120,completion_tokens:20}}}};
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

const baseOptions=()=>({
 api_key:"synthetic-not-a-token",model:"synthetic-test-model",
 rate_micro_usd_per_million_input:1_000_000,
 rate_micro_usd_per_million_output:3_000_000,
});
const mockReply=(input=120,output=20)=>({
 ok:true,async json(){return {
  choices:[{finish_reason:"stop",message:{content:JSON.stringify({
   intent:"PRINT",requires_clarification:false
  })}}],usage:{prompt_tokens:input,completion_tokens:output}
 }}
});

test("CODE502 invalid rates and timeouts reject before mock transport or budget record",async()=>{
 let requests=0,records=0,checks=0;
 const transport=async()=>{requests++;return mockReply()};
 const budget={async can_spend(){checks++;return true},async record(){records++}};
 const badRates=[-1,-1_000_000,NaN,Infinity,-Infinity,
   Number.MAX_SAFE_INTEGER+1,"1",undefined,null];
 for (const key of ["rate_micro_usd_per_million_input","rate_micro_usd_per_million_output"]) {
  for (const value of badRates) {
   assert.throws(()=>new DeepSeekIntentAdapter({...baseOptions(),
    [key]:value,transport},budget),/INVALID_AI_RATE/,key+":"+String(value));
  }
 }
 const badTimeouts=[0,-1,0.5,1.1,NaN,Infinity,-Infinity,
   2_147_483_648,Number.MAX_SAFE_INTEGER,"100",null];
 for (const timeout_ms of badTimeouts) {
  assert.throws(()=>new DeepSeekIntentAdapter({...baseOptions(),
   timeout_ms,transport},budget),/INVALID_AI_TIMEOUT/,String(timeout_ms));
 }
 assert.equal(requests,0);
 assert.equal(records,0);
 assert.equal(checks,0);
});

test("CODE502 zero-rate and fractional rates preserve microUSD ceil rounding",async()=>{
 const records=[];
 const budget={async can_spend(){return true},async record(x){records.push(x)}};
 const zero=new DeepSeekIntentAdapter({...baseOptions(),
  rate_micro_usd_per_million_input:0,rate_micro_usd_per_million_output:0,
  transport:async()=>mockReply(5,7)},budget);
 assert.equal((await zero.classify("in tài liệu")).usage.cost_micro_usd,0);
 const fraction=new DeepSeekIntentAdapter({...baseOptions(),
  rate_micro_usd_per_million_input:500_000,rate_micro_usd_per_million_output:0,
  transport:async()=>mockReply(1,0)},budget);
 assert.equal((await fraction.classify("in tài liệu")).usage.cost_micro_usd,1);
 assert.deepEqual(records.map(x=>x.cost_micro_usd),[0,1]);
});

test("CODE502 unsafe token usage and cost reject without budget recording",async()=>{
 const invalidUsage=[
  {prompt_tokens:-1,completion_tokens:0},
  {prompt_tokens:0.5,completion_tokens:0},
  {prompt_tokens:NaN,completion_tokens:0},
  {prompt_tokens:Infinity,completion_tokens:0},
  {prompt_tokens:0,completion_tokens:-Infinity},
  {prompt_tokens:Number.MAX_SAFE_INTEGER+1,completion_tokens:0},
  {prompt_tokens:1,completion_tokens:Number.MAX_SAFE_INTEGER+1},
  {prompt_tokens:undefined,completion_tokens:0},
 ];
 let records=0,requests=0;
 const budget={async can_spend(){return true},async record(){records++}};
 for (const usage of invalidUsage) {
  const a=new DeepSeekIntentAdapter({...baseOptions(),transport:async()=>{
   requests++;return mockReply(usage.prompt_tokens,usage.completion_tokens);
  }},budget);
  await assert.rejects(a.classify("in tài liệu"),/AI_USAGE_MISSING/);
 }
 const overflow=new DeepSeekIntentAdapter({...baseOptions(),
  rate_micro_usd_per_million_input:Number.MAX_SAFE_INTEGER,
  rate_micro_usd_per_million_output:1_000_000,
  transport:async()=>{requests++;return mockReply(Number.MAX_SAFE_INTEGER,0)}},budget);
 await assert.rejects(overflow.classify("in tài liệu"),/AI_COST_INVALID/);
 assert.equal(requests,invalidUsage.length+1);
 assert.equal(records,0);
});

test("CODE502 caller cannot mutate previously validated adapter options",async()=>{
 const requests=[],records=[];
 const config={...baseOptions(),timeout_ms:8000,transport:async(url,init)=>{
  requests.push({url,headers:init.headers,body:JSON.parse(init.body)});
  return mockReply(120,20);
 }};
 const budget={async can_spend(){return true},async record(x){records.push(x)}};
 const adapter=new DeepSeekIntentAdapter(config,budget);
 config.rate_micro_usd_per_million_input=-1_000_000;
 config.rate_micro_usd_per_million_output=Infinity;
 config.timeout_ms=0;
 config.api_key="untrusted-overwrite";
 config.model="untrusted-overwrite";
 config.transport=async()=>{throw Error("UNSAFE_MUTATED_TRANSPORT")};
 const call=await adapter.classify("in tài liệu");
 assert.equal(call.usage.cost_micro_usd,180);
 assert.equal(records.length,1);
 assert.equal(records[0].cost_micro_usd,180);
 assert.equal(requests.length,1);
 assert.equal(requests[0].body.model,"synthetic-test-model");
 assert.equal(requests[0].headers.Authorization,"Bearer synthetic-not-a-token");
});
