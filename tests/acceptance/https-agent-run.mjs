/** AI5 CODE-305. One preapproved, never-used synthetic job per invocation. */
import {readFile,stat,appendFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {dirname,resolve,isAbsolute,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateHttpsAgentFixture} from './https-agent-fixture.mjs';
import {assertSafeDatabase} from './product-adapter.mjs';
import {requireIsolatedPgEnv} from './integration-preflight.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const outside=p=>isAbsolute(p)&&p!==root&&!p.startsWith(root+sep);
const blocked=message=>{console.error('BLOCKED exit2: '+message);process.exit(2)};
async function main(){
 if(!process.argv.includes('--execute')||process.env.AUTOIN_CODE305_RUN_HTTPS_AGENT!=='YES_SIMULATION_ONLY')blocked('Explicit --execute and simulation-only opt-in required');
 requireIsolatedPgEnv();
 const dburl=process.env.AUTOIN_TEST_DATABASE_URL;assertSafeDatabase(dburl);
 if(process.env.TEST_DATABASE_URL&&process.env.TEST_DATABASE_URL!==dburl)blocked('PostgreSQL test URLs differ');
 const filename=process.env.AUTOIN_CODE305_HTTPS_FIXTURE,ledger=process.env.AUTOIN_CODE305_USED_JOB_LEDGER,cert=process.env.SSL_CERT_FILE;
 if(!filename||!ledger||!cert||!outside(filename)||!outside(ledger)||!outside(cert))blocked('Fixture/ledger/TLS certificate must have ABSOLUTE paths outside repo');
 const certInfo=await stat(cert).catch(()=>null),fixtureInfo=await stat(filename).catch(()=>null);
 if(!certInfo?.isFile()||!fixtureInfo?.isFile()||fixtureInfo.size>8192||(fixtureInfo.mode&0o077)!==0)blocked('Trusted TLS and private 0600 JSON fixture required');
 const item=validateHttpsAgentFixture(JSON.parse(await readFile(filename,'utf8')),{
  integrationSha:process.env.AUTOIN_INTEGRATION_SHA,operationMode:process.env.AUTOIN_OPERATION_MODE,
  httpsUrl:process.env.AUTOIN_CODE303_HTTPS_URL,agentToken:process.env.AUTOIN_CODE303_AGENT_TOKEN,tlsCertificatePresent:true});
 if(process.env.AUTOIN_CODE305_SCENARIO!==item.scenario)blocked('Requested scenario differs from fixture');
 const st=await stat(ledger).catch(()=>null);
 if(st&&(!st.isFile()||(st.mode&0o077)!==0))blocked('Used-job ledger must be private 0600 file');
 const consumed=st?(await readFile(ledger,'utf8')).split('\n').filter(Boolean).map(x=>JSON.parse(x)):[];
 if(consumed.some(x=>x.job_id===item.job_id||x.order_id===item.order_id))blocked('Old job/order previously used; must seed fresh job');
 const {default:pg}=await import('pg');
 const pool=new pg.Pool({connectionString:dburl,max:1,application_name:'autoin_ai5_https_fixture'});
 try {
  const sql=`SELECT j.id::text AS job_id,j.order_id::text AS order_id,o.shop_id,j.revision,
   j.state,j.claimed_by,j.lease_until,j.printer_id,j.confirmed_at,j.cancelled_at,
   o.active_revision,o.manual_lock,o.print_closed,s.mode AS shop_mode,s.printing_enabled,
   EXISTS(SELECT 1 FROM core_approvals a WHERE a.id=j.approval_id AND a.order_id=j.order_id
    AND a.revision=j.revision AND a.request_hash=j.request_hash) AS approved,
   EXISTS(SELECT 1 FROM core_confirmations c WHERE c.order_id=j.order_id AND c.revision=j.revision
    AND c.request_hash=j.request_hash AND c.kind='request') AS confirmed,
   (SELECT count(*)::int FROM core_print_jobs q JOIN core_orders qo ON qo.id=q.order_id
    WHERE qo.shop_id=o.shop_id AND q.printer_id=j.printer_id AND q.state='NOT_SENT'
    AND q.cancelled_at IS NULL AND q.confirmed_at IS NOT NULL
    AND (q.lease_until IS NULL OR q.lease_until<now()) AND NOT qo.manual_lock AND NOT qo.print_closed) AS eligible_jobs
   FROM core_print_jobs j JOIN core_orders o ON o.id=j.order_id
   JOIN core_shop_settings s ON s.shop_id=o.shop_id WHERE j.id=$1::uuid`;
  const row=(await pool.query(sql,[item.job_id])).rows[0];
  if(!row||row.order_id!==item.order_id||row.shop_id!==item.shop_id||row.printer_id!=='RMP7000'||
     row.shop_mode!=='simulation'||row.printing_enabled!==false||row.state!=='NOT_SENT'||
     row.claimed_by!==null||row.lease_until!==null||row.cancelled_at!==null||!row.confirmed_at||
     row.manual_lock||row.print_closed||row.revision!==row.active_revision||!row.approved||
     !row.confirmed||row.eligible_jobs!==1)
   blocked('Expected exactly one fresh confirmed and approved unsent simulation job for this shop');
 } finally {await pool.end()}
 // Reserve in private ledger BEFORE the agent request; any ambiguous result must never reuse the job.
 await appendFile(ledger,JSON.stringify({...item,consumed_at:new Date().toISOString()})+'\n',{mode:0o600});
 const env={...process.env,AUTOIN_CODE303_RUN_PRODUCT_DRYRUN:'YES_SIMULATION_ONLY',
  AUTOIN_CODE303_SCENARIO:item.scenario,FORCE_COLOR:'0'};
 const r=spawnSync('python3',['-m','pytest','-q','tests/unit/printing/test_product_backend_optin.py'],{
  cwd:root,env,encoding:'utf8',timeout:120000,maxBuffer:2*1024*1024});
 const output=((r.stdout||'')+'\n'+(r.stderr||'')).replaceAll(env.AUTOIN_CODE303_AGENT_TOKEN,'[REDACTED]');
 if(r.error||r.status!==0||!/\b1 passed\b/.test(output)||/\bskipped\b|\bfailed\b|\bERROR\b/i.test(output)){
  console.error('FAIL: '+item.scenario+' (synthetic HTTPS/PG DryRun, NO real printing)');
  console.error(output.slice(-1200));process.exit(1);
 }
 console.log('PASS synthetic HTTPS/PG/DryRun '+item.scenario+' sha='+item.integration_sha+'; live OA/printer NOT RUN');
}
main().catch(e=>blocked(e?.message||String(e)));
