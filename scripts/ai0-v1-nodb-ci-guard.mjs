import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

const branch = 'ai0/v1-expanded-nodb-ci-parser-20261026';
const root = process.cwd();
const fail = message => { throw new Error(`AI0 no-DB CI guard: ${message}`); };
const read = path => readFile(join(root, path), 'utf8');
const requireText = (source, token, label) => {
  if (!source.includes(token)) fail(`${label} is missing required text: ${token}`);
};

const zalo = [
  'batch-schedule.test.mjs', 'confirmation-candidates.test.mjs', 'core-gate.test.mjs',
  'core-pilot-intake.test.mjs', 'deepseek.test.mjs', 'durable-worker.test.mjs',
  'first-page-core-cas.test.mjs', 'first-page-delivery-intent.test.mjs',
  'first-page-question.test.mjs', 'gate-processor.test.mjs', 'generation-port.test.mjs',
  'ingress.test.mjs', 'intake-settings-role-query.test.mjs', 'oa-scope.test.mjs',
  'official-quarantine.test.mjs', 'official-webhook.test.mjs', 'order-batch-intent.test.mjs',
  'order-batch-processor.test.mjs', 'order-supplement-result.test.mjs',
  'pilot-print-intent.test.mjs', 'pilot-word-pdf-intake.test.mjs', 'pipeline.test.mjs',
  'postgres-durable.test.mjs', 'rules.test.mjs', 'structured-postback.test.mjs',
  'typecheck-strict.test.mjs', 'v1-file-intake-routing.test.mjs', 'wiring.test.mjs'
].map(file => `tests/unit/zalo/${file}`);

const composition = [
  'tests/unit/composition/pilot-core-batch.test.mjs',
  'tests/unit/composition/pilot-private-source.test.mjs',
  'tests/integration/composition/controlled-pilot-admission.test.mjs',
  'tests/integration/composition/pdf-review-preview-cleanup.test.ts',
  'tests/integration/composition/pdf-review-source-reader.test.ts',
  'tests/integration/composition/pending-review-errors.test.ts',
  'tests/integration/composition/preview.test.ts',
  'tests/integration/composition/processor.test.ts',
  'tests/integration/composition/synthetic-ingest.test.ts',
  'tests/integration/composition/synthetic-zalo-file-event.test.mjs',
  'tests/integration/composition/trusted-print-evidence.test.ts',
  'tests/integration/composition/word-review-preview.test.ts',
  'tests/integration/composition/word-review-source-reader.test.ts'
];

const python = [
  'tests/unit/documents/test_bridge.py', 'tests/unit/documents/test_fact_inspect.py',
  'tests/unit/documents/test_native_pdf_review.py',
  'tests/unit/documents/test_native_pdf_review_cli.py',
  'tests/unit/documents/test_native_word_pdf_v1.py',
  'tests/unit/documents/test_native_word_review.py',
  'tests/unit/documents/test_native_word_review_cli.py',
  'tests/unit/documents/test_print_evidence_v1.py',
  'tests/unit/documents/test_source_snapshots.py', 'tests/unit/documents/test_processor.py',
  'tests/unit/printing/test_agent.py', 'tests/unit/printing/test_backend_simulation.py',
  'tests/unit/printing/test_cli303.py', 'tests/unit/printing/test_controlled_spooler_403.py',
  'tests/unit/printing/test_evidence_gate_403.py',
  'tests/unit/printing/test_native_queue_plan_v1.py',
  'tests/unit/printing/test_native_word_preflight.py',
  'tests/unit/printing/test_native_word_watchdog.py',
  'tests/unit/printing/test_pilot_native_print.py',
  'tests/unit/printing/test_pilot_native_cli.py'
];

const workflow = await read('.github/workflows/ai0-v1-color-intake-nodb-ci.yml');
const checkWorkflow = await read('.github/workflows/check.yml');
const compositionWorkflow = await read('.github/workflows/composition-integration.yml');
const core = (await readdir(join(root, 'tests/unit/core')))
  .filter(file => file.endsWith('.test.cjs'))
  .sort()
  .map(file => `tests/unit/core/${file}`);
if (core.length === 0) fail('Core wildcard has no matching unit tests to audit');
for (const [source, label] of [[workflow, 'dedicated workflow'], [checkWorkflow, 'CODE workflow'],
  [compositionWorkflow, 'composition workflow']]) {
  requireText(source, branch, label);
}
requireText(workflow, `branches:\n      - ${branch}`, 'dedicated push trigger');
requireText(workflow, `github.head_ref == '${branch}'`, 'dedicated PR head guard');
if (workflow.includes('ai0/v1-color-intake-nodb-ci-20261025'))
  fail('dedicated workflow still targets the previous candidate branch');
requireText(workflow, 'AI1_BUILD_DIR="$PWD/dist/backend" node --test --test-concurrency=1 tests/unit/core/*.test.cjs',
  'direct Core unit command');
for (const path of [...zalo, ...composition, ...python]) requireText(workflow, path, 'explicit test allowlist');
for (const path of [
  `- ${branch}`,
  `github.head_ref != '${branch}'`,
  `github.ref != 'refs/heads/${branch}'`
]) requireText(checkWorkflow, path, 'CODE workflow exclusion');
for (const path of [
  `- ${branch}`,
  `github.head_ref != '${branch}'`,
  `github.ref != 'refs/heads/${branch}'`
]) requireText(compositionWorkflow, path, 'composition workflow exclusion');
const webQuality = compositionWorkflow.slice(compositionWorkflow.indexOf('  web-quality:'));
for (const path of [`github.head_ref != '${branch}'`, `github.ref != 'refs/heads/${branch}'`])
  requireText(webQuality, path, 'web-quality workflow exclusion');

for (const forbidden of [
  'continue-on-error:', 'npm run test:core', 'npm run test:zalo', 'npm run test:composition',
  'db:migrate', 'DATABASE_URL', 'TEST_DATABASE_URL', 'AUTOIN_TEST_DATABASE_URL',
  'postgresql://', 'tests/unit/zalo/*.test.mjs', 'tests/integration/composition/*.test.*',
  'tests/unit/printing/test_pilot_backend_http.py'
]) if (workflow.includes(forbidden)) fail(`dedicated workflow contains forbidden gate: ${forbidden}`);

const serviceDatabaseLike = /\b(?:DATABASE_URL|TEST_DATABASE_URL|AUTOIN_TEST_DATABASE_URL|PGHOST|PGPORT|PGUSER|PGPASSWORD|PGDATABASE|POSTGRES_(?:HOST|PORT|USER|PASSWORD|DB|DATABASE|URL)|MYSQL_(?:HOST|PORT|USER|PASSWORD|DATABASE|URL))\b|postgres(?:ql)?:\/\/|from\s+['"]pg['"]|require\(['"]pg['"]\)|\bnew\s+Pool\s*\(|\bpsycopg\b|\bsqlalchemy\b|\bcreate_engine\s*\(|\bMongoClient\b|\bredis\b/i;
for (const path of [...core, ...zalo, ...composition, ...python]) {
  const source = await read(path);
  if (serviceDatabaseLike.test(source)) fail(`service-database access found in test allowlist: ${path}`);
}

// Agent journal tests may use throwaway SQLite files. Keep that exception
// explicit and require a temporary test fixture; these are not app DB tests.
const localJournalTests = new Set([
  'tests/unit/printing/test_agent.py',
  'tests/unit/printing/test_backend_simulation.py',
  'tests/unit/printing/test_cli303.py',
  'tests/unit/printing/test_controlled_spooler_403.py',
  'tests/unit/printing/test_evidence_gate_403.py',
  'tests/unit/printing/test_pilot_native_print.py',
  'tests/unit/printing/test_pilot_native_cli.py'
]);
const localSqliteLike = /\bsqlite3\b|\.sqlite\b|sqlite:\/\//i;
const temporaryFixtureLike = /\btmp_path\b|TemporaryDirectory|mkdtemp/;
for (const path of python) {
  const source = await read(path);
  if (localSqliteLike.test(source) &&
      (!localJournalTests.has(path) || !temporaryFixtureLike.test(source)))
    fail(`SQLite use must be an explicit temporary agent-journal fixture: ${path}`);
}
for (const path of [
  'tests/unit/zalo/ai1-real-port-pg.test.mjs', 'tests/unit/zalo/confirmation-candidates-pg.test.mjs',
  'tests/unit/zalo/official-quarantine-pg.test.mjs', 'tests/unit/zalo/official-unified-pg.test.mjs',
  'tests/unit/zalo/official-webhook-pg.test.mjs', 'tests/unit/zalo/postgres-integration.test.mjs',
  'tests/integration/composition/runtime.test.ts'
]) if ([...zalo, ...composition].includes(path)) fail(`forbidden integration test in allowlist: ${path}`);

const parserPath = 'backend/composition/synthetic-zalo-file-event.ts';
const parser = await read(parserPath);
if (/\bfetch\s*\(|createOfficialZaloVerifiedIngress|official-quarantine|https?\.get\s*\(/.test(parser))
  fail('synthetic parser contains live media or official verifier wiring');
if (!parser.includes("source: 'SYNTHETIC_UNVERIFIED'") ||
    !parser.includes("hold_state: 'HELD_FOR_REVIEW'") ||
    !parser.includes("review_state: 'AWAITING_REVIEW'") ||
    !parser.includes("media_state: 'AWAITING_MEDIA'"))
  fail('synthetic parser must remain explicitly held and unverified');

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!['.git', 'node_modules', 'dist'].includes(entry.name)) files.push(...await walk(join(directory, entry.name)));
    } else if (/\.(?:[cm]?js|ts)$/.test(entry.name)) files.push(join(directory, entry.name));
  }
  return files;
}
const parserReferences = [];
for (const file of await walk(join(root, 'backend'))) {
  if ((await readFile(file, 'utf8')).includes('synthetic-zalo-file-event'))
    parserReferences.push(relative(root, file));
}
if (parserReferences.length !== 0)
  fail('synthetic parser must remain isolated from runtime backend wiring');

if (process.argv.includes('--ci')) {
  const event = process.env.GITHUB_EVENT_NAME;
  const currentBranch = event === 'pull_request' ? process.env.GITHUB_HEAD_REF : process.env.GITHUB_REF_NAME;
  const expectedSha = event === 'pull_request' ? process.env.PR_HEAD_SHA : process.env.GITHUB_SHA;
  if (currentBranch !== branch) fail(`expected branch ${branch}, got ${currentBranch ?? '(unset)'}`);
  if (!expectedSha || execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== expectedSha)
    fail('checked-out commit does not match the event head SHA');
  if (execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' }).trim())
    fail('checkout is not clean before dependency installation');
}

console.log(`AI0 no-DB CI static guard passed (${core.length} Core, ${zalo.length} Zalo, ${composition.length} composition, ${python.length} Python tests audited).`);
