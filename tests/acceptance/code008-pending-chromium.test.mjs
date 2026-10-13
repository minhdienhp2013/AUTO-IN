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
test('C008 Chromium 14 pending_updates status+viewport cases on authenticated Fastify/PG', {
 skip:process.env.AUTOIN_RUN_CODE008_PENDING_CHROMIUM==='1'?
  false:'NOT RUN: AI0 must enable separate Chromium status acceptance after web lockfile/build',
 timeout:300000
},()=>{
 requireIsolatedPgEnv();requireExactCode405Checkout(process.env.AUTOIN_INTEGRATION_SHA);
 requireAi4Build(root);assertSafeDatabase(process.env.AUTOIN_TEST_DATABASE_URL);
 if(process.env.TEST_DATABASE_URL&&process.env.TEST_DATABASE_URL!==process.env.AUTOIN_TEST_DATABASE_URL)
  throw Error('CODE008 browser PG URLs differ');
 const r=spawnSync(process.execPath,['--import','tsx','tests/acceptance/code008-pending-chromium.mjs'],{
  cwd:root,encoding:'utf8',timeout:290000,maxBuffer:5*1024*1024,
  env:{...process.env,TEST_DATABASE_URL:process.env.AUTOIN_TEST_DATABASE_URL,
   AUTOIN_OPERATION_MODE:'simulation',FORCE_COLOR:'0'}
 });
 assert.equal(r.error,undefined,'Cannot run real Chromium pending acceptance');
 // Collect BOTH child stdout/stderr; Python prints START/PASS to stdout and
 // exact failed assertion/step/original traceback to stderr. Never replace
 // the cause with a generic "AssertionError" or just an exit code.
 const evidence=(r.stdout??'')+'\n'+(r.stderr??'');
 assert.equal(r.status,0,'CODE008 Chromium status E2E failed; original child logs:\n'+evidence.slice(-16000));
 for(const line of (r.stdout??'').split('\n')){
  if(line.startsWith('PASS CODE008 Chromium '))console.log(line);
 }
 for(const viewport of ['1440x900','390x844']){
  for(const status of ['clear','processing0','needs_human0','processing2','needs_human1','stale_hash','missing']){
   assert.ok((r.stdout||'').includes('PASS CODE008 Chromium '+viewport+' pending_updates='+status),
    'Required status/viewport not observed: '+viewport+' '+status);
  }
 }
});
