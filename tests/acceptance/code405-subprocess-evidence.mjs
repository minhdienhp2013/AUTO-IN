import assert from 'node:assert/strict';

/**
 * CODE-405: a product child process is admissible evidence ONLY when its
 * explicit Node TAP report proves a nonempty test suite with zero failures,
 * skips, cancellations and todos. Never infer PASS from process exit=0 alone.
 *
 * Call subprocesses with --test-reporter=tap; Node 24 otherwise prints
 * "ℹ tests N" / "✔" (spec) and old regexes silently saw null counters.
 */
export function assertVerifiedTapSummary(output,label) {
  assert.equal(typeof output,'string','TAP product output must be text');
  assert.ok(output.length > 0,'TAP product output must not be empty');
  const totals={};
  const fields=new Set(['tests','pass','fail','skipped','cancelled','todo']);
  for(const line of output.split(/\r?\n/)) {
    // Only the TOP-LEVEL summary counts; ignore indented nested subtests.
    const match=/^# (tests|pass|fail|skipped|cancelled|todo) (\d+)\s*$/.exec(line);
    if(match)totals[match[1]]=Number(match[2]);
  }
  for(const field of fields) {
    assert.ok(Object.hasOwn(totals,field),
      'CODE405: TAP summary missing '+field+' for '+label+
      '; child must be started with --test-reporter=tap');
    assert.ok(Number.isSafeInteger(totals[field]),
      'CODE405: invalid TAP '+field+' for '+label);
  }
  assert.ok(totals.tests > 0,'CODE405: no product tests executed: '+label);
  assert.equal(totals.fail,0,'CODE405: product test failures: '+label);
  assert.equal(totals.skipped,0,'CODE405: product test SKIP is NOT PASS: '+label);
  assert.equal(totals.cancelled,0,'CODE405: cancelled product tests: '+label);
  assert.equal(totals.todo,0,'CODE405: TODO product tests: '+label);
  assert.equal(totals.pass,totals.tests,
    'CODE405: product tests not all PASS: '+label);
  return totals;
}
