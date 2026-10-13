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
const enabled=process.env.AUTOIN_RUN_PRODUCT_ACCEPTANCE==='1';
const programs=[
 ['C402-WORKER REAL AI2 dual workers, persisted postback, challenge, lost ACK, wrong scope, stale receipt',
  'tests/unit/zalo/confirmation-candidates-pg.test.mjs'],
 ['C402-NORMALIZER signed synthetic postback strict structure, forged text not promoted',
  'tests/unit/zalo/structured-postback.test.mjs'],
 ['C401-AI1 verified-port replay after staff approval, old revision/quote and no unapproved auto print',
  'tests/integration/core/verified-confirmation-pg.test.cjs'],
 ['C402-AI0 real Fastify+PostgreSQL verified resolver and structured candidate stays unconfirmed',
  'tests/integration/composition/confirmation-candidate-pg.test.mjs']
];
for(const [name,relativePath] of programs)test(name,{
 skip:enabled?false:'NOT RUN: real isolated PostgreSQL and exact integrated SHA --integration required',
 timeout:180000
},()=>{
 requireIsolatedPgEnv();requireExactCode405Checkout(process.env.AUTOIN_INTEGRATION_SHA);
 const url=process.env.AUTOIN_TEST_DATABASE_URL;assertSafeDatabase(url);
 if(process.env.TEST_DATABASE_URL&&process.env.TEST_DATABASE_URL!==url)
  throw Error('AI5 CODE402 inconsistent isolated DB URLs');
 const result=spawnSync(process.execPath,['--import','tsx','--test','--test-reporter=tap',resolve(root,relativePath)],{
  cwd:root,encoding:'utf8',maxBuffer:5*1024*1024,timeout:160000,
  env:isolatedTestChildEnv({AUTOIN_TEST_DATABASE_URL:url,TEST_DATABASE_URL:url,FORCE_COLOR:'0'})
 });
 const evidence=(result.stdout??'')+'\n'+(result.stderr??'');
 assert.equal(result.error,undefined,'AI5 CODE402 test could not start: '+relativePath);
 assert.equal(result.status,0,'AI5 CODE402 real PRODUCT failed: '+relativePath+'\n'+evidence.slice(-16000));
 const counts=assertVerifiedTapSummary(evidence,relativePath);
 assert.ok(counts.tests>0 && counts.pass===counts.tests,'Empty/not-executed test suite cannot pass');
});
