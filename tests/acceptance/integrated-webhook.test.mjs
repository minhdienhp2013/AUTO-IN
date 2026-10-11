import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {assertSafeDatabase} from './product-adapter.mjs';
import {requireIsolatedPgEnv} from './integration-preflight.mjs';
const enabled=process.env.AUTOIN_RUN_PRODUCT_ACCEPTANCE==='1';
test('HTTP-PG-ZALO-02: synthetic raw Fastify webhook writes/dedupes real PostgreSQL',{
 skip:enabled?false:'NOT RUN: integration PostgreSQL must be enabled'
},()=>{
 requireIsolatedPgEnv();
 const url=process.env.AUTOIN_TEST_DATABASE_URL;
 assertSafeDatabase(url);
 if(process.env.TEST_DATABASE_URL && process.env.TEST_DATABASE_URL!==url)
  throw Error('TEST_DATABASE_URL differs from isolated AUTOIN_TEST_DATABASE_URL');
 const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
 const path=resolve(root,'tests/integration/composition/zalo-http-pg.test.mjs');
 assert.equal(existsSync(path),true,'Missing AI0 synthetic raw webhook composition test');
 const r=spawnSync(process.execPath,['--import','tsx','--test',path],{
  cwd:root,encoding:'utf8',timeout:120000,maxBuffer:3*1024*1024,
  env:{...process.env,TEST_DATABASE_URL:url,FORCE_COLOR:'0'}
 });
 const output=(r.stdout||'')+'\n'+(r.stderr||'');
 assert.equal(r.error,undefined,'Child synthetic webhook test could not start');
 assert.equal(r.status,0,'Synthetic webhook composition failed: '+output.slice(-1200));
 const values={};
 for(const kind of ['tests','pass','fail','skipped']){
  const matches=[...output.matchAll(new RegExp('^\\s*(?:#|ℹ)\\s*'+kind+'\\s+(\\d+)\\s*$','gm'))];
  values[kind]=matches.length?Number(matches.at(-1)[1]):null;
 }
 assert.deepEqual(values,{tests:1,pass:1,fail:0,skipped:0},
   'No skipped Fastify -> real PG webhook test may be treated as PASS');
});
