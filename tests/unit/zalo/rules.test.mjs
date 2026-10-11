import test from "node:test";
import assert from "node:assert/strict";
import {interpretByRules} from "../../../backend/conversation/rules.ts";
import {budgetAlerts,validateAiOutput} from "../../../backend/ai/deepseek.ts";
import {downloadWithRetry} from "../../../backend/integrations/zalo/retry.ts";
const events=(text)=>[{event_id:"x",oa_id:"oa",customer_id:"a",conversation_id:"a",kind:"text",occurred_at:"2026-10-11T00:00:00Z",text}];
test("Excel/color/ZIP>5 escalated, ZIP unknown escalated",()=>{
 assert.equal(interpretByRules(events("in"),[{kind:"excel"}]).handover_reason,"EXCEL");
 assert.equal(interpretByRules(events("in màu"),[]).handover_reason,"COLOR_PRINT");
 assert.equal(interpretByRules(events("in"),[{kind:"zip",count_inside:6}]).handover_reason,"TOO_MANY_DOCUMENTS");
 assert.equal(interpretByRules(events("in"),[{kind:"zip"}]).handover_reason,"NEEDS_CLARIFICATION");
});
test("AI cannot price or claim printed, normal request requires confirmation",()=>{
 assert.match(interpretByRules(events("bao nhiêu tiền")).reply,/nhân viên/);
 assert.equal(interpretByRules(events("in A4 2 mặt")).requires_confirmation,true);
 assert.throws(()=>validateAiOutput({intent:"PRINT",requires_clarification:false,price:12000}),/INVALID_AI_SCHEMA/);
 assert.throws(()=>validateAiOutput({intent:"PRINT",requires_clarification:true,question:"Đã in rồi"}),/UNSAFE_AI_QUESTION/);
 assert.deepEqual(budgetAlerts(95,100),[80,95]);
 assert.deepEqual(budgetAlerts(100,100),[80,95,100]);
});
test("file download retries exactly twice, then routes human",async()=>{
 let count=0;const seen=[];
 const failure=await downloadWithRetry(async()=>{count++;throw Error("network")},
  async i=>{seen.push(i)});
 assert.deepEqual(failure,{status:"needs_human",attempts:3});
 assert.equal(count,3);assert.deepEqual(seen,[1,2,3]);
 count=0;
 const ok=await downloadWithRetry(async()=>{count++;if(count<3)throw Error("again");return "file"});
 assert.deepEqual(ok,{status:"ok",data:"file",attempts:3});
});
