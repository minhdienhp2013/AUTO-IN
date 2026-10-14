// AI5 CODE-403: run only on one-commit overlay directly on AI0 PR76.
// Hard failure on fake PASS, PG SKIP, wrong checkout, or non-local database.
// No real OA, printer, spooler, Windows driver or production execution.
import {spawnSync,execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const product='0ee0a74892576cf38dcce539889ad017e27be26b';
const fail=message=>{console.error('AI5 CODE403 BLOCKED: '+message);process.exit(2)};
const actual=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
const parents=execFileSync('git',['rev-list','--parents','-n','1','HEAD'],{
 cwd:root,encoding:'utf8'}).trim().split(/\s+/);
if(parents.length!==2||parents[1]!==product)
 fail('Must checkout EXACT direct-child validation overlay of '+product+
  ', actual='+actual+' parents='+JSON.stringify(parents));
if(process.env.AUTOIN_ALLOW_PG_ACCEPTANCE!=='YES_ISOLATED_TEST_DB')
 fail('Explicit isolated PostgreSQL permission absent');
const db=process.env.TEST_DATABASE_URL, other=process.env.AUTOIN_TEST_DATABASE_URL;
if(!db || db!==other || db!==process.env.DATABASE_URL)
 fail('DATABASE_URL, TEST_DATABASE_URL and AUTOIN_TEST_DATABASE_URL MUST MATCH');
const url=new URL(db);
if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||
 !/^\/(?:autoin_test|auto_in_test)[a-zA-Z0-9_-]*$/.test(url.pathname)||
 url.username.length===0||url.password.length===0)
 fail('Real isolated localhost PostgreSQL database credentials required');
if(!existsSync(resolve(root,'dist/backend/core/service.js')))
 fail('Real product TS compilation missing; execute npm run check first');

const env={...process.env,FORCE_COLOR:'0',PYTHONNOUSERSITE:'1',
 AI1_BUILD_DIR:resolve(root,'dist/backend')};
const productTest=spawnSync(process.execPath,
 ['--import','tsx','--test','--test-reporter=tap',
  resolve(root,'tests/acceptance/code403-https-product-pg.test.mjs')],{
  cwd:root,env,encoding:'utf8',maxBuffer:8*1024*1024,timeout:360000
 });
const stdout=(productTest.stdout??'')+'\n'+(productTest.stderr??'');
const count=name=>{
 const found=stdout.match(new RegExp('^# '+name+' (\\d+)\\s*$','m'));
 return found?Number(found[1]):null;
};
const counts=Object.fromEntries(['tests','pass','fail','skipped','cancelled','todo']
 .map(name=>[name,count(name)]));
if(productTest.error||productTest.status!==0||!counts.tests||
 counts.pass!==counts.tests||counts.fail!==0||counts.skipped!==0||
 counts.cancelled!==0||counts.todo!==0){
 console.error('FAIL CODE403 REAL PostgreSQL+HTTPS / Python DryRun: '+JSON.stringify(counts));
 console.error(stdout.slice(-20000));
 process.exit(1);
}
console.log('PASS AI5 CODE403 real PostgreSQL/HTTPS: '+counts.pass+' tests; 0 FAIL/SKIP');
const python=spawnSync('python3',['-m','pytest','-q',
 'tests/unit/printing/test_evidence_gate_403.py',
 'tests/unit/printing/test_https_evidence_gate_403.py'],{
 cwd:root,env,encoding:'utf8',maxBuffer:5*1024*1024,timeout:180000
});
const output=(python.stdout??'')+'\n'+(python.stderr??'');
const passed=output.match(/(\d+)\s+passed(?:\s+in|\s*,)/);
if(python.error||python.status!==0||!passed||Number(passed[1])===0||
 /(\d+)\s+(?:failed|skipped|xfailed|xpassed)/.test(output)){
 console.error('FAIL CODE403 exact AI3 Python driver/evidence tests');
 console.error(output.slice(-17000));
 process.exit(1);
}
console.log('PASS AI5 exact AI3 Pytest evidence/driver: '+passed[1]+
 ' PASS / 0 FAIL / 0 SKIP');
console.log('AI5 CODE403 DONE synthetic PG/HTTPS/DryRun only; overlay='+actual);
console.log('LIVE WINDOWS/RICOH/OA/PHYSICAL IPHONE/TN037: NOT RUN');
