const databaseModules = new Set([
  'pg', 'pg-pool', 'pg-promise', 'postgres', 'postgresql', 'mysql', 'mysql2', 'mariadb',
  'sqlite', 'sqlite3', 'better-sqlite3', 'node:sqlite', 'libsql', '@libsql/client',
  'knex', 'sequelize', 'typeorm', 'drizzle-orm', 'prisma', '@prisma/client',
  'mongodb', 'mongoose', 'redis', 'ioredis', '@upstash/redis', '@upstash/postgres',
  '@vercel/postgres', '@neondatabase/serverless', '@planetscale/database',
  '@supabase/supabase-js'
]);

function packageName(specifier) {
  if (specifier.startsWith('@')) return specifier.split('/').slice(0, 2).join('/');
  return specifier.split('/')[0];
}

const fakePoolAdapterFiles = new Set([
  'tests/unit/core/controlled-test-grant.test.cjs',
  'tests/unit/core/pdf-review-source.test.cjs',
  'tests/unit/core/tn005-sealed-outbox.test.cjs',
  'tests/unit/core/word-review-source.test.cjs'
]);

const reviewedWebReactRequireFiles = new Set([
  'tests/ui/pdf-review-panel.test.ts',
  'tests/ui/pilot-shop-code.test.ts',
  'tests/ui/word-review-panel.test.ts'
]);

function callArgument(source, openParen) {
  let depth = 1;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = openParen + 1; index < source.length; index++) {
    const char = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') { blockComment = false; index++; }
      continue;
    }
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (char === '\\') { escaped = true; continue; }
      if (char === quote) quote = '';
      continue;
    }
    if (char === '/' && next === '/') { lineComment = true; index++; continue; }
    if (char === '/' && next === '*') { blockComment = true; index++; continue; }
    if (char === "'" || char === '"' || char === '`') { quote = char; continue; }
    if (char === '(') depth++;
    if (char === ')' && --depth === 0) return source.slice(openParen + 1, index).trim();
  }
  return null;
}

function allowedFixedLocalRequire(argument, file) {
  const match = argument.match(/^path\s*\.\s*join\s*\(\s*root\s*,\s*(['"])([^'"]+)\1\s*\)$/);
  if (!match) return false;
  const requestedPath = match[2];
  if (requestedPath.split('/').includes('..') || requestedPath.startsWith('/')) return false;
  if (/^(?:core|api|jobs)\/[A-Za-z0-9._/-]+\.js$/.test(requestedPath)) return true;
  return requestedPath === 'storage/database.js' && fakePoolAdapterFiles.has(file);
}

function removeReviewedCoreLoadHelper(source, file, findings) {
  if (file !== 'tests/unit/core/safety.test.cjs') return source;
  const helper = /^\s*const\s+load\s*=\s*\(\s*m\s*\)\s*=>\s*require\s*\(\s*path\s*\.\s*join\s*\(\s*root\s*,\s*m\s*\+\s*(['"])\.js\1\s*\)\s*\)\s*;?\s*$/gm;
  const helpers = [...source.matchAll(helper)];
  if (helpers.length !== 1) {
    findings.add('unreviewed computed module loader');
    return source;
  }
  let reviewedSource = source.replace(helper, '');
  const calls = [...reviewedSource.matchAll(/\bload\s*\(([^)]*)\)/g)];
  if (!calls.length) findings.add('computed module loader has no reviewed literal targets');
  for (const call of calls) {
    const target = call[1].trim().match(/^(['"])(core\/[A-Za-z0-9._/-]+)\1$/);
    if (!target || target[2].split('/').includes('..')) findings.add('computed module loader target is not a fixed Core module');
  }
  return reviewedSource.replace(/\bload\s*\(([^)]*)\)/g, '');
}

function removeReviewedWebReactRequire(source, file, findings) {
  if (!reviewedWebReactRequireFiles.has(file)) return source;
  const importPattern = /^import\s*\{\s*createRequire\s*\}\s*from\s*(['"])node:module\1\s*;?\s*$/gm;
  const helperPattern = /^\s*const\s+fromWeb\s*=\s*createRequire\s*\(\s*new\s+URL\s*\(\s*(['"])\.\.\/\.\.\/web\/package\.json\1\s*,\s*import\.meta\.url\s*\)\s*\)\s*;?\s*$/gm;
  const imports = [...source.matchAll(importPattern)];
  const helpers = [...source.matchAll(helperPattern)];
  if (imports.length !== 1 || helpers.length !== 1) {
    findings.add('unreviewed computed module loader');
    return source;
  }

  let reviewedSource = source.replace(importPattern, '').replace(helperPattern, '');
  const calls = [...reviewedSource.matchAll(/\bfromWeb\s*\(([^)]*)\)/g)];
  if (!calls.length) findings.add('React module loader has no reviewed literal targets');
  for (const call of calls) {
    const target = call[1].trim().match(/^(['"])(react|react-dom\/server)\1$/);
    if (!target) findings.add('React module loader target is not an approved package');
  }
  reviewedSource = reviewedSource.replace(/\bfromWeb\s*\(([^)]*)\)/g, '');
  if (/\bfromWeb\b|\bcreateRequire\s*\(/.test(reviewedSource))
    findings.add('unreviewed computed module loader');
  return reviewedSource;
}

function addImportFindings(source, findings, file) {
  source = removeReviewedCoreLoadHelper(source, file, findings);
  source = removeReviewedWebReactRequire(source, file, findings);
  const pythonSource = file.endsWith('.py');
  const literalImports = /\b(?:from\s*|import\s*|(?:module\s*\.\s*)?require\s*(?:\?\.)?\s*\(\s*)(['"])([^'"]+)\1/g;
  for (const match of source.matchAll(literalImports)) {
    if (databaseModules.has(packageName(match[2]))) findings.add(`database module ${match[2]}`);
  }

  if (pythonSource) {
    const pythonImports = /^\s*(?:from\s+([A-Za-z_][\w.]*)\s+import\b|import\s+([A-Za-z_][\w.]*(?:\s+as\s+[A-Za-z_]\w*)?(?:\s*,\s*[A-Za-z_][\w.]*(?:\s+as\s+[A-Za-z_]\w*)?)*))/gm;
    const normalizedSource = source.replace(/\\\r?\n[ \t]*/g, ' ');
    for (const match of normalizedSource.matchAll(pythonImports)) {
      const modules = match[1] ? [match[1]] : match[2].split(',').map(item => item.trim().split(/\s+as\s+/)[0]);
      for (const module of modules) {
        const name = module.split('.')[0];
        if (databaseModules.has(name) && !['sqlite', 'sqlite3'].includes(name))
          findings.add(`database module ${module}`);
      }
    }
  }

  // Dynamic import can resolve to any package or file at runtime, so the
  // no-DB pilot rejects it even when its current argument looks harmless.
  if (pythonSource ? /\b(?:importlib\b|__import__\s*\(|\bexec\s*\(|\beval\s*\(|runpy\s*\.)/.test(source) : /\bimport\s*\(/.test(source))
    findings.add('dynamic import');
  if (!pythonSource && (/\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(?:(?:[A-Za-z_$][\w$]*\s*\.\s*){0,2})require\b(?!\s*\()/.test(source) ||
      /\b(?:module|global|globalThis|process(?:\s*\.\s*mainModule)?)\s*\[\s*['"]require['"]\s*\]/.test(source) ||
      /\bcreateRequire\s*\(|\b(?:eval|Function)\s*\(/.test(source)))
    findings.add('aliased or computed module loader');

  if (pythonSource) return;
  const requires = /\b(?:module\s*\.\s*)?require\s*(?:\?\.)?\s*\(/g;
  for (const match of source.matchAll(requires)) {
    const openParen = source.indexOf('(', match.index);
    const argument = callArgument(source, openParen);
    if (argument === null) { findings.add('unclosed require call'); continue; }
    if (/^(['"])[^'"]+\1$/.test(argument)) continue;
    if (allowedFixedLocalRequire(argument, file)) continue;
    findings.add('dynamic require');
  }
}

/** Return static evidence that source imports or constructs a service DB client. */
export function findServiceDatabaseAccess(source, file = '') {
  const findings = new Set();
  addImportFindings(source, findings, file);

  if (/\b(?:DATABASE_URL|TEST_DATABASE_URL|AUTOIN_TEST_DATABASE_URL|DB_URL|PGHOST|PGPORT|PGUSER|PGPASSWORD|PGDATABASE|POSTGRES_(?:HOST|PORT|USER|PASSWORD|DB|DATABASE|URL)|MYSQL_(?:HOST|PORT|USER|PASSWORD|DATABASE|URL))\b/i.test(source))
    findings.add('service-database environment setting');
  if (/\b(?:postgres(?:ql)?|mysql|mariadb|mongodb|redis):\/\//i.test(source))
    findings.add('service-database URL');
  if (/\b(?:psycopg2?|asyncpg|pg8000|sqlalchemy|create_engine|MongoClient)\b/i.test(source))
    findings.add('service-database client symbol');
  if (/\bnew\s+(?:[A-Za-z_$][\w$]*\s*(?:\.\s*(?:Pool|Client|PrismaClient|Sequelize|MongoClient|Redis|Knex|DataSource)|\[\s*['"](?:Pool|Client|PrismaClient|Sequelize|MongoClient|Redis|Knex|DataSource)['"]\s*\])|(?:Pool|Client|PrismaClient|Sequelize|MongoClient|Redis|Knex|DataSource))\s*\(/.test(source) ||
      /\bnew\s+(?:Pool|Client|PrismaClient|Sequelize|MongoClient|Redis|Knex|DataSource)\s*\(/.test(source))
    findings.add('database client constructor');

  return [...findings];
}

function loopTargetNames(source) {
  const names = new Set();
  const loops = /\bfor\s+([A-Za-z_$][\w$]*(?:\s*,\s*[A-Za-z_$][\w$]*)*|\([^)]*\))\s+in\b/g;
  for (const match of source.matchAll(loops)) {
    for (const name of match[1].match(/[A-Za-z_$][\w$]*/g) ?? []) names.add(name);
  }
  return names;
}

function loopTargetOccurrences(source) {
  const occurrences = new Map();
  const loops = /\bfor\s+([A-Za-z_$][\w$]*(?:\s*,\s*[A-Za-z_$][\w$]*)*|\([^)]*\))\s+in\b/g;
  for (const match of source.matchAll(loops)) {
    for (const name of match[1].match(/[A-Za-z_$][\w$]*/g) ?? []) {
      const indices = occurrences.get(name) ?? [];
      indices.push(match.index);
      occurrences.set(name, indices);
    }
  }
  return occurrences;
}

function tempRootNames(source) {
  const roots = new Set();
  const loopTargets = loopTargetNames(source);
  const functionParameters = /\bdef\s+([A-Za-z_][\w]*)\s*\(([^)]*)\)/g;
  for (const match of source.matchAll(functionParameters)) {
    const parameters = match[2].split(',').map(parameter => parameter.trim().split('=')[0].trim());
    if (match[1].startsWith('test_') && parameters.includes('tmp_path')) roots.add('tmp_path');
  }
  const folderBinding = /(?:\btempfile\.)?TemporaryDirectory\s*\([^)]*\)\s+as\s+([A-Za-z_$][\w$]*)/g;
  for (const match of source.matchAll(folderBinding)) roots.add(match[1]);
  for (const name of [...roots]) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rebinding = new RegExp(`^\\s*${escaped}\\s*(?:\\*\\*=|//=|=|[+\\-*/%&|^]=|:=)`, 'm');
    if (loopTargets.has(name) || rebinding.test(source)) roots.delete(name);
  }
  return roots;
}

function safeEnumeratedLoopVariables(source) {
  const variables = new Set();
  const loops = /\bfor\s+([A-Za-z_$][\w$]*)\s*(?:,\s*[A-Za-z_$][\w$]*)?\s+in\s+(\[[^\]]*\]|\([^)]*\))\s*:/g;
  for (const match of source.matchAll(loops)) {
    const remainder = match[2].replace(/(['"])(?:\\.|(?!\1)[^\\])*?\1/g, '');
    if (/^[\s\[\](),]*$/.test(remainder)) variables.add(match[1]);
  }
  return variables;
}

function tempPathExpression(expression, roots, safePathNames, safeVariables = new Set()) {
  expression = expression.replace(/#.*$/, '').trim();
  if (!expression || /\b(?:if|else|and|or|not)\b|\.parent\b|\.\.\//.test(expression) ||
      /(['"])\.\.\1/.test(expression) || /(['"])[^'"]*[/\\][^'"]*\1/.test(expression) ||
      expression.includes('\\') || expression.includes(';')) return false;
  const rootNames = [...roots, ...safePathNames]
    .sort((a, b) => b.length - a.length)
    .map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!rootNames.length) return false;
  const root = `(?:${rootNames.join('|')})`;
  const parenthesized = String.raw`\((?:[^()\n]|\([^()\n]*\)|str\(len\([A-Za-z_$][\w$]*\)\))*\)`;
  const segment = String.raw`(?:['"][^/'"\\]+['"]|${parenthesized}|str\(len\([A-Za-z_$][\w$]*\)\))`;
  const suffix = String.raw`(?:\s*\/\s*${segment})*`;
  const rooted = String.raw`(?:\b${root}\b|Path\s*\(\s*\b${root}\b\s*\))`;
  const direct = new RegExp(String.raw`^\s*(?:str\s*\(\s*)?${rooted}${suffix}\s*\)?\s*$`);
  const joined = new RegExp(String.raw`^\s*os\.path\.join\s*\(\s*${rooted}\s*,\s*['"][^/'"]+['"](?:\s*,\s*['"][^/'"]+['"])*\s*\)\s*$`);
  const dynamicSource = expression
    .replace(new RegExp(String.raw`Path\s*\(\s*\b${root}\b\s*\)`, 'g'), '')
    .replace(/str\s*\(\s*len\s*\(\s*[A-Za-z_$][\w$]*\s*\)\s*\)/g, '');
  const dynamicSegments = [...dynamicSource.matchAll(/\(([^()\n]+)\)/g)].map(match => match[1]);
  for (const dynamic of dynamicSegments) {
    if (/^\s*len\([A-Za-z_$][\w$]*\)\s*$/.test(dynamic)) continue;
    const identifiers = dynamic.replace(/(['"])(?:\\.|(?!\1)[^\\])*?\1/g, '').match(/[A-Za-z_$][\w$]*/g) ?? [];
    if (identifiers.some(identifier => !safeVariables.has(identifier))) return false;
  }
  return direct.test(expression) || joined.test(expression);
}

function hasRootedSqlitePathOnLine(line, roots, safePaths, safeVariables) {
  const names = [...roots, ...safePaths]
    .sort((a, b) => b.length - a.length)
    .map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!names.length) return false;
  const root = `(?:${names.join('|')})`;
  const rooted = String.raw`(?:\b${root}\b|Path\s*\(\s*\b${root}\b\s*\))`;
  const parenthesized = String.raw`\((?:[^()\n]|\([^()\n]*\)|str\(len\([A-Za-z_$][\w$]*\)\))*\)`;
  const segment = String.raw`(?:['"][^/'"\\]+['"]|${parenthesized}|str\(len\([A-Za-z_$][\w$]*\)\))`;
  const suffix = String.raw`(?:\s*\/\s*${segment})*`;
  const candidates = new RegExp(`${rooted}${suffix}`, 'g');
  const cleanLine = line.replace(/#.*$/, '');
  const matches = [...cleanLine.matchAll(candidates)].filter(match =>
    /\.sqlite(?:3)?\b|sqlite:\/\//i.test(match[0]) &&
    tempPathExpression(match[0], roots, safePaths, safeVariables));
  const sqliteCount = [...cleanLine.matchAll(/\.sqlite(?:3)?\b|sqlite:\/\//ig)].length;
  return sqliteCount > 0 && matches.length === sqliteCount;
}

function safeTemporarySqlitePaths(source) {
  source = source.replace(/\r\n/g, '\n');
  const roots = tempRootNames(source);
  const loopOccurrences = loopTargetOccurrences(source);
  const safeVariables = safeEnumeratedLoopVariables(source);
  const safePaths = new Set();
  const lines = source.split(/\r?\n/);
  let offset = 0;
  const assignments = lines.flatMap(line => {
    const lineOffset = offset;
    offset += line.length + 1;
    const assignment = line.match(/^\s*(?:self\.)?([A-Za-z_$][\w$]*)\s*=\s*(.+)$/);
    return assignment ? [[assignment[1], assignment[2], lineOffset]] : [];
  });
  const mutatedPaths = new Set();
  for (const [name, indices] of loopOccurrences) {
    if (indices.some(index => assignments.some(([assignedName, , assignmentIndex]) =>
      assignedName === name && assignmentIndex < index))) mutatedPaths.add(name);
  }
  for (const line of lines) {
    const mutation = line.match(/^\s*(?:self\.)?([A-Za-z_$][\w$]*)\s*(?:\*\*=|\/\/=|[+\-*\/%&|^]=|:=)/);
    if (mutation) mutatedPaths.add(mutation[1]);
  }

  // A path alias is safe only when every assignment to it stays rooted in a
  // pytest temporary fixture or TemporaryDirectory. An unsafe reassignment
  // or mutation invalidates the alias instead of inheriting an earlier safe value.
  for (let pass = 0; pass < lines.length; pass++) {
    let changed = false;
    for (const name of new Set(assignments.map(([assignedName]) => assignedName))) {
      if (mutatedPaths.has(name)) continue;
      const expressions = assignments.filter(([assignedName]) => assignedName === name).map(([, expression]) => expression);
      if (expressions.every(expression => tempPathExpression(expression, roots, safePaths, safeVariables)) && !safePaths.has(name)) {
        safePaths.add(name);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const findings = [];
  lines.forEach((line, index) => {
    const sqliteMatches = [...line.matchAll(/\.sqlite(?:3)?\b|sqlite:\/\//ig)];
    if (sqliteMatches.length && !hasRootedSqlitePathOnLine(line, roots, safePaths, safeVariables))
      findings.push(`SQLite path is not visibly rooted in a temporary fixture at line ${index + 1}`);

    const opener = /\b(?:sqlite3?|sqlite)\.connect\s*\(/ig;
    for (const match of line.matchAll(opener)) {
      const argument = callArgument(line, line.indexOf('(', match.index));
      if (argument !== "':memory:'" && argument !== '":memory:"' &&
          !tempPathExpression(argument, roots, safePaths, safeVariables) && !safePaths.has(argument))
        findings.push(`SQLite connection path is not proven temporary at line ${index + 1}`);
    }

    const journal = /\b(?:PilotJournal|Journal)\s*\(/ig;
    for (const match of line.matchAll(journal)) {
      const argument = callArgument(line, line.indexOf('(', match.index));
      if (argument && !tempPathExpression(argument, roots, safePaths, safeVariables) && !safePaths.has(argument))
        findings.push(`journal path is not proven temporary at line ${index + 1}`);
    }
  });
  return findings;
}

/** Check SQLite references in a Python test are approved temporary fixtures. */
export function findUnsafeSqliteUse(source, file, approvedFiles) {
  if (!/\bsqlite3?\b|\.sqlite(?:3)?\b|sqlite:\/\//i.test(source)) return [];
  if (!approvedFiles.has(file)) return [`SQLite use is not approved in ${file}`];
  return safeTemporarySqlitePaths(source).map(finding => `${file}: ${finding}`);
}

/** Extract only test paths in YAML run steps, expanding the approved Core glob. */
export function extractWorkflowTestPaths(workflow, coreFiles) {
  const lines = workflow.split(/\r?\n/);
  const runBodies = [];
  for (let index = 0; index < lines.length; index++) {
    const run = lines[index].match(/^(\s+)run:\s*(.*)$/);
    if (!run) continue;
    const stepIndent = Math.max(0, run[1].length - 2);
    const first = run[2].trim();
    const body = [];
    if (first && !/^(?:\||\|-|>|>-)$/.test(first)) body.push(first);
    while (index + 1 < lines.length && !new RegExp(`^\\s{${stepIndent}}-\\s`).test(lines[index + 1])) {
      index++;
      body.push(lines[index]);
    }
    runBodies.push(body.join('\n'));
  }

  const paths = [];
  for (const body of runBodies) {
    const testRunner = /\bnode\b[^\n]*\s--test\b|\bnpm\b[^\n]*\b(?:run\s+)?test(?:[:\w-]+)?\b|\b(?:pnpm|yarn)\b[^\n]*\b(?:run\s+)?test(?:[:\w-]+)?\b|\b(?:python(?:\d+(?:\.\d+)?)?\s+-m\s+)?pytest\b|\bplaywright\s+test\b/;
    const testPaths = [...body.matchAll(/\b(?:tests|scripts)\/[A-Za-z0-9_./*-]+/g)]
      .map(match => match[0].replace(/[),;]+$/, ''));
    if (!testRunner.test(body)) {
      if (/\bpython(?:\d+(?:\.\d+)?)?\s+-m\s+compileall\b/.test(body)) continue;
      const unrecognized = testPaths.filter(path => path.startsWith('tests/') ||
        /(?:^|[./_-])(?:test|tests)(?:[./_-]|$)/i.test(path));
      if (unrecognized.length)
        throw new Error(`test paths use an unrecognized runner: ${unrecognized.join(', ')}`);
      continue;
    }
    for (const path of testPaths) {
      if (path === 'tests/unit/core/*.test.cjs') paths.push(...coreFiles);
      else if (path.includes('*')) throw new Error(`unsupported workflow test glob: ${path}`);
      else paths.push(path);
    }
  }
  return paths;
}

export function assertExactWorkflowTestPaths(actualPaths, expectedPaths) {
  const actual = [...actualPaths].sort();
  const expected = [...expectedPaths].sort();
  const duplicates = actual.filter((path, index) => index > 0 && path === actual[index - 1]);
  const missing = expected.filter(path => !actual.includes(path));
  const extra = actual.filter(path => !expected.includes(path));
  if (duplicates.length || missing.length || extra.length) {
    throw new Error([
      'workflow test paths differ from the reviewed allowlist',
      duplicates.length ? `duplicate: ${[...new Set(duplicates)].join(', ')}` : '',
      missing.length ? `missing: ${missing.join(', ')}` : '',
      extra.length ? `extra: ${extra.join(', ')}` : ''
    ].filter(Boolean).join('; '));
  }
}
