// AI5 only: explicit standalone execution on a *clean* PR66 validation overlay.
// GitHub PR66 workflows DO NOT auto-invoke tests/acceptance/, so merely green
// product CI is never counted as execution of this file.
import {spawnSync,execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {existsSync} from 'node:fs';

const product='c942c4e13333764972c5ff550306a8059e68d5ca';
const root=resolve(import.meta.dirname,'../..');
function halt(message){console.error('AI5 BLOCKED: '+message);process.exit(2)}
if(process.env.AUTOIN_ALLOW_PG_ACCEPTANCE!=='YES_ISOLATED_TEST_DB')
 halt('real isolated PG explicit permit missing');
const url=process.env.TEST_DATABASE_URL,secondary=process.env.AUTOIN_TEST_DATABASE_URL;
if(!url||!secondary||url!==secondary)
 halt('TEST_DATABASE_URL and AUTOIN_TEST_DATABASE_URL must point to same isolated PostgreSQL');
const u=new URL(url);
if(!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||
  !/^\/(?:autoin_test|auto_in_test)[A-Za-z0-9_-]*$/.test(u.pathname))
 halt('URL must be a locally isolated test database');
const cur=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
const parent=execFileSync('git',['rev-parse','HEAD^'],{cwd:root,encoding:'utf8'}).trim();
if(parent!==product)halt('overlay must have EXACT product HEAD as sole direct parent, got '+parent);
if(!existsSync(resolve(root,'dist/backend/core/service.js')))
 halt('product not compiled; run npm run check before AI5 acceptance');
if(!existsSync(resolve(root,'tests/acceptance/code402-pr66-pg.test.mjs')))
 halt('AI5 acceptance file missing from overlay');

const cases=[
 ['AI5 independent signed OA quarantine, owner followup/ack, migration order, HTTP409, inbound-first',
  'tests/acceptance/code402-pr66-pg.test.mjs'],
 ['AI1 independent real two-PG-pool scope races: inbound-first AND approval-first',
  'tests/integration/core/official-quarantine-approval-pg.test.cjs'],
 ['AI0 Fastify signed ingress and owner-approved reconciliation',
  'tests/integration/composition/official-zalo-quarantine-pg.test.mjs'],
 ['AI2 real two-PG-pool unified verified ingress, replay, scope and no false consent',
  'tests/unit/zalo/official-unified-pg.test.mjs']
];
const env={...process.env,AI1_BUILD_DIR:resolve(root,'dist/backend'),
 AUTOIN_INTEGRATION_SHA:cur,FORCE_COLOR:'0'};
delete env.NODE_TEST_CONTEXT;
for(const [label,path] of cases){
 const run=spawnSync(process.execPath,
  ['--import','tsx','--test','--test-reporter=tap',resolve(root,path)],{
   cwd:root,env,encoding:'utf8',timeout:180000,maxBuffer:6*1024*1024
  });
 const evidence=(run.stdout??'')+'\n'+(run.stderr??'');
 const find=name=>{
  const found=evidence.match(new RegExp('^# '+name+' (\\d+)\\s*$','m'));
  return found?Number(found[1]):null;
 };
 const tests=find('tests'),pass=find('pass'),fail=find('fail'),
  skip=find('skipped'),todo=find('todo'),cancel=find('cancelled');
 if(run.error||run.status!==0||!tests||pass!==tests||fail!==0||skip!==0||todo!==0||cancel!==0){
  console.error('FAIL '+label+' status='+run.status+
   ' counts='+JSON.stringify({tests,pass,fail,skip,todo,cancel}));
  console.error(evidence.slice(-17000));
  process.exit(1);
 }
 console.log('PASS '+label+' '+pass+'/'+tests+'; 0 FAIL/SKIP, product='+product+' overlay='+cur);
}
console.log('AI5 CODE402 ISOLATED REAL PG ACCEPTANCE SUCCESS');
console.log('HTTP: exercised via real Fastify inject and PostgreSQL transactions in the suites above.');
console.log('CHROMIUM: NOT RUN; PR66 does not include web/ or browser workflow.');
console.log('REAL OA/RICOH/WINDOWS/IPHONE/TN037: NOT RUN; OA route remains disabled.');
