// AI5 strict PR88 acceptance: TESTS ONLY, no live Zalo or printing.
import {spawnSync,execFileSync} from 'node:child_process';
import {resolve,dirname} from 'node:path';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const PRODUCT='3093de9d17d5455690474dcb3d66addf7f49bb1f';
const mode=process.argv[2];
const fail=(code,why)=>{console.error('AI5 PR88 '+code+': '+why);process.exit(code==='NOT RUN'?2:1)};
if(!['--pg','--browser'].includes(mode))fail('FAIL','specify --pg or --browser');
const git=(...args)=>execFileSync('git',args,{cwd:ROOT,encoding:'utf8'}).trim();
const head=git('rev-parse','HEAD'),parent=git('rev-parse','HEAD^');
if(parent!==PRODUCT)fail('FAIL','must checkout AI5 one-commit overlay directly on product '+PRODUCT+', parent='+parent);
const changed=git('diff','--name-only',PRODUCT,head).split('\n').filter(Boolean);
if(!changed.length||changed.some(x=>!x.startsWith('tests/acceptance/')&&!x.startsWith('docs/acceptance/')))
  fail('FAIL','scope violation '+changed.join(','));
if(mode==='--browser'){
  if(!existsSync(resolve(ROOT,'web/package.json'))||!existsSync(resolve(ROOT,'web/package-lock.json'))||
    !existsSync(resolve(ROOT,'tests/ui/code008-chromium.py')))
    fail('NOT RUN','PR88 product HEAD '+PRODUCT+' contains no web/ or Chromium harness; cannot test desktop/mobile on exact SHA; do not reuse PR85 results');
  fail('NOT RUN','browser harness on this tree not validated for independent PR88 runner');
}
const urls=['DATABASE_URL','TEST_DATABASE_URL','AUTOIN_TEST_DATABASE_URL'].map(k=>process.env[k]);
if(process.env.AUTOIN_ALLOW_PG_ACCEPTANCE!=='YES_ISOLATED_TEST_DB'||
    urls.some(x=>!x||x!==urls[0]))fail('FAIL','all three isolated PG URLs + explicit permit required');
const u=new URL(urls[0]);
if(!['localhost','127.0.0.1','[::1]'].includes(u.hostname)||
 !/^\/(?:autoin_test|auto_in_test)(?:_[a-z0-9]+)?$/i.test(u.pathname))
 fail('FAIL','only localhost disposable autoin_test PostgreSQL permitted');
const env={...process.env,FORCE_COLOR:'0'};
delete env.NODE_TEST_CONTEXT;
const run=spawnSync(process.execPath,['--import','tsx','--test','--test-reporter=tap',
  'tests/acceptance/pr88-official-manual-pg.test.mjs'],{
  cwd:ROOT,env,encoding:'utf8',maxBuffer:12*1024*1024,timeout:240000
});
const output=(run.stdout||'')+'\n'+(run.stderr||'');
process.stdout.write(output);
if(run.error||run.status!==0)fail('FAIL','runner test exit='+run.status+', error='+(run.error?.message||'none')+
  '; exact product='+PRODUCT+' overlay='+head+'; retain every failing assertion');
const get=k=>{const m=[...output.matchAll(new RegExp('^# '+k+' (\\d+)\\s*$','gm'))];
 return m.length===1?Number(m[0][1]):null};
const n=get('tests'),passed=get('pass'),failed=get('fail'),skipped=get('skipped'),
 cancelled=get('cancelled'),todo=get('todo');
if(n!==4||passed!==4||failed!==0||skipped!==0||cancelled!==0||todo!==0)
 fail('FAIL','strict TAP mismatch '+JSON.stringify({n,passed,failed,skipped,cancelled,todo}));
console.log('AI5 PR88 PASS 4/4 independent PG/Fastify synthetic suites; product='+PRODUCT+' overlay='+head);
console.log('CHROMIUM=NOT RUN on PR88 without web; REAL_OA/RICOH/WINDOWS/IPHONE/TN037=NOT RUN');
