import test from 'node:test';
import assert from 'node:assert/strict';
import {assertLocalSimulationUrl} from './local-http-guard.mjs';
const skip=process.env.AUTOIN_RUN_HTTP_ACCEPTANCE==='1'?false:'HTTP integrated server NOT RUN';
test('HTTP-READINESS: authenticated business and agent operations must be connected',{skip},async()=>{
 const origin=assertLocalSimulationUrl(process.env.AUTOIN_API_URL);
 const r=await fetch(new URL('/health',origin),{signal:AbortSignal.timeout(5000),redirect:'manual'});
 assert.equal(r.status,200,'No integrated server available');
 const body=await r.json();
 assert.equal(body.mode,'simulation');
 assert.equal(body.live_enabled,false);
 assert.equal(body.auth_configured,true,'Bare scaffold 401 is not product-level auth PASS');
 for(const id of ['me','listOrders','approveOrder','claimJob','markSending','reportJob'])
  assert.ok(body.configured_operations?.includes(id),'Missing integrated operation: '+id);
});
