import {execFileSync} from 'node:child_process';

const branch='ai0/v1-word-pdf-dryrun-integration-20261021';
const expectedParent='321f9235e204e27d25e1e3b3927ad48659632147';
const expectedDatabase='autoin_test_pilotwordpdf';

function git(args){
 return execFileSync('git',args,{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
}

function fail(code){
 console.error(`PILOT_TARGETED_CI_GUARD_FAILED:${code}`);
 process.exit(1);
}

try{
 const head=git(['rev-parse','HEAD']);
 const parents=git(['show','-s','--format=%P','HEAD']).split(/\s+/).filter(Boolean);
 const parent=git(['rev-parse','HEAD^']);
 const tree=git(['rev-parse','HEAD^{tree}']);
 const commitTree=git(['show','-s','--format=%T','HEAD']);
 const branchHead=git(['rev-parse',`refs/remotes/origin/${branch}`]);
 const dirty=git(['status','--porcelain','--untracked-files=all']);

 if(process.env.GITHUB_REF!==`refs/heads/${branch}`||process.env.GITHUB_REF_NAME!==branch)
  fail('BRANCH_MISMATCH');
 if(!/^[0-9a-f]{40}$/.test(process.env.GITHUB_SHA??'')||head!==process.env.GITHUB_SHA)
  fail('SHA_MISMATCH');
 if(parents.length!==1||parent!==expectedParent||parents[0]!==expectedParent)
  fail('PARENT_MISMATCH');
 if(!/^[0-9a-f]{40}$/.test(tree)||tree!==commitTree)
  fail('TREE_MISMATCH');
 if(branchHead!==head)
  fail('REMOTE_BRANCH_MISMATCH');
 if(dirty.length!==0)
  fail('WORKTREE_DIRTY');

 const databaseUrls=[process.env.DATABASE_URL,process.env.TEST_DATABASE_URL,
  process.env.AUTOIN_TEST_DATABASE_URL];
 if(databaseUrls.some(value=>typeof value!=='string'||value.length===0)||
    databaseUrls.some(value=>value!==databaseUrls[0]))
  fail('DATABASE_URLS_MISMATCH');
 const databaseUrl=new URL(databaseUrls[0]);
 if(databaseUrl.protocol!=='postgresql:'||databaseUrl.hostname!=='127.0.0.1'||
    databaseUrl.port!=='5432'||databaseUrl.username!=='auto_in'||databaseUrl.password!==''||
    databaseUrl.pathname!==`/${expectedDatabase}`||databaseUrl.search||databaseUrl.hash)
  fail('DATABASE_NOT_ISOLATED');
 if(process.env.AUTOIN_OPERATION_MODE!=='simulation')
  fail('SIMULATION_REQUIRED');
 if(process.env.AUTOIN_ALLOW_PG_ACCEPTANCE!=='YES_ISOLATED_TEST_DB')
  fail('ISOLATED_TEST_FLAG_REQUIRED');

 console.log(`Pilot candidate gate passed: sha=${head} parent=${parent} tree=${tree}`);
}catch(error){
 if(error instanceof Error&&error.message.startsWith('PILOT_TARGETED_CI_GUARD_FAILED:'))throw error;
 fail('CHECK_FAILED');
}
