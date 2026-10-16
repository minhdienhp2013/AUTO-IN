import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { valid, validJob } from '../../../contracts/validation.js';
import { canonicalJson, payloadHash, requestHash, idempotencyScope } from '../../../contracts/hash.js';
const fixture = async (name: string): Promise<any> => JSON.parse(await readFile(new URL(`../../../contracts/fixtures/${name}.json`, import.meta.url), 'utf8'));

test('synthetic fixtures match shared schemas and independent Python SHA-256 vector', async () => {
  const create = await fixture('create-order'); const vector = await fixture('hash-vector');
  assert.ok(valid('CreateOrderRequest', create));
  assert.equal(canonicalJson(create.manifest), vector.canonical_json);
  assert.equal(requestHash(create.manifest), vector.request_hash);
  assert.ok(validJob(await fixture('simulated-job')));
  assert.ok(valid('ReportRequest', await fixture('simulated-report')));
});
test('hash preserves document order/settings and text; sorts object keys', () => {
  assert.equal(payloadHash({ b: 2, a: 1 }), payloadHash({ a: 1, b: 2 }));
  assert.notEqual(payloadHash(['file_a', 'file_b']), payloadHash(['file_b', 'file_a']));
  assert.notEqual(payloadHash({ copies: 1 }), payloadHash({ copies: 2 }));
  assert.notEqual(payloadHash('é'), payloadHash('e\u0301'));
  assert.notEqual(idempotencyScope('staff1', 'approve', 'key'), idempotencyScope('staff2', 'approve', 'key'));
  assert.notEqual(idempotencyScope('staff1', 'approve', 'key'), idempotencyScope('staff1', 'revise', 'key'));
});
test('canonical hash rejects lossy values, accessors, sparse arrays and cycles', () => {
  for (const value of [undefined, NaN, Infinity, 1n, new Date(), { a: undefined }, Array(1), { get a() { throw Error('executed'); } }]) {
    assert.throws(() => canonicalJson(value));
  }
  const cycle: any = {}; cycle.self = cycle; assert.throws(() => canonicalJson(cycle));
});
test('mutation rejects fake actor/role, fractional money, missing revision and unknown fields', () => {
  const input = { expected_revision: 1, idempotency_key: 'key', amount_vnd: 15000, deposit_requested_vnd: 0, significant_cost: false };
  assert.ok(valid('QuoteRequest', input));
  for (const patch of [{ actor_id: 'owner' }, { role: 'owner' }, { amount_vnd: 1.5 }, { expected_revision: 0 }, { expected_revision: undefined }, { amount_vnd: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.equal(valid('QuoteRequest', { ...input, ...patch }), false);
  }
});
test('simulation and spooler evidence cannot prove real printing in shared JSON schema', async () => {
  const job = await fixture('simulated-job');
  assert.equal(valid('PrintJob', { ...job, state: 'VERIFIED_DONE' }), false);
  assert.equal(valid('PrintJob', { ...job, mode: 'production' }), false);
  const spooler = { evidence_kind: 'spooler', journal_id: 'journal', spooler_id: 'spooler', observed_at: '2026-10-11T00:00:00Z' };
  assert.equal(valid('PrintJob', { ...job, mode: 'production', state: 'VERIFIED_DONE', evidence: spooler }), false);
  assert.ok(validJob({ ...job, mode: 'production', state: 'SENT_UNVERIFIED', evidence: spooler }));
  const verified = { evidence_kind: 'staff_verified', journal_id: 'journal', actor_id: 'staff', verified_sheets: 1, observed_at: '2026-10-11T00:00:00Z' };
  assert.equal(validJob({ ...job, mode: 'production', state: 'VERIFIED_DONE', evidence: verified }), false);
  assert.ok(validJob({ ...job, mode: 'production', state: 'VERIFIED_DONE', evidence: { ...verified, verified_sheets: 2 } }));
});
test('agent report cannot impersonate verifying staff; requires authorization and UTC', async () => {
  const report = await fixture('simulated-report');
  assert.equal(valid('ReportRequest', { ...report, send_authorization_id: undefined }), false);
  assert.equal(valid('ReportRequest', { ...report, evidence: { ...report.evidence, observed_at: '2026-10-11T07:00:00+07:00' } }), false);
  assert.equal(valid('ReportRequest', { ...report, mode: 'production', state: 'VERIFIED_DONE', evidence: { evidence_kind: 'staff_verified', actor_id: 'owner', journal_id: 'j', observed_at: '2026-10-11T00:00:00Z', verified_sheets: 2 } }), false);
});
test('principal requires verified customer channel or scoped agent identity', () => {
  assert.equal(valid('Principal', { actor_id: 'customer', role: 'customer', permissions: [] }), false);
  assert.equal(valid('Principal', { actor_id: 'agent', role: 'agent', permissions: [], agent_id: 'agent', printer_ids: [] }), false);
});
test('OpenAPI contains distinct endpoints and resolvable shared schema references', async () => {
  const api = JSON.parse(await readFile(new URL('../../../contracts/generated/openapi.json', import.meta.url), 'utf8'));
  assert.equal(api.openapi, '3.1.0');
  assert.equal(api.paths['/internal/v1/print-jobs/{job_id}/mark-sending'].post.operationId, 'markSending');
  const schedule = api.paths['/api/v1/settings/schedule'];
  assert.equal(schedule.get.operationId, 'getShopSchedule');
  assert.deepEqual(schedule.get['x-roles'], ['owner', 'staff']);
  assert.equal(schedule.patch.operationId, 'patchShopSchedule');
  assert.deepEqual(schedule.patch['x-roles'], ['owner']);
  assert.equal(schedule.patch.requestBody.content['application/json'].schema.$ref,
    '#/components/schemas/ShopSchedulePatch');
  assert.equal(Object.keys(api.paths).length, 21);
  const walk = (value: any) => {
    if (!value || typeof value !== 'object') return;
    if (value.$ref) assert.ok(api.components.schemas[value.$ref.split('/').at(-1)]);
    for (const child of Object.values(value)) walk(child);
  };
  walk(api);
});
