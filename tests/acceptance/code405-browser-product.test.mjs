import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {assertSafeDatabase} from './product-adapter.mjs';
import {requireIsolatedPgEnv} from './integration-preflight.mjs';
import {requireExactCode405Checkout} from './code405-exact-sha.mjs';
import {requireAi4Build} from './browser-build-guard.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
test('C405-CHROMIUM real integrated Fastify/PG desktop+mobile; no unauthorized approval or print',{
 skip:process.env.AUTOIN_RUN_CODE405_BROWSER_PRODUCT==='1'
  ?false:'CODE405 browser product NOT RUN: requires --browser-product and real AI4 build',
 timeout:180000
},()=>{
 requireIsolatedPgEnv();requireExactCode405Checkout(process.env.AUTOIN_INTEGRATION_SHA);
 requireAi4Build(root);assertSafeDatabase(process.env.AUTOIN_TEST_DATABASE_URL);
 const url=process.env.AUTOIN_TEST_DATABASE_URL;
 if(process.env.TEST_DATABASE_URL && process.env.TEST_DATABASE_URL!==url)
  throw Error('CODE405 product browser PostgreSQL URL mismatch');
 const r=spawnSync(process.execPath,['--import','tsx','scripts/browser-product.mjs'],{
  cwd:root,encoding:'utf8',timeout:160000,maxBuffer:6*1024*1024,
  env:{...process.env,TEST_DATABASE_URL:url,AUTOIN_OPERATION_MODE:'simulation',FORCE_COLOR:'0'}
 });
 const output=(r.stdout??'')+'\n'+(r.stderr??'');
 assert.equal(r.error,undefined,'Cannot start actual Chromium/Fastify/PG product test');
 assert.equal(r.status,0,'Real Chromium product FAIL: '+output.slice(-1700));
 for(const marker of [
  'PASS REAL Chromium PRODUCT 1440x900',
  'PASS REAL Chromium PRODUCT 390x844',
  'PASS real Fastify/PostgreSQL browser UI',
  'PASS real browser rejected tampered PNG on desktop and mobile'
 ]) assert.ok(output.includes(marker),'Missing independently checked real-browser evidence: '+marker);
 assert.doesNotMatch(output,/REAL_CHROMIUM_SKIPPED|E2E_NOT_RUN/);
});
