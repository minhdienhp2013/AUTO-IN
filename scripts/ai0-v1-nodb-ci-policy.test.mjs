import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertExactWorkflowTestPaths,
  extractWorkflowTestPaths,
  findServiceDatabaseAccess,
  findUnsafeSqliteUse
} from './ai0-v1-nodb-ci-policy.mjs';

test('database access detector catches static import forms and qualified clients', () => {
  for (const source of [
    "import { Pool } from 'pg';",
    "const { Pool } = require('pg');",
    "const pg = await import('pg');",
    "const pg = await import(resolveModuleName());",
    "const pool = new pg.Pool({ host: 'db.internal', database: 'app' });",
    "const pool = new pg['Pool']({ host: 'db.internal', database: 'app' });",
    "const pg = require(moduleName);"
  ]) {
    assert.notDeepEqual(findServiceDatabaseAccess(source), [], source);
  }
});

test('database access detector accepts a literal non-database import', () => {
  assert.deepEqual(findServiceDatabaseAccess("import { test } from 'node:test';"), []);
  assert.deepEqual(findServiceDatabaseAccess("require(path.join(root,'core/ai-order-port.js'));"), []);
  assert.deepEqual(findServiceDatabaseAccess("require(path.join(root,'jobs/worker.js'));"), []);
});

test('computed and aliased loaders fail closed while fake PgStore adapters stay file-scoped', () => {
  for (const source of [
    "require(path.join(root, moduleName));",
    "const load = require; load('pg');",
    "const load = module.require.bind(module); load('pg');",
    "module['require']('pg');",
    "const load = globalThis.require; load('pg');"
  ]) assert.notDeepEqual(findServiceDatabaseAccess(source), [], source);

  const approved = 'tests/unit/core/word-review-source.test.cjs';
  const fakeAdapter = "require(path.join(root,'storage/database.js')); const store = new PgStore(fakePool);";
  assert.deepEqual(findServiceDatabaseAccess(fakeAdapter, approved), []);
  assert.notDeepEqual(findServiceDatabaseAccess(fakeAdapter, 'tests/unit/core/other.test.cjs'), []);
});

test('Core safety loader is accepted only with a fixed list of literal Core targets', () => {
  const file = 'tests/unit/core/safety.test.cjs';
  const reviewed = `const load=(m)=>require(path.join(root,m+'.js'));
const {OrderService}=load('core/service');`;
  assert.deepEqual(findServiceDatabaseAccess(reviewed, file), []);
  const changed = reviewed.replace("load('core/service')", 'load(process.env.MODULE)');
  assert.notDeepEqual(findServiceDatabaseAccess(changed, file), []);
});

test('SQLite under pytest tmp_path is accepted', () => {
  const source = `
def test_journal(tmp_path):
    path = tmp_path / "journal.sqlite"
    sqlite3.connect(path)
`;
  assert.deepEqual(findUnsafeSqliteUse(source, 'tests/unit/printing/test_agent.py', new Set([
    'tests/unit/printing/test_agent.py'
  ])), []);
});

test('SQLite under TemporaryDirectory is accepted only through that directory', () => {
  const source = `
with tempfile.TemporaryDirectory() as folder:
    root = Path(folder)
    path = root / "journal.sqlite"
    sqlite3.connect(path)
`;
  assert.deepEqual(findUnsafeSqliteUse(source, 'tests/unit/printing/test_pilot_native_print.py', new Set([
    'tests/unit/printing/test_pilot_native_print.py'
  ])), []);
});

test('unrelated temporary marker cannot bless a fixed SQLite path', () => {
  const source = `
def test_bad_path(tmp_path):
    path = Path("/var/lib/auto-in/journal.sqlite")
    sqlite3.connect(path)
`;
  assert.notDeepEqual(findUnsafeSqliteUse(source, 'tests/unit/printing/test_agent.py', new Set([
    'tests/unit/printing/test_agent.py'
  ])), []);
});

test('a reassigned fixture name and an unsafe path alias are not temporary proof', () => {
  const source = `
def test_bad_path(tmp_path):
    tmp_path = Path('/var/lib/auto-in')
    path = tmp_path / 'journal.sqlite'
    journal = Journal(path)
`;
  assert.notDeepEqual(findUnsafeSqliteUse(source, 'tests/unit/printing/test_agent.py', new Set([
    'tests/unit/printing/test_agent.py'
  ])), []);
});

test('safe aliases are invalidated by an unsafe reassignment', () => {
  const source = `
def test_bad_path(tmp_path):
    path = tmp_path / 'safe.sqlite'
    path = configured_database_path
    sqlite3.connect(path)
`;
  assert.notDeepEqual(findUnsafeSqliteUse(source, 'tests/unit/printing/test_agent.py', new Set([
    'tests/unit/printing/test_agent.py'
  ])), []);
});

test('SQLite connection cannot use an untracked path variable', () => {
  const source = `
def test_bad_path(tmp_path):
    path = read_configured_path()
    sqlite3.connect(path)
`;
  assert.notDeepEqual(findUnsafeSqliteUse(source, 'tests/unit/printing/test_agent.py', new Set([
    'tests/unit/printing/test_agent.py'
  ])), []);
});

test('SQLite in a test outside the explicit exception is rejected', () => {
  assert.notDeepEqual(findUnsafeSqliteUse(
    "sqlite3.connect(tmp_path / 'x.sqlite')",
    'tests/unit/documents/test_bridge.py',
    new Set()
  ), []);
});

test('workflow extractor reads actual run steps and expands only Core glob', () => {
  const workflow = `
steps:
  - name: Core
    run: |
      node --test tests/unit/core/*.test.cjs
  - name: Zalo
    run: >-
      node --test
      tests/unit/zalo/rules.test.mjs
`;
  assert.deepEqual(extractWorkflowTestPaths(workflow, ['tests/unit/core/a.test.cjs']), [
    'tests/unit/core/a.test.cjs', 'tests/unit/zalo/rules.test.mjs'
  ]);
});

test('workflow exact comparison rejects an extra test path', () => {
  assert.throws(() => assertExactWorkflowTestPaths(
    ['tests/unit/core/a.test.cjs', 'tests/unit/core/unreviewed.test.cjs'],
    ['tests/unit/core/a.test.cjs']
  ), /extra: tests\/unit\/core\/unreviewed\.test\.cjs/);
});

test('workflow exact comparison rejects missing and duplicate paths', () => {
  assert.throws(() => assertExactWorkflowTestPaths(
    ['tests/unit/core/a.test.cjs', 'tests/unit/core/a.test.cjs'],
    ['tests/unit/core/a.test.cjs', 'tests/unit/core/b.test.cjs']
  ), /duplicate: .*missing:/);
});

test('unapproved workflow glob fails closed', () => {
  assert.throws(() => extractWorkflowTestPaths(
    'steps:\n  - name: Zalo\n    run: node --test tests/unit/zalo/*.test.mjs\n',
    []
  ), /unsupported workflow test glob/);
});
