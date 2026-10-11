import {spawnSync} from 'node:child_process';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const integrated=process.argv.includes('--integration');
if(integrated&&!process.env.AUTOIN_ACCEPTANCE_ADAPTER){
 console.error('BLOCKED: Product adapter/PostgreSQL/DryRunDriver missing; NOT RUN');process.exit(2);
}
const dir=dirname(fileURLToPath(import.meta.url));
const run=spawnSync(process.execPath,['--test',resolve(dir,'verify.test.mjs')],{stdio:'inherit'});
console.log(integrated?'INTEGRATION harness only; OA/Ricoh/iPhone and 7-day gates NOT RUN':'FIXTURE SELFTEST only; PRODUCT TESTS NOT RUN');
process.exit(run.status??2);
