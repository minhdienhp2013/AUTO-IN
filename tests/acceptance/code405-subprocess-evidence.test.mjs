import test from 'node:test';
import assert from 'node:assert/strict';
import {assertVerifiedTapSummary,isolatedTestChildEnv} from './code405-subprocess-evidence.mjs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const tap=({tests=1,pass=tests,fail=0,skipped=0,cancelled=0,todo=0}={})=>[
 'TAP version 13',
 'ok 1 - real Fastify/PostgreSQL suite',
 '# tests '+tests,'# suites 0','# pass '+pass,
 '# fail '+fail,'# cancelled '+cancelled,
 '# skipped '+skipped,'# todo '+todo
].join('\n')+'\n';

test('CODE405 parser accepts a valid TAP 1/1 PASS',()=>{
 assert.equal(assertVerifiedTapSummary(tap(),'synthetic parser selftest').pass,1);
});
test('CODE405 parser accepts actual multiple product subtests, not hardcoded one',()=>{
 assert.deepEqual(assertVerifiedTapSummary(tap({tests:6,pass:6}),'multiple'),{
   tests:6,pass:6,fail:0,cancelled:0,skipped:0,todo:0
 });
});
test('CODE405 parser rejects Node 24 spec output instead of treating it as PASS',()=>{
 assert.throws(()=>assertVerifiedTapSummary('✔ test name\nℹ tests 1\nℹ pass 1\nℹ fail 0\n','spec'),/TAP summary missing/);
});
test('CODE405 parser rejects empty output and zero product tests',()=>{
 assert.throws(()=>assertVerifiedTapSummary('','empty'),/must not be empty/);
 assert.throws(()=>assertVerifiedTapSummary(tap({tests:0,pass:0}),'zero'),/no product tests executed/);
});
test('CODE405 parser rejects FAIL, SKIP, cancellation and TODO independently',()=>{
 for(const fields of [
  {tests:2,pass:1,fail:1},{tests:2,pass:1,skipped:1},
  {tests:2,pass:1,cancelled:1},{tests:2,pass:1,todo:1},
  {tests:2,pass:1}
 ])assert.throws(()=>assertVerifiedTapSummary(tap(fields),'negative'));
});
test('CODE405 parser requires all six TAP counters (no handwaving partial output)',()=>{
 assert.throws(()=>assertVerifiedTapSummary('# tests 1\n# pass 1\n# fail 0\n','partial'),/TAP summary missing/);
});

test('CODE405 nested test worker removes inherited NODE_TEST_CONTEXT without dropping SHA/PG proof',()=>{
  const clean=isolatedTestChildEnv({TEST_DATABASE_URL:'postgresql://fixture/local-test'},
    {NODE_TEST_CONTEXT:'child-v8',AUTOIN_INTEGRATION_SHA:'a'.repeat(40)});
  assert.equal(Object.hasOwn(clean,'NODE_TEST_CONTEXT'),false);
  assert.equal(clean.AUTOIN_INTEGRATION_SHA,'a'.repeat(40));
  assert.equal(clean.TEST_DATABASE_URL,'postgresql://fixture/local-test');
});

test('CODE405 launches REAL nested node:test suite and reads TAP, not exit 0 from recursive skip',()=>{
  const target=fileURLToPath(new URL('./code405-exact-sha.test.mjs',import.meta.url));
  const child=spawnSync(process.execPath,['--test','--test-reporter=tap',target],{
    cwd:process.cwd(),encoding:'utf8',timeout:15000,
    env:isolatedTestChildEnv({FORCE_COLOR:'0'})
  });
  assert.equal(child.error,undefined,'Nested test process must start');
  assert.equal(child.status,0,'Nested test child exited nonzero: '+child.stderr);
  const summary=assertVerifiedTapSummary(child.stdout,'nested process proof');
  assert.ok(summary.tests>=3,'Must actually execute CODE405 provenance cases');
});
