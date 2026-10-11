import {spawnSync} from 'node:child_process';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {assertLocalSimulationUrl} from './local-http-guard.mjs';
const integration=process.argv.includes('--integration'),http=process.argv.includes('--http'),browser=process.argv.includes('--browser');
if(integration&&(!process.env.AUTOIN_ACCEPTANCE_ADAPTER||!process.env.AUTOIN_TEST_DATABASE_URL)){
 console.error('BLOCKED (exit 2): requires product-backed adapter, PostgreSQL and DryRunDriver');process.exit(2);
}
if(http||browser){
 try {assertLocalSimulationUrl(http?process.env.AUTOIN_API_URL:process.env.AUTOIN_WEB_URL);}
 catch(e){console.error('BLOCKED (exit 2): '+e.message);process.exit(2);}
}
const dir=dirname(fileURLToPath(import.meta.url));
const names=['verify.test.mjs','fixtures.test.mjs','metrics.test.mjs','release-gate.test.mjs','security.test.mjs','local-http-guard.test.mjs'];
if(http)names.push('http-auth.test.mjs');
if(browser)names.push('browser.test.mjs');
const env={...process.env};
if(integration)env.AUTOIN_RUN_PRODUCT_ACCEPTANCE='1';else delete env.AUTOIN_RUN_PRODUCT_ACCEPTANCE;
if(http)env.AUTOIN_RUN_HTTP_ACCEPTANCE='1';else delete env.AUTOIN_RUN_HTTP_ACCEPTANCE;
if(!browser)delete env.AUTOIN_WEB_URL;
const r=spawnSync(process.execPath,['--test',...names.map(n=>resolve(dir,n))],{stdio:'inherit',env});
console.log(integration?'PRODUCT INTEGRATION REQUESTED — validate 2 PostgreSQL connections, dry-run only':'FIXTURE/HARNESS SELFTEST ONLY — PRODUCT INTEGRATION NOT RUN');
console.log(http?'HTTP ANONYMOUS AUTH TEST REQUESTED':'HTTP AUTH TEST NOT RUN');
console.log(browser?'DESKTOP CHROMIUM MOBILE VIEWPORT (NOT REAL IPHONE)':'BROWSER TEST NOT RUN');
console.log('REAL OA/RICOH/IPHONE, 100 DAILY ORDERS, 210/7-DAY ACCEPTANCE: NOT RUN');
process.exit(r.status??2);
