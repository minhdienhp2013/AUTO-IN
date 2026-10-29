import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import {
  assertExactWorkflowTestPaths,
  extractWorkflowTestPaths,
  findServiceDatabaseAccess,
  findUnsafeSqliteUse
} from './ai0-v1-nodb-ci-policy.mjs';

const branch = 'ai0/v1-expanded-nodb-ci-guard-tighten-20261028';
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
const packageJson = JSON.parse(await read('package.json'));
if (packageJson.scripts?.test !== 'node --import tsx --test tests/unit/contracts/*.test.ts')
  fail('root npm test script changed; update the reviewed no-DB contract test allowlist');
const webPackageJson = JSON.parse(await read('web/package.json'));
if (webPackageJson.scripts?.test !== 'node --experimental-strip-types --test ../tests/ui/*.test.ts' ||
    webPackageJson.scripts?.prebuild !== 'npm test' ||
    webPackageJson.scripts?.build !== 'tsc --noEmit -p tsconfig.json && vite build')
  fail('web build/test lifecycle changed; update the reviewed no-DB UI test allowlist');
for (const [label, manifest] of [['root', packageJson], ['web', webPackageJson]]) {
  for (const lifecycle of ['preinstall', 'install', 'postinstall', 'prepare']) {
    if (manifest.scripts?.[lifecycle]) fail(`${label} npm ${lifecycle} lifecycle script is not reviewed`);
  }
}
const contract = (await readdir(join(root, 'tests/unit/contracts')))
  .filter(file => file.endsWith('.test.ts'))
  .sort()
  .map(file => `tests/unit/contracts/${file}`);
if (contract.length === 0) fail('root npm test script has no contract unit tests to audit');
const policyTest = 'scripts/ai0-v1-nodb-ci-policy.test.mjs';
const core = (await readdir(join(root, 'tests/unit/core')))
  .filter(file => file.endsWith('.test.cjs'))
  .sort()
  .map(file => `tests/unit/core/${file}`);
if (core.length === 0) fail('Core wildcard has no matching unit tests to audit');
const webUi = (await readdir(join(root, 'tests/ui')))
  .filter(file => file.endsWith('.test.ts'))
  .sort()
  .map(file => `tests/ui/${file}`);
if (webUi.length === 0) fail('web npm test script has no UI unit tests to audit');
const reviewedWorkflowTests = [policyTest, ...contract, ...core, ...zalo, ...composition, ...python];
reviewedWorkflowTests.push(...webUi);
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
requireText(workflow, 'run: npm --prefix web run build', 'web build with reviewed prebuild tests');
for (const path of [...zalo, ...composition, ...python]) requireText(workflow, path, 'explicit test allowlist');
try {
  const workflowTests = extractWorkflowTestPaths(workflow, core);
  if (/^\s+run:\s*npm test\s*$/m.test(workflow)) workflowTests.push(...contract);
  if (/^\s+run:\s*npm --prefix web run build\s*$/m.test(workflow)) workflowTests.push(...webUi);
  assertExactWorkflowTestPaths(workflowTests, reviewedWorkflowTests);
} catch (error) {
  fail(error.message);
}
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

for (const path of reviewedWorkflowTests) {
  const source = await read(path);
  const databaseFindings = findServiceDatabaseAccess(source, path);
  if (databaseFindings.length)
    fail(`service-database access found in test allowlist: ${path}: ${databaseFindings.join(', ')}`);
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
for (const path of python) {
  const source = await read(path);
  const sqliteFindings = findUnsafeSqliteUse(source, path, localJournalTests);
  if (sqliteFindings.length) fail(sqliteFindings.join('; '));
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

console.log(`AI0 no-DB CI static guard passed (${contract.length} contracts, ${core.length} Core, ${zalo.length} Zalo, ${composition.length} composition, ${python.length} Python, ${webUi.length} UI tests audited).`);
