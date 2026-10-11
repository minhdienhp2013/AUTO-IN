import test from 'node:test';
import assert from 'node:assert/strict';
import {assertLocalSimulationUrl} from './local-http-guard.mjs';
// These requests never authenticate and must never reach a real printer.
// 404, 422, 500 and redirect are FAIL, not authorization PASS.
const skip = !process.env.AUTOIN_RUN_HTTP_ACCEPTANCE && 'HTTP PRODUCT TEST NOT REQUESTED';
const origin = skip ? null : assertLocalSimulationUrl(process.env.AUTOIN_API_URL);
async function anonymous(method, path, body, headers = {}) {
  const response = await fetch(new URL(path, origin), {
    method, redirect:'manual', signal:AbortSignal.timeout(5000),
    headers:{'content-type':'application/json',...headers},
    ...(body ? {body:JSON.stringify(body)} : {})
  });
  assert.ok([401,403].includes(response.status), `${method} ${path}: wanted 401/403, received ${response.status}`);
  const data=await response.json();
  assert.ok(typeof data.error?.code==='string'&&data.error.code.length, 'Missing wire v0.1 error code');
  assert.ok(!JSON.stringify(data).includes('lease_token'), 'Unauthorized response leaked job lease');
}
test('HTTP-AUTH-01 /me rejects unauthenticated caller', {skip}, () => anonymous('GET','/api/v1/auth/me'));
test('HTTP-AUTH-02 orders reject forged owner header', {skip}, () => anonymous('GET','/api/v1/orders',undefined,{'x-role':'owner','x-actor-id':'owner'}));
test('HTTP-AUTH-03 approvals reject forged flags and valid wire payload', {skip}, () => anonymous('POST','/api/v1/orders/synthetic-missing/approvals',{expected_revision:1,quote_revision:1,acknowledge_deposit_shortage:true,idempotency_key:'synthetic-anon-approval',approved:true,role:'owner'}));
test('HTTP-AUTH-04 claim rejects anonymous agent with VALID printer_id payload', {skip}, () => anonymous('POST','/internal/v1/print-jobs/claim',{printer_id:'RMP7000',idempotency_key:'synthetic-anon-claim'}));
test('HTTP-AUTH-05 reprint rejects anonymous actor', {skip}, () => anonymous('POST','/api/v1/orders/synthetic-missing/reprint',{expected_revision:1,original_job_id:'missing',reason:'synthetic denial only',idempotency_key:'synthetic-anon-reprint'}));
