import {spawnSync} from 'node:child_process';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {assertLocalSimulationUrl} from './local-http-guard.mjs';
import {requireIntegratedSha,requireIsolatedPgEnv} from './integration-preflight.mjs';
const integration=process.argv.includes('--integration'),http=process.argv.includes('--http'),browser=process.argv.includes('--browser');
if(integration){
 try{requireIsolatedPgEnv();}
 catch(e){console.error('BLOCKED exit2: '+e.message);process.exit(2)}
 if(process.env.AUTOIN_ACCEPTANCE_ADAPTER){
  console.error('CODE-205 uses only tests/acceptance/product-adapter.mjs; external adapter cannot silently replace it');process.exit(2);
 }
}
if(http||browser){
 try{requireIntegratedSha();assertLocalSimulationUrl(http?process.env.AUTOIN_API_URL:process.env.AUTOIN_WEB_URL)}
 catch(e){console.error('BLOCKED exit2: '+e.message);process.exit(2)}
}
const dir=dirname(fileURLToPath(import.meta.url));
const names=['verify.test.mjs','fixtures.test.mjs','metrics.test.mjs','release-gate.test.mjs',
 'security.test.mjs','local-http-guard.test.mjs','integration-preflight.test.mjs','product-adapter.test.mjs','product-205.test.mjs'];
if(http)names.push('http-readiness.test.mjs','http-auth.test.mjs');
if(browser)names.push('browser.test.mjs');
const env={...process.env};
if(integration)env.AUTOIN_RUN_PRODUCT_ACCEPTANCE='1';else delete env.AUTOIN_RUN_PRODUCT_ACCEPTANCE;
// Old CODE-105 Port tests are not the real CODE-205 adapter: skip explicitly.
delete env.AUTOIN_RUN_LEGACY_P0;
if(http)env.AUTOIN_RUN_HTTP_ACCEPTANCE='1';else delete env.AUTOIN_RUN_HTTP_ACCEPTANCE;
if(!browser)delete env.AUTOIN_WEB_URL;
const r=spawnSync(process.execPath,['--test',...names.map(n=>resolve(dir,n))],{stdio:'inherit',env});
console.log('CODE-205 PG/DRYRUN: '+(integration?'REQUESTED':'NOT RUN'));
console.log('HTTP: '+(http?'REQUESTED on local integrated simulation':'NOT RUN'));
console.log('BROWSER: '+(browser?'REQUESTED Chromium only':'NOT RUN'));
console.log('LEGACY CODE-105 PORT CASES: SKIPPED; no product evidence');
console.log('REAL OA/RICOH/IPHONE, 100/DAY, 210/7 DAYS: NOT RUN');
process.exit(r.status??2);
