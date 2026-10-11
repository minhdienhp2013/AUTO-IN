import {spawnSync} from 'node:child_process';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const integration=process.argv.includes('--integration');
if(integration&&!process.env.AUTOIN_ACCEPTANCE_ADAPTER){
 console.error('BLOCKED (exit 2): missing product adapter / PostgreSQL / DryRunDriver. NOT RUN');process.exit(2);
}
const folder=dirname(fileURLToPath(import.meta.url));
const names=['verify.test.mjs','fixtures.test.mjs','metrics.test.mjs','release-gate.test.mjs','security.test.mjs'];
if(process.env.AUTOIN_WEB_URL)names.push('browser.test.mjs');
const r=spawnSync(process.execPath,['--test',...names.map(n=>resolve(folder,n))],{stdio:'inherit'});
console.log(integration?'PRODUCT INTEGRATION REQUESTED; verify actual adapter evidence (OA/Ricoh/iPhone NOT RUN)':'SELFTEST ONLY; PRODUCT INTEGRATION NOT RUN; NOT TN-037');
process.exit(r.status??2);
