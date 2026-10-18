import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';

test('TN008 WebKit runner parses on Python (not WebKit execution)',()=>{
  const source=resolve('..','tests','ui','tn008-webkit-notifications.py');
  const check=spawnSync('python3',['-c',
    'import ast,sys;ast.parse(open(sys.argv[1],encoding="utf-8").read())',source],
    {encoding:'utf8',timeout:15000});
  assert.equal(check.error,undefined,String(check.error));
  assert.equal(check.status,0,check.stderr);
});
