/** AI4 CODE-008 browser acceptance: REAL Fastify + isolated PostgreSQL.
 * No route interception, no untrusted auth shortcuts, no live OA/print.
 * Runner is intentionally kept in tests/ui; AI0 owns root scripts/workflows.
 * Usage: TEST_DATABASE_URL=postgresql://... AUTOIN_OPERATION_MODE=simulation
 *        node --import tsx tests/ui/code008-product-browser.mjs
 * Prerequisites: isolated migrated DB, root npm ci, VITE_DEMO_MODE=false web build,
 * python3 playwright and Chrome/Chromium in PATH.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import pg from 'pg';
import { createCoreModule } from '../../backend/core/factory.ts';
import { createAiOrderPort } from '../../backend/core/ai-order-port.ts';
import { createSyntheticZaloIngress } from '../../backend/composition/zalo-simulation.ts';
import { buildIntegratedApp } from '../../backend/composition/runtime.ts';
import { asSqlPool, assertIsolatedSimulationDatabase } from '../../backend/composition/postgres.ts';

const db = process.env.TEST_DATABASE_URL;
if (!db) throw Error('NOT RUN: TEST_DATABASE_URL for migrated isolated DB required');
assertIsolatedSimulationDatabase(db);
if (process.env.AUTOIN_OPERATION_MODE !== 'simulation')
  throw Error('NOT RUN: AUTOIN_OPERATION_MODE must equal simulation');
const root = resolve('web/dist');
const html = await readFile(resolve(root, 'index.html'), 'utf8').catch(() => null);
const lock = await stat('web/package-lock.json').catch(() => null);
assert.ok(html?.includes('/assets/') && lock?.isFile(),
  'NOT RUN: build real VITE_DEMO_MODE=false UI with locked web dependencies');
const pool = new pg.Pool({ connectionString: db, max: 4, connectionTimeoutMillis: 5000 });
const shop = 'autoin-test-ai4-' + randomUUID();
const shop409 = 'autoin-test-ai4-' + randomUUID();
const oa = 'oa-ai4-' + randomUUID();
const key = randomUUID() + randomUUID();
const pwd = 'isolated-ai4-' + randomUUID();
const pwd409 = 'isolated-409-' + randomUUID();
const customer = 'ai4-product-customer-' + randomUUID();
const chat = 'ai4-product-chat-' + randomUUID();
const core = createCoreModule({ pool: asSqlPool(pool) });
const headers = token => ({ authorization: 'Bearer ' + token });
const mime = { '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };
let app = null, browserActive = false;
const forbidden = [];
let browserFinished = false;
const uuid = () => randomUUID();
const reqData = value => ({ documents: [{ artifact_name: 'PUBLIC_SYNTHETIC_' + value + '.pdf',
  copies: 1, paper: 'A4', duplex: false }] });
const draft = async (label, withChat = false) =>
  core.service.createDraft((await core.auth.login(shop, 'owner', pwd)).principal,
    { customer_id: customer + '-' + label, ...(withChat ? { conversation_id: chat + '-' + label } : {}),
      request_data: reqData(label), idempotency_key: uuid() });
const planFor = hash => ({ request_hash: hash, document_pages: 1, printed_faces: 1,
  physical_sheets: 1, ready: true, printer_id: 'SYNTHETIC_NO_DEVICE',
  artifact_ref: 'test-fixture-no-document', verified_by: 'AI4_ISOLATED_TEST_ONLY' });
const processor = { id: 'ai4-fixture-processor', shop_id: shop, role: 'processor', verified: true };
const countSql = "SELECT " +
  "(SELECT COUNT(*)::int FROM core_confirmations c JOIN core_orders o ON o.id=c.order_id WHERE o.shop_id=$1) AS confirmations," +
  "(SELECT COUNT(*)::int FROM core_approvals a JOIN core_orders o ON o.id=a.order_id WHERE o.shop_id=$1) AS approvals," +
  "(SELECT COUNT(*)::int FROM core_print_jobs j JOIN core_orders o ON o.id=j.order_id WHERE o.shop_id=$1) AS print_jobs";
const count = async () => (await pool.query(countSql, [shop])).rows[0];
const synthetic = (event_id, kind) => ({
  synthetic_fixture: true, event_id, oa_id: oa, customer_id: customer,
  conversation_id: chat, occurred_at: new Date().toISOString(), kind,
  ...(kind === 'text' ? { text: 'In A4 - dữ liệu thử không phải khách thật' } :
    { filename: 'fixture.pdf', file_ref: 'SYNTHETIC-NOT-A-REAL-FILE' })
});
try {
  await core.auth.bootstrapOwner({ shop_id: shop, username: 'owner',
    password: pwd, bootstrap_enabled: true });
  await core.auth.bootstrapOwner({ shop_id: shop409, username: 'owner',
    password: pwd409, bootstrap_enabled: true });
  await pool.query("UPDATE core_shop_settings SET mode='safe' WHERE shop_id=$1", [shop409]);
  const session = await core.auth.login(shop, 'owner', pwd);
  const staff = session.principal;
  const processing = await draft('processing');
  const clear0 = await draft('clear');
  await core.service.publishVerifiedPlan(processor, clear0.order_id, {
    expected_revision: 1, plan: planFor(clear0.request_hash), idempotency_key: uuid()
  });
  const human = await draft('human', true);
  const stale = await draft('stale');
  await core.service.publishVerifiedPlan(processor, stale.order_id, {
    expected_revision: 1, plan: planFor(stale.request_hash), idempotency_key: uuid()
  });
  // New request_data destroys the trusted plan and changes the hash.
  await core.service.revise(staff, stale.order_id, { expected_revision: 2,
    request_data: reqData('new-hash'), idempotency_key: uuid() });
  const oldHash = stale.request_hash;
  const ingress = createSyntheticZaloIngress(pool, {
    kind: 'synthetic_fixture', shop_id: shop, oa_id: oa, fixture_key: key
  });
  app = buildIntegratedApp({ pool: asSqlPool(pool), zaloWebhook: ingress });
  app.addHook('onRequest', async req => {
    if (browserActive && !['GET','HEAD','OPTIONS'].includes(req.method) &&
        req.url !== '/api/v1/auth/login') {
      forbidden.push({ method: req.method, path: req.url.split('?')[0] });
    }
  });
  app.get('/', async (_req, reply) => reply.type('text/html; charset=utf-8')
    .header('Cache-Control', 'no-store').send(html));
  app.get('/assets/*', async (request, reply) => {
    const tail = request.params?.['*'];
    if (typeof tail !== 'string' || !/^[a-zA-Z0-9._/-]+$/.test(tail) ||
        tail.split('/').some(v => !v || v === '.' || v === '..'))
      return reply.code(404).send();
    const asset = resolve(root, 'assets', tail);
    if (!asset.startsWith(resolve(root, 'assets') + sep)) return reply.code(404).send();
    const data = await readFile(asset).catch(() => null);
    return data ? reply.type(mime[extname(asset)] ?? 'application/octet-stream')
      .header('Cache-Control', 'no-store').send(data) : reply.code(404).send();
  });
  const send = async (eventId, kind) => {
    const result = await app.inject({ method: 'POST', url: '/webhooks/zalo',
      headers: { 'x-test-fixture-key': key, 'content-type': 'application/json' },
      payload: JSON.stringify(synthetic(eventId, kind)) });
    assert.equal(result.statusCode, 200, 'synthetic ingress must use real verifier');
    assert.equal(result.json().status, 'accepted', 'real ingestion must persist synthetic source');
  };
  const initial = 'initial-' + uuid();
  await send(initial, 'text');
  const ai = createAiOrderPort({ store: core.store, trusted: { shop_id: shop, oa_id: oa } });
  const proposed = await ai.suggest_draft({
    conversation_id: chat, customer_id: customer, event_ids: [initial],
    text: 'In A4', idempotency_key: uuid(), expected_generation: 0
  });
  assert.equal(proposed.status, 'created', 'trusted AI Port must bind initial event');
  const extra = 'extra-' + uuid();
  await send(extra, 'file'); // source arrived, NOT reconciled into current revision
  const ids = { clear: clear0.order_id, processing0: processing.order_id,
    needs_human0: human.order_id, pending1: proposed.order_id,
    stale_hash: stale.order_id, stale_revision: stale.order_id };
  // Every expected status comes from actual Fastify GET, never an API response mock.
  for (const [name, id, expected] of [
    ['clear', ids.clear, 'clear'], ['processing0', ids.processing0, 'processing'],
    ['needs_human0', ids.needs_human0, 'needs_human'],
    ['pending1', ids.pending1, 'processing'], ['stale_hash', ids.stale_hash, 'processing']]) {
    const r = await app.inject({ method: 'GET', url: '/api/v1/orders/' + id,
      headers: headers(session.token) });
    assert.equal(r.statusCode, 200, name + ' must be genuine backend read');
    assert.equal(r.json().current.pending_updates.status, expected,
      name + ' backend pending must come from real PostgreSQL');
    if (name === 'pending1') {
      assert.equal(r.json().current.pending_updates.unresolved_count, 1);
      assert.equal(r.json().current.pending_updates.items.length, 1);
      assert.equal(r.json().current.pending_updates.items[0].kind, 'file');
    }
    if (name === 'clear') assert.equal(r.json().current.pending_updates.unresolved_count, 0);
    if (name === 'stale_hash') assert.notEqual(r.json().current.request_hash, oldHash);
    console.log('PASS REAL BACKEND ' + name + ' ' + expected);
  }
  const anonymous = await app.inject({method:'GET',url:'/api/v1/orders'});
  assert.equal(anonymous.statusCode, 401, 'real auth guard required');
  const unavailable = await app.inject({ method:'GET',
    url:'/api/v1/orders/' + ids.clear + '/revisions/1/previews',
    headers: headers(session.token) });
  assert.equal(unavailable.statusCode, 503, 'real unconfigured preview API returns 503');
  // Separate already-authenticated simulation shop; no runtime authentication bypass.
  const forbiddenSession = await core.auth.login(shop409, 'owner', pwd409);
  const locked = await app.inject({ method:'GET', url:'/api/v1/runtime-status',
    headers: headers(forbiddenSession.token) });
  assert.equal(locked.statusCode, 409, 'real runtime-status safe shop returns 409');
  console.log('PASS REAL BACKEND GET 401 / 409 (runtime-status) / 503 (previews)');
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address();
  assert.ok(addr && typeof addr !== 'string');
  const url = 'http://127.0.0.1:' + addr.port + '/';
  const baseline = await count();
  assert.deepEqual(baseline, { confirmations: 0, approvals: 0, print_jobs: 0 });
  browserActive = true;
  const env = { ...process.env, AI4_BROWSER_URL: url, AI4_SHOP: shop,
    AI4_PASSWORD: pwd, AI4_ORDERS: JSON.stringify(ids), AI4_OLD_HASH: oldHash,
    AI4_BEARER: session.token, AI4_409_BEARER: forbiddenSession.token };
  const exitCode = await new Promise((done, reject) => {
    const child = spawn('python3', ['tests/ui/code008-product-browser.py'],
      { cwd: process.cwd(), env, stdio: ['ignore', 'inherit', 'inherit'] });
    child.once('error', reject);
    child.once('close', done);
  });
  browserActive = false;
  const after = await count();
  assert.deepEqual(after, baseline,
    'Browser changed real PostgreSQL confirmation/approval/print job count');
  assert.deepEqual(forbidden, [], 'Browser sent non-login mutation to product server');
  assert.equal(exitCode, 0, 'PRODUCT Chromium scenario failed — NOT PASS');
  browserFinished = true;
  console.log('PASS AI4 real Fastify/PostgreSQL/Chromium; backend counts ' +
    JSON.stringify(baseline) + ' -> ' + JSON.stringify(after) +
    '; browser non-login mutations=0');
  console.log('PARTIAL: GET 409/503 direct authentic API PASS, but UI detail GET ' +
    '409/503 error banners NOT RUN without safe scoped server fault fixture');
  console.log('OA_LIVE=NOT_RUN RICOH_LIVE=NOT_RUN IPHONE_SAFARI=NOT_RUN');
} finally {
  browserActive = false;
  if (app) await app.close();
  await pool.end();
  if (!browserFinished) console.error('AI4 product browser INCOMPLETE / NOT PASS');
}
