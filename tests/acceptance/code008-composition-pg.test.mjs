import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {assertSafeDatabase} from './product-adapter.mjs';
import {requireIsolatedPgEnv} from './integration-preflight.mjs';
import {requireExactCode405Checkout} from './code405-exact-sha.mjs';
import {assertVerifiedTapSummary,isolatedTestChildEnv} from './code405-subprocess-evidence.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const cases=[
 ['C008-CI-01 signed multi-batch (>60s)/stale postapproval HELD/one-order test','zalo-artifact-worker-pg.test.mjs'],
 ['C008-CI-02 received_at pending-file blocks direct SQL approval even if occurred_at future','preapproval-pending-pg.test.mjs']
];
for(const [label,filename] of cases)test(label,{
 skip:process.env.AUTOIN_RUN_PRODUCT_ACCEPTANCE==='1'?false:
 'CODE008 exact-SHA product composition NOT RUN without real isolated PostgreSQL',timeout:180000
},()=>{
 requireIsolatedPgEnv();
 requireExactCode405Checkout(process.env.AUTOIN_INTEGRATION_SHA);
 const url=process.env.AUTOIN_TEST_DATABASE_URL;
 assertSafeDatabase(url);
 if(process.env.TEST_DATABASE_URL&&process.env.TEST_DATABASE_URL!==url)
  throw Error('CODE008 TEST_DATABASE_URL does not match isolated database');
 const filepath=resolve(root,'tests/integration/composition',filename);
 const r=spawnSync(process.execPath,['--import','tsx','--test','--test-reporter=tap',filepath],{
  cwd:root,encoding:'utf8',timeout:150000,maxBuffer:4*1024*1024,
  env:isolatedTestChildEnv({TEST_DATABASE_URL:url,FORCE_COLOR:'0'})
 });
 const output=(r.stdout||'')+'\n'+(r.stderr||'');
 assert.equal(r.error,undefined,'CODE008 real product test spawn failed');
 assert.equal(r.status,0,'CODE008 integrated product test failed: '+filename+'\n'+output.slice(-2200));
 const actual=assertVerifiedTapSummary(output,'CODE008 '+filename);
 assert.ok(actual.tests>0&&actual.pass===actual.tests,'No fake success or all-skipped product suites');
});
