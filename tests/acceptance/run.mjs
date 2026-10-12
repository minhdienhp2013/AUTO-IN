import {spawnSync} from 'node:child_process';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {assertLocalSimulationUrl} from './local-http-guard.mjs';
import {requireIntegratedSha,requireIsolatedPgEnv} from './integration-preflight.mjs';
import {requireAi4Build} from './browser-build-guard.mjs';
const integration=process.argv.includes('--integration'),http=process.argv.includes('--http'),browser=process.argv.includes('--browser'),productBrowser=process.argv.includes('--browser-product');
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
if(productBrowser){try{requireIsolatedPgEnv();requireAi4Build(resolve(dir,'../..'))}catch(e){console.error('BLOCKED exit2: '+e.message);process.exit(2)}}
if(browser){try{requireAi4Build(resolve(dir,'../..'))}catch(e){console.error('BLOCKED exit2: '+e.message);process.exit(2)}}
const names=['verify.test.mjs','fixtures.test.mjs','metrics.test.mjs','release-gate.test.mjs',
 'security.test.mjs','local-http-guard.test.mjs','integration-preflight.test.mjs','browser-build-guard.test.mjs','https-agent-fixture.test.mjs','code405-exact-sha.test.mjs','code405-subprocess-evidence.test.mjs','product-adapter.test.mjs','code405-confirmation-pg.test.mjs','code405-composition-pg.test.mjs','code008-one-order-pg.test.mjs','code008-composition-pg.test.mjs','product-205.test.mjs','integrated-webhook.test.mjs'];
if(http)names.push('http-readiness.test.mjs','http-auth.test.mjs','http-webhook.test.mjs');
if(browser)names.push('browser.test.mjs');
if(productBrowser)names.push('code405-browser-product.test.mjs');
const env={...process.env};
if(integration)env.AUTOIN_RUN_PRODUCT_ACCEPTANCE='1';else delete env.AUTOIN_RUN_PRODUCT_ACCEPTANCE;
// Old CODE-105 Port tests are not the real CODE-205 adapter: skip explicitly.
delete env.AUTOIN_RUN_LEGACY_P0;
if(http)env.AUTOIN_RUN_HTTP_ACCEPTANCE='1';else delete env.AUTOIN_RUN_HTTP_ACCEPTANCE;
if(!browser)delete env.AUTOIN_WEB_URL;
if(productBrowser)env.AUTOIN_RUN_CODE405_BROWSER_PRODUCT='1';else delete env.AUTOIN_RUN_CODE405_BROWSER_PRODUCT;
// Product-backed CODE-008 tests import AI0/AI1/AI2 .ts modules. The root project
// already pins tsx; without it nested Node v24 fails to import Core .js specifiers.
// Real isolated PostgreSQL integration tests run serially: independent AI5
// fixture DDL / migration probes can deadlock if Node runs test files in
// parallel. Serial execution preserves ALL mandatory RED/PASS assertions.
const r=spawnSync(process.execPath,['--import','tsx','--test',...(integration?['--test-concurrency=1']:[]),...names.map(n=>resolve(dir,n))],{stdio:'inherit',env});
console.log('CODE-205 PG/DRYRUN: '+(integration?'REQUESTED':'NOT RUN'));
console.log('HTTP: '+(http?'REQUESTED on local integrated simulation':'NOT RUN'));
console.log('BROWSER: '+(browser?'REQUESTED Chromium only':'NOT RUN'));
console.log('PRODUCT CHROMIUM+PG: '+(productBrowser?'REQUESTED on isolated Fastify/Pg build':'NOT RUN'));
console.log('LEGACY CODE-105 PORT CASES: SKIPPED; no product evidence');
console.log('REAL OA/RICOH/IPHONE, 100/DAY, 210/7 DAYS: NOT RUN');
process.exit(r.status??2);
