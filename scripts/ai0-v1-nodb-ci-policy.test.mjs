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
    ["import { Pool } ", "from ", "'pg';"].join(''),
    ["const { Pool } = ", "require", "('pg');"].join(''),
    ["const pg = await ", "import", "('pg');"].join(''),
    ["const pg = await ", "import", "(resolveModuleName());"].join(''),
    ["const pool = new pg.", "Pool({ host: 'db.internal', database: 'app' });"].join(''),
    ["const pool = new pg", "['Pool']({ host: 'db.internal', database: 'app' });"].join(''),
    ["const pg = ", "require", "(moduleName);"].join('')
  ]) {
    assert.notDeepEqual(findServiceDatabaseAccess(source), [], source);
  }
});

test('Python database imports are detected across dotted modules and line continuations', () => {
  for (const source of [
    'import pg', 'import os, pg as db', 'from pg import Pool', 'from pg.pool import Pool',
    'import mysql.connector', 'from mysql.connector import connect',
    ['import pg \\\n', '    as driver'].join(''),
    ['from pg.pool \\\n', '    import Pool'].join(''),
    ['import psy', 'copg2 as pg'].join('')
  ]) {
    assert.notDeepEqual(findServiceDatabaseAccess(source, 'tests/unit/printing/test_bad.py'), [], source);
  }
  assert.deepEqual(findServiceDatabaseAccess('import os, pathlib', 'tests/unit/printing/test_ok.py'), []);
});

test('database access detector accepts a literal non-database import', () => {
  assert.deepEqual(findServiceDatabaseAccess("import { test } from 'node:test';"), []);
  assert.deepEqual(findServiceDatabaseAccess(["require", "(path.join(root,'core/ai-order-port.js'));"] .join('')), []);
  assert.deepEqual(findServiceDatabaseAccess(["require", "(path.join(root,'jobs/worker.js'));"] .join('')), []);
});

test('computed and aliased loaders fail closed while fake PgStore adapters stay file-scoped', () => {
  for (const source of [
    ["require", "(path.join(root, moduleName));"].join(''),
    ["const load = ", "require", "; load('pg');"].join(''),
    ["const load = module.", "require.bind(module); load('pg');"].join(''),
    ["module['", "require", "']('pg');"].join(''),
    ["const load = globalThis.", "require; load('pg');"].join('')
  ]) assert.notDeepEqual(findServiceDatabaseAccess(source), [], source);

  const approved = 'tests/unit/core/word-review-source.test.cjs';
  const fakeAdapter = ["require", "(path.join(root,'storage/database.js')); const store = new PgStore(fakePool);"].join('');
  assert.deepEqual(findServiceDatabaseAccess(fakeAdapter, approved), []);
  assert.notDeepEqual(findServiceDatabaseAccess(fakeAdapter, 'tests/unit/core/other.test.cjs'), []);
});

test('Core safety loader is accepted only with a fixed list of literal Core targets', () => {
  const file = 'tests/unit/core/safety.test.cjs';
  const reviewed = ["const load=(m)=>require", "(path.join(root,m+'.js'));\n",
    "const {OrderService}=load('core/service');"].join('');
  assert.deepEqual(findServiceDatabaseAccess(reviewed, file), []);
  const changed = reviewed.replace("load('core/service')", 'load(process.env.MODULE)');
  assert.notDeepEqual(findServiceDatabaseAccess(changed, file), []);
});

test('UI SSR React require helper is accepted only for its reviewed files and packages', () => {
  const file = 'tests/ui/pdf-review-panel.test.ts';
  const reviewed = [
    "import { createRequire } from 'node:module';\nconst fromWeb = ",
    'createRequire',
    "(new URL('../../web/package.json', import.meta.url));\nconst React = fromWeb('react');\n",
    "const { renderToStaticMarkup } = fromWeb('react-dom/server');"
  ].join('');
  assert.deepEqual(findServiceDatabaseAccess(reviewed, file), []);
  assert.notDeepEqual(findServiceDatabaseAccess(reviewed, 'tests/ui/other.test.ts'), []);
  assert.notDeepEqual(findServiceDatabaseAccess(
    reviewed.replace("fromWeb('react')", "fromWeb('pg')"), file), []);
  assert.notDeepEqual(findServiceDatabaseAccess(
    reviewed.replace("new URL('../../web/package.json'", "new URL(process.env.MODULE"), file), []);
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

test('SQLite fixture roots cannot be shadowed by enumerated loop variables', () => {
  const sources = [
    `
def test_bad_path(tmp_path):
    for tmp_path in ("/tmp",):
        path = Path(tmp_path) / "journal.sqlite"
        sqlite3.connect(path)
`,
    `
with tempfile.TemporaryDirectory() as folder:
    for folder in ("/var/lib",):
        path = Path(folder) / "journal.sqlite"
        sqlite3.connect(path)
`
  ];
  for (const source of sources) {
    assert.notDeepEqual(findUnsafeSqliteUse(source, 'tests/unit/printing/test_agent.py', new Set([
      'tests/unit/printing/test_agent.py'
    ])), []);
  }
});

test('a loop before a temporary alias assignment does not invalidate the later path', () => {
  const source = `
for path in ("/tmp",):
    pass
def test_journal(tmp_path):
    path = tmp_path / "journal.sqlite"
    sqlite3.connect(path)
`;
  assert.deepEqual(findUnsafeSqliteUse(source, 'tests/unit/printing/test_agent.py', new Set([
    'tests/unit/printing/test_agent.py'
  ])), []);

  const shadowed = `
def test_journal(tmp_path):
    path = tmp_path / "journal.sqlite"
    for path in ("/tmp",):
        sqlite3.connect(path)
`;
  assert.notDeepEqual(findUnsafeSqliteUse(shadowed, 'tests/unit/printing/test_agent.py', new Set([
    'tests/unit/printing/test_agent.py'
  ])), []);
});

test('SQLite fixture roots and aliases cannot be changed with augmented assignment', () => {
  const rootMutation = `
def test_bad_path(tmp_path):
    tmp_path /= "outside"
    path = tmp_path / "journal.sqlite"
    sqlite3.connect(path)
`;
  const aliasMutation = `
def test_bad_path(tmp_path):
    path = tmp_path / "journal.sqlite"
    path /= "../outside.sqlite"
    sqlite3.connect(path)
`;
  const floorDivisionRootMutation = `
def test_bad_path(tmp_path):
    tmp_path //= "outside"
    path = tmp_path / "journal.sqlite"
    sqlite3.connect(path)
`;
  const exponentAliasMutation = `
def test_bad_path(tmp_path):
    path = tmp_path / "journal.sqlite"
    path **= 2
    sqlite3.connect(path)
`;
  for (const source of [rootMutation, aliasMutation, floorDivisionRootMutation, exponentAliasMutation]) {
    assert.notDeepEqual(findUnsafeSqliteUse(source, 'tests/unit/printing/test_agent.py', new Set([
      'tests/unit/printing/test_agent.py'
    ])), []);
  }
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

test('workflow inventory includes the guard policy test and keeps test directories visible', () => {
  const workflow = `
steps:
  - name: Guard policy
    run: node --test scripts/ai0-v1-nodb-ci-policy.test.mjs
  - name: Python tests
    run: >-
      python -m pytest -q
      tests/unit/printing
`;
  assert.deepEqual(extractWorkflowTestPaths(workflow, []), [
    'scripts/ai0-v1-nodb-ci-policy.test.mjs', 'tests/unit/printing'
  ]);
  assert.throws(() => assertExactWorkflowTestPaths(
    extractWorkflowTestPaths(workflow, []),
    ['scripts/ai0-v1-nodb-ci-policy.test.mjs', 'tests/unit/printing/test_agent.py']
  ), /extra: tests\/unit\/printing/);
});

test('workflow inventory fails closed for an unrecognized test runner', () => {
  const workflow = `
steps:
  - name: Custom tests
    run: python scripts/run-tests.py tests/unit/unreviewed
`;
  assert.throws(() => extractWorkflowTestPaths(workflow, []), /unrecognized runner/);
  assert.deepEqual(extractWorkflowTestPaths(`
steps:
  - name: Compile test sources
    run: python -m compileall -q tests/unit
`, []), []);
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
