import test from 'node:test';import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';import {existsSync} from 'node:fs';
import {dirname,resolve} from 'node:path';import {fileURLToPath} from 'node:url';
import {assertSafeDatabase} from './product-adapter.mjs';
import {requireIsolatedPgEnv} from './integration-preflight.mjs';
import {requireExactCode405Checkout} from './code405-exact-sha.mjs';
import {assertVerifiedTapSummary} from './code405-subprocess-evidence.mjs';
const active=process.env.AUTOIN_RUN_PRODUCT_ACCEPTANCE==='1';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const cases=[
 ['C405-HTTP-PG signed wrong-OA, invalid signature and duplicate', 'zalo-http-pg.test.mjs'],
 ['C405-CANDIDATE signed OK is NOT customer consent; wrong scope/stale/HUMAN fail closed', 'confirmation-candidate-pg.test.mjs'],
 ['C405-AI2/AI3 signed image, worker replay, source tamper -> HUMAN', 'zalo-artifact-worker-pg.test.mjs'],
 ['C405-PLAN trusted staff draft, real AI3 preview source/PNG tamper', 'inbound-draft-pg.test.mjs'],
 ['C405-ACK owner reconciliation after lost AI1 response', 'inbound-reconcile-pg.test.mjs'],
 ['C405-AGENT HTTPS localhost DryRun UNKNOWN no physical printing', 'https-agent-product-pg.test.mjs']
];
for(const [label,name] of cases)test(label,{
 skip:active?false:'CODE405 composition NOT RUN: isolated PG + --integration required',timeout:180000
},()=>{
 requireIsolatedPgEnv();requireExactCode405Checkout(process.env.AUTOIN_INTEGRATION_SHA);
 const url=process.env.AUTOIN_TEST_DATABASE_URL;assertSafeDatabase(url);
 if(process.env.TEST_DATABASE_URL && process.env.TEST_DATABASE_URL!==url)throw Error('CODE405: PG test URLs differ');
 const filepath=resolve(root,'tests/integration/composition',name);
 assert.equal(existsSync(filepath),true,'Required AI0 product test missing: '+name);
 const r=spawnSync(process.execPath,['--import','tsx','--test','--test-reporter=tap',filepath],{
  cwd:root,encoding:'utf8',timeout:150000,maxBuffer:4*1024*1024,
  env:{...process.env,TEST_DATABASE_URL:url,FORCE_COLOR:'0'}
 });
 const output=(r.stdout??'')+'\n'+(r.stderr??'');
 assert.equal(r.error,undefined,'CODE405 real product test failed to start');
 assert.equal(r.status,0,'CODE405 product FAIL '+name+': '+output.slice(-1400));
 const totals=assertVerifiedTapSummary(output,name);
 assert.ok(totals.tests>=1,'CODE405 must execute real tests for '+name);

});
