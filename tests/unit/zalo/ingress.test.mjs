import test from "node:test";
import assert from "node:assert/strict";
import { ZaloIngress,SyntheticFixtureNormalizer,SyntheticTestVerifier,RejectUnverifiedLiveZalo } from "../../../backend/integrations/zalo/protocol.ts";
const raw = (x={})=>new TextEncoder().encode(JSON.stringify({
 synthetic_fixture:true,event_id:"e1",oa_id:"oa1",customer_id:"c1",
 conversation_id:"s1",occurred_at:"2026-10-11T07:00:00Z",kind:"text",text:"in A4",...x
}));
test("rejects unsigned webhook before any persistence",async()=>{
 let writes=0;const repo={async insert_once(){writes++;return "inserted"}};
 const ingress=new ZaloIngress(new SyntheticTestVerifier("secret"),new SyntheticFixtureNormalizer(),repo);
 await assert.rejects(ingress.receive(raw(),{}),/SIGNATURE_REJECTED/);
 assert.equal(writes,0);
});
test("durable port receipt and duplicate are distinct",async()=>{
 const seen=new Set();const repo={async insert_once(evt){const key=evt.oa_id+":"+evt.event_id;
 if(seen.has(key))return "duplicate";seen.add(key);return "inserted"}};
 const ingress=new ZaloIngress(new SyntheticTestVerifier("secret"),new SyntheticFixtureNormalizer(),repo);
 assert.equal((await ingress.receive(raw(),{"x-test-fixture-key":"secret"})).status,"accepted");
 assert.equal((await ingress.receive(raw(),{"x-test-fixture-key":"secret"})).status,"duplicate");
 assert.equal(seen.size,1);
});
test("live defaults fail closed; bad kind/file/time rejected",async()=>{
 const repo={async insert_once(){return "inserted"}};
 const live=new ZaloIngress(new RejectUnverifiedLiveZalo(),new RejectUnverifiedLiveZalo(),repo);
 await assert.rejects(live.receive(raw(),{}),/SIGNATURE_REJECTED/);
 const synth=new ZaloIngress(new SyntheticTestVerifier("secret"),new SyntheticFixtureNormalizer(),repo);
 for(const obj of [{kind:"evil"},{kind:"file",file_ref:null},{occurred_at:"x"}]) {
  await assert.rejects(synth.receive(raw(obj),{"x-test-fixture-key":"secret"}));
 }
});
test("storage failure must not return accepted receipt",async()=>{
 const repo={async insert_once(){throw new Error("DB_UNAVAILABLE")}};
 const x=new ZaloIngress(new SyntheticTestVerifier("secret"),new SyntheticFixtureNormalizer(),repo);
 await assert.rejects(x.receive(raw(),{"x-test-fixture-key":"secret"}),/DB_UNAVAILABLE/);
});
