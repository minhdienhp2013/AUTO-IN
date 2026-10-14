// AI5: independent exact-product CODE-008/401/402/403 acceptance driver.
// Does NOT create fake consent, send Zalo messages, deploy or print.
// PG and browser modes are independent; missing prerequisites always FAIL.
import {spawnSync,execFileSync} from 'node:child_process';
import {readFileSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const PRODUCT='a3dfac7fa2335694067e6d61f4c6045ad1d43a2d';
const mode=process.argv[2];
const fail=(why)=>{console.error('AI5 FAIL/BLOCKED '+why);process.exit(1)};
if(!['--pg','--browser'].includes(mode))fail('Required --pg or --browser');
const git=(...args)=>execFileSync('git',args,{cwd:ROOT,encoding:'utf8'}).trim();
const overlay=git('rev-parse','HEAD');
if(git('rev-parse','HEAD^')!==PRODUCT)fail('Overlay parent must be exact product '+PRODUCT);
const files=git('diff','--name-only',PRODUCT,overlay).split('\n').filter(Boolean);
if(!files.length||files.some(p=>!p.startsWith('tests/acceptance/')&&!p.startsWith('docs/acceptance/')))
 fail('Overlay contains unauthorized product/workflow changes: '+files.join(','));
const env={...process.env,FORCE_COLOR:'0',AI1_BUILD_DIR:resolve(ROOT,'dist/backend')};
delete env.NODE_TEST_CONTEXT;
const child=(label,argv,settings={})=>{
 const result=spawnSync(argv[0],argv.slice(1),{
  cwd:settings.cwd??ROOT,env,encoding:'utf8',
  maxBuffer:8*1024*1024,timeout:settings.timeout??180000
 });
 const output=(result.stdout??'')+'\n'+(result.stderr??'');
 if(result.error||result.status!==0){
  console.error('FAIL '+label+' exit='+result.status+' error='+(result.error?.message??'none'));
  console.error(output.slice(-22000));
  process.exit(1);
 }
 return output;
};
function requirePg(){
 if(process.env.AUTOIN_ALLOW_PG_ACCEPTANCE!=='YES_ISOLATED_TEST_DB')fail('Explicit isolated PG permit missing');
 const a=process.env.TEST_DATABASE_URL,b=process.env.AUTOIN_TEST_DATABASE_URL,c=process.env.DATABASE_URL;
 if(!a||a!==b||a!==c)fail('All 3 DB URLs must resolve to exactly same isolated PostgreSQL');
 const u=new URL(a);
 if(!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||
   !/^\/(?:autoin_test|auto_in_test)[A-Za-z0-9_-]*$/.test(u.pathname))
   fail('Only isolated PostgreSQL localhost test database allowed');
 if(!existsSync(resolve(ROOT,'dist/backend/core/service.js')))
   fail('Compiled Core missing; require npm run check before acceptance');
}
function parseTap(label,output){
 const get=kind=>{
  const matches=[...output.matchAll(new RegExp('^# '+kind+' (\\d+)\\s*$','gm'))];
  return matches.length===1?Number(matches[0][1]):null;
 };
 const counts={tests:get('tests'),pass:get('pass'),fail:get('fail'),skipped:get('skipped'),
  cancelled:get('cancelled'),todo:get('todo')};
 if(!(counts.tests>0) || counts.pass!==counts.tests||counts.fail!==0||
    counts.skipped!==0||counts.cancelled!==0||counts.todo!==0){
  console.error('FAIL '+label+' invalid TAP '+JSON.stringify(counts));
  console.error(output.slice(-20000));
  process.exit(1);
 }
 console.log('PASS AI5 '+label+' '+counts.pass+'/'+counts.tests+' (FAIL=0 SKIP=0)');
 return counts.pass;
}
const suites=[
 ['C008 same order_id pending/supplement and 0 print','tests/integration/core/active-order-supplement-pg.test.cjs',false],
 ['C008 pending_updates scope/revision/hash and HTTP409','tests/integration/core/pending-updates-pg.test.cjs',false],
 ['C008 quarantine/approval race both lock orders','tests/integration/core/official-quarantine-approval-pg.test.cjs',false],
 ['C401 verified challenge/replay 2 pool','tests/integration/core/verified-confirmation-pg.test.cjs',false],
 ['C402 candidate not customer confirmation','tests/integration/composition/confirmation-candidate-pg.test.mjs',true],
 ['C402 official inbound human review HTTP409','tests/integration/composition/official-zalo-quarantine-pg.test.mjs',true],
 ['C402 dual worker lost ACK no forged consent','tests/unit/zalo/confirmation-candidates-pg.test.mjs',true],
 ['C403 HTTPS evidence, DryRun 0 on tamper/UNKNOWN/lost ACK','tests/integration/composition/https-agent-product-pg.test.mjs',true]
];
if(mode==='--pg'){
 requirePg();
 let total=0;
 for(const [label,relative,tsx] of suites){
  const command=[process.execPath];
  if(tsx)command.push('--import','tsx');
  command.push('--test','--test-reporter=tap',resolve(ROOT,relative));
  total+=parseTap(label,child(label,command,{timeout:240000}));
 }
 const py=child('C403 isolated Python DryRun evidence',[
  'python3','-m','pytest','-q',
  'tests/unit/documents/test_evidence_guard_403.py',
  'tests/unit/printing/test_https_evidence_gate_403.py'
 ],{timeout:240000});
 const summary=py.match(/(\d+) passed(?:,\s*(\d+) skipped)?/);
 if(!summary||Number(summary[1])<1||Number(summary[2]??0)!==0)
  fail('AI5 Python DryRun PASS not proven or SKIP present '+py.slice(-9000));
 console.log('PASS AI5 C403 Python '+summary[1]+' tests; FAIL=0 SKIP=0');
 console.log('AI5 PG + Fastify HTTP synthetic suites total='+total+
 ' Python='+summary[1]+'; product='+PRODUCT+' overlay='+overlay);
 console.log('CHROMIUM=NOT RUN in --pg; live OA/Ricoh/physical iPhone/TN037=NOT RUN');
}else{
 const script=readFileSync(resolve(ROOT,'tests/ui/code008-chromium.py'),'utf8');
 for(const required of ['api-error','api-lock-banner','code008-blocked',
  "assert calls['mutation'] == 0","approve.is_disabled()","'CHƯA XÁC ĐỊNH'"]){
  if(!script.includes(required))fail('AI4 missing required source check '+required);
 }
 if(!existsSync(resolve(ROOT,'web/dist/index.html')))fail('Real web production build missing');
 const browserOutput=child('AI5 independent Chromium 28',[
  'python3','tests/ui/code008-chromium.py'
 ],{timeout:240000});
 const expected=['clear','processing0','needs_human0','processing2','needs_human1',
  'stale_order','stale_revision','stale_hash','missing','bad_count',
  'api401','api409','api503','offline'];
 const log=[...browserOutput.matchAll(/^PASS CODE008 SYNTHETIC Chromium (\d+)x(\d+) scenario=([a-z0-9_]+) GET_detail=(\d+) mutation=0\s*$/gm)];
 const actual=new Set(log.map(m=>m[1]+'x'+m[2]+':'+m[3]));
 if(log.length!==28||actual.size!==28)fail('Chromium duplicated/missing markers '+log.length+'/'+actual.size+
  '\n'+browserOutput.slice(-11000));
 for(const viewport of ['1440x900','390x844']){
  for(const scenario of expected)
   if(!actual.has(viewport+':'+scenario))fail('Missing desktop/mobile case '+viewport+':'+scenario);
 }
 if(!browserOutput.includes('PASS CODE008 SYNTHETIC Chromium 28 scenario-viewport cases'))
  fail('Chromium suite lacked terminal completion marker');
 console.log('PASS AI5 Chromium 28/28, independent direct execution (synthetic API fixtures ONLY)');
 console.log('PG/Fastify=NOT RUN in --browser; live OA/Ricoh/physical iPhone/TN037=NOT RUN');
}
