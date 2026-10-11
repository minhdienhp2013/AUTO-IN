import test from 'node:test';
import assert from 'node:assert/strict';
import {assertLocalSimulationUrl} from './local-http-guard.mjs';
// Never send a signed provider message, never use a live OA credential.
const enabled=process.env.AUTOIN_RUN_HTTP_ACCEPTANCE==='1' &&
 process.env.AUTOIN_TEST_WEBHOOK_REJECTION==='1';
test('HTTP-ZALO-01 connected ingress rejects synthetic event WITHOUT verified signature',{skip:enabled?false:'Zalo verified ingress NOT INTEGRATED/OPTED-IN'},async()=>{
 const origin=assertLocalSimulationUrl(process.env.AUTOIN_API_URL);
 const health=await fetch(new URL('/health',origin),{signal:AbortSignal.timeout(5000),redirect:'manual'});
 assert.equal(health.status,200);
 const status=await health.json();
 assert.equal(status.mode,'simulation');
 assert.equal(status.zalo_webhook_configured,true,'AI2 ingress is not connected; do not count as a signature test');
 const body={synthetic_fixture:true,event_id:'a305-unsigned',oa_id:'fixture-oa',
  customer_id:'fixture-customer',conversation_id:'fixture-conversation',
  occurred_at:'2026-10-11T12:00:00Z',kind:'text',text:'In A4 2 ban'};
 const r=await fetch(new URL('/webhooks/zalo',origin),{
  method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify(body),redirect:'manual',signal:AbortSignal.timeout(5000)});
 assert.equal(r.status,403,'An unsigned but well-formed event must be rejected before storage');
 const data=await r.json();
 assert.equal(data?.error?.code,'WEBHOOK_SIGNATURE_REJECTED');
});
