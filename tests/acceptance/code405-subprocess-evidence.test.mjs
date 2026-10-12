import test from 'node:test';
import assert from 'node:assert/strict';
import {assertVerifiedTapSummary} from './code405-subprocess-evidence.mjs';

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
