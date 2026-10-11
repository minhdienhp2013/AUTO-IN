/** CODE-205 product-backed acceptance adapter: AI1 services + actual PostgreSQL. NO fake repository. */
import {randomUUID} from 'node:crypto';
import {access,readFile,mkdtemp,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
const root=resolve(import.meta.dirname,'../..');
const uuid=()=>randomUUID(), key=s=>'a205-'+s+'-'+uuid();
const principal=(id,shop_id,role,extra={})=>({id,shop_id,role,verified:true,...extra});
export function assertSafeDatabase(url,productionUrl=process.env.DATABASE_URL){
 if(!url)throw Error('AUTOIN_TEST_DATABASE_URL required');
 if(productionUrl&&productionUrl===url)throw Error('Production DATABASE_URL matches test URL');
 if(process.env.AUTOIN_ALLOW_PG_ACCEPTANCE!=='YES_ISOLATED_TEST_DB')throw Error('Explicit isolated test DB acknowledgement required');
 const parsed=new URL(url);
 if(!['postgres:','postgresql:'].includes(parsed.protocol))throw Error('PostgreSQL URL required');
 if(!['127.0.0.1','localhost','[::1]'].includes(parsed.hostname))throw Error('Remote PostgreSQL forbidden');
 if(!/^autoin_test[a-z0-9_-]*$/i.test(decodeURIComponent(parsed.pathname.slice(1))))throw Error('Database name must start autoin_test');
 return parsed;
}
const safeInt=n=>{const v=Number(n);if(!Number.isSafeInteger(v))throw Error('Unsafe BIGINT');return v;};
async function loadModule(name){
 const filepath=join(resolve(process.env.AI1_BUILD_DIR||join(root,'dist/backend')),name+'.js');
 await access(filepath).catch(()=>{throw Error('Compile AI1 product modules before test: '+filepath)});
 return import(pathToFileURL(filepath).href);
}
function asResult(err){
 if(typeof err?.code==='string'&&Number.isInteger(err.status)&&err.status>=400&&err.status<500)
  return {ok:false,status:err.status,error:{code:err.code,message:err.message}};
 throw err;
}
async function result(fn){try{return {ok:true,...(await fn())}}catch(e){return asResult(e)}}
export async function createAcceptanceAdapter({databaseUrl,mode='simulation',printer='DryRunDriver'}={}){
 if(mode!=='simulation'||printer!=='DryRunDriver')throw Error('Real printing strictly forbidden');
 assertSafeDatabase(databaseUrl);
 const [{default:pg},{PgStore},{OrderService},{AuthService,passwordHash}]=await Promise.all([
  import('pg'),loadModule('storage/database'),loadModule('core/service'),loadModule('core/auth')
 ]);
 const bridge=join(import.meta.dirname,'dryrun-bridge.py');
 execFileSync('python3',[bridge,'probe'],{cwd:root,timeout:5000});
 const pool=new pg.Pool({connectionString:databaseUrl,max:12,application_name:'autoin_ai5_acceptance'});
 const name=(await pool.query('SELECT current_database() AS name')).rows[0].name;
 if(!/^autoin_test[a-z0-9_-]*$/i.test(name)){await pool.end();throw Error('Connected DB is not isolated test DB');}
 for(const filename of ['001_core.sql','002_send_mode.sql']){
  const path=join(root,'backend/storage/migrations',filename);
  await access(path).catch(()=>{throw Error('Missing AI1 migration '+path)});
  await pool.query(await readFile(path,'utf8'));
 }
 const store=new PgStore(pool),svc=new OrderService(store),auth=new AuthService(store);
 let shop,order_id,revision=1,actors={},driver_calls=0,journalDir,agents=[];
 function who(actor='staff'){
  if(actor==='anonymous')return {id:'anonymous',shop_id:shop,role:'customer',verified:false};
  if(actor==='other-customer')return principal('other',shop,'customer',{customer_id:'other'});
  return actors[actor]??actors.staff;
 }
 function oid(b){return b?.order_id?.startsWith?.('synthetic-')?order_id:(b?.order_id??order_id);}
 async function plan(sheets,twice=false){
  for(let i=0;i<(twice?2:1);i++){
   const row=(await pool.query('SELECT request_hash FROM core_revisions WHERE order_id=$1 AND revision=$2',[order_id,revision])).rows[0];
   const p={request_hash:row.request_hash,physical_sheets:sheets,document_pages:sheets,printed_faces:sheets,ready:true,printer_id:'RMP7000',artifact_ref:'synthetic/public/sample.pdf',verified_by:actors.processor.id};
   revision=(await svc.publishVerifiedPlan(actors.processor,order_id,{expected_revision:revision,plan:p,idempotency_key:key('plan')})).revision;
  }
 }
 async function quote(amount,deposit=0,twice=false){
  for(let i=0;i<(twice?2:1);i++)await svc.setQuote(actors.staff,order_id,{expected_revision:revision,amount_vnd:amount,deposit_required_vnd:deposit,significant_cost:false,idempotency_key:key('quote')});
 }
 async function confirm(){
  await svc.confirm(actors.customer,order_id,{expected_revision:revision,kind:'request',idempotency_key:key('confirm')});
 }
 async function approve(){
  return svc.approve(actors.staff,order_id,{expected_revision:revision,acknowledge_deposit_shortage:true,idempotency_key:key('approve')});
 }
 async function reset(seed){
  shop='autoin-test-shop-'+uuid();revision=1;driver_calls=0;
  // No deletion/truncation: every case creates an isolated synthetic shop in a dedicated DB.
  await auth.bootstrapOwner({shop_id:shop,username:'owner',password:key('long-owner-password'),bootstrap_enabled:true});
  await pool.query("UPDATE core_shop_settings SET mode='simulation',printing_enabled=false,open_at='00:00',close_at='24:00' WHERE shop_id=$1",[shop]);
  const owner=(await pool.query("SELECT id FROM core_users WHERE shop_id=$1 AND role='owner'",[shop])).rows[0].id;
  const staff=uuid();
  await pool.query("INSERT INTO core_users(id,shop_id,username,password_hash,role) VALUES($1,$2,'staff',$3,'staff')",[staff,shop,await passwordHash(key('long-staff-password'))]);
  actors={owner:principal(owner,shop,'owner'),staff:principal(staff,shop,'staff'),processor:principal('processor-test',shop,'processor'),
   customer:principal('verified-zalo',shop,'customer',{customer_id:'synthetic-customer-'+uuid()}),
   agent:principal('agent-1',shop,'print_agent'),'agent-1':principal('agent-1',shop,'print_agent'),'agent-2':principal('agent-2',shop,'print_agent')};
  const initial=await svc.createDraft(actors.staff,{customer_id:actors.customer.customer_id,request_data:{files:[{file_id:'public-fixture',copies:1,format:'pdf'}]},idempotency_key:key('new')});
  order_id=initial.order_id;
  if(['unapproved_order','idempotency_conflict'].includes(seed))return;
  await plan(seed==='large_quote_unconfirmed'?151:seed==='partial_delivery_exception'?40:5,seed==='approved_unsent');
  if(seed==='stale_revision')return;
  if(seed==='large_quote_unconfirmed'){await confirm();await quote(300000,0,true);return;}
  if(seed==='deposit_short'){
   await quote(200000,200000);
   await svc.recordPayment(actors.staff,order_id,{direction:'received',method:'cash',amount_vnd:100000,idempotency_key:key('paid')});
   await confirm();return;
  }
  if(seed==='partial_delivery_exception'){
   await quote(100000);
   await svc.recordPayment(actors.staff,order_id,{direction:'received',method:'cash',amount_vnd:30000,idempotency_key:key('paid')});
  }
  await confirm();await approve();
  if(seed==='manual_lock')await svc.manual(actors.staff,order_id,{expected_revision:revision,reason:'synthetic manual lock',idempotency_key:key('manual')});
  if(seed==='holiday'){
   const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Ho_Chi_Minh',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
   const date=['year','month','day'].map(k=>parts.find(p=>p.type===k).value).join('-');
   await pool.query('UPDATE core_shop_settings SET holiday_dates=$2 WHERE shop_id=$1',[shop,[date]]);
  }
  if(seed==='unknown_after_crash'||seed==='spooler'){
   const {job}=await svc.claim(actors.agent,{printer_id:'RMP7000',idempotency_key:key('claim')});
   if(!job)throw Error('Product seed expected eligible job');
   await svc.markSending(actors.agent,job.job_id,{expected_revision:job.revision,lease_token:job.lease_token,idempotency_key:key('send')});
   await svc.markUnknownForReconciliation(actors.staff,job.job_id,{reason:'synthetic network uncertainty',idempotency_key:key('unknown')});
  }
 }
 async function invoke(action,b={},actor='staff',service=svc){
  const p=who(actor),id=oid(b);
  switch(action){
   case 'claim':return service.claim(p,{printer_id:b.printer_id??'RMP7000',idempotency_key:b.idempotency_key??key('claim')});
   case 'preflight':return service.preflight(p,b.job_id,{expected_revision:b.expected_revision,lease_token:b.lease_token});
   case 'mark_sending':return service.markSending(p,b.job_id,{expected_revision:b.expected_revision,lease_token:b.lease_token,idempotency_key:b.idempotency_key??key('send')});
   case 'report':return service.report(p,b.job_id,{expected_revision:b.expected_revision,lease_token:b.lease_token,result:b.result,evidence_kind:b.evidence_kind,idempotency_key:b.idempotency_key??key('report')});
   case 'verify_paper':return service.verifyPaper(p,b.job_id,{evidence_kind:b.evidence_kind,physical_sheets:b.physical_sheets,note:b.note??'synthetic only',idempotency_key:b.idempotency_key??key('paper')});
   case 'approve':return service.approve(p,id,{expected_revision:b.expected_revision,quote_revision:b.quote_revision,acknowledge_deposit_shortage:b.acknowledge_deposit_shortage??false,idempotency_key:b.idempotency_key??key('approve')});
   case 'revise':return service.revise(p,id,{expected_revision:b.expected_revision,request_data:b.request_data,idempotency_key:b.idempotency_key??key('revise')});
   case 'close_exception':return service.closePrintException(p,id,{expected_revision:b.expected_revision??revision,reason:b.reason??'synthetic exception',idempotency_key:b.idempotency_key??key('close')});
   case 'manual':return service.manual(p,id,{expected_revision:b.expected_revision??revision,reason:'synthetic manual processing',idempotency_key:b.idempotency_key??key('manual')});
   case 'payment':return service.recordPayment(p,id,{direction:b.direction,method:b.method??'cash',amount_vnd:b.amount_vnd,idempotency_key:b.idempotency_key??key('payment')});
   case 'deliver':return service.deliver(p,id,{physical_sheets:b.physical_sheets,expected_revision:b.expected_revision??revision,note:'synthetic partial',idempotency_key:b.idempotency_key??key('delivery')});
   default:throw Error('Unsupported actual-service operation '+action);
  }
 }
 async function act(action,b={},context={}){return result(()=>invoke(action,b,context.actor??'staff'))}
 async function newAgent(name){
  const ownPool=new pg.Pool({connectionString:databaseUrl,max:1,application_name:'autoin_ai5_'+name});agents.push(ownPool);
  const pid=(await ownPool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  const ownService=new OrderService(new PgStore(ownPool));
  return {connection_id:String(pid),act:(action,b={})=>result(()=>invoke(action,b,name,ownService))};
 }
 async function snapshot(){
  const row=(await pool.query('SELECT * FROM core_orders WHERE id=$1',[order_id])).rows[0];
  const job=(await pool.query('SELECT * FROM core_print_jobs WHERE order_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1',[order_id])).rows[0];
  const rev=(await pool.query('SELECT plan FROM core_revisions WHERE order_id=$1 AND revision=$2',[order_id,row.active_revision])).rows[0];
  const quote=(await pool.query('SELECT deposit_required_vnd FROM core_quotes WHERE order_id=$1 ORDER BY quote_revision DESC LIMIT 1',[order_id])).rows[0];
  const details=await svc.getOrder(actors.staff,order_id),delivered=safeInt(row.delivered_sheets);
  return {order_id,active_revision:row.active_revision,print_state:job?.state??'NOT_SENT',job_id:job?.id??null,driver_calls,
   delivered_sheets:delivered,undelivered_sheets:Math.max(0,(rev.plan?.physical_sheets??0)-delivered),
   receivable_vnd:details.receivable_vnd,refundable_vnd:details.refundable_vnd,
   remaining_deposit_vnd:Math.max(0,safeInt(quote?.deposit_required_vnd??0)-details.received_vnd)};
 }
 async function dryrunOnce(){
  const c=await svc.claim(actors.agent,{printer_id:'RMP7000',idempotency_key:key('dry-claim')});
  if(!c.job)return {status:'NO_JOB'};
  const job=c.job;
  const gate=await svc.preflight(actors.agent,job.job_id,{expected_revision:job.revision,lease_token:job.lease_token});
  if(gate.allowed!==true)throw Error('Real AI1 preflight blocked');
  journalDir??=await mkdtemp(join(tmpdir(),'autoin-ai5-journal-'));
  const journal=join(journalDir,'journal.sqlite3'),input=JSON.stringify(job);
  execFileSync('python3',[bridge,'begin',journal],{cwd:root,input,timeout:10000});
  const mark=await svc.markSending(actors.agent,job.job_id,{expected_revision:job.revision,lease_token:job.lease_token,idempotency_key:key('dry-send')});
  if(mark.state!=='SENDING')throw Error('Real AI1 mark-sending blocked');
  const sent=JSON.parse(execFileSync('python3',[bridge,'send',journal],{cwd:root,input,timeout:10000}).toString());
  driver_calls++;
  if(sent.evidence_kind!=='simulated'||sent.paper_verified!==false)throw Error('Invalid dry-run evidence');
  await svc.report(actors.agent,job.job_id,{expected_revision:job.revision,lease_token:job.lease_token,result:'simulated_done',evidence_kind:'simulated',idempotency_key:key('dry-report')});
  return {status:'SIMULATED_DONE',job_id:job.job_id,evidence_kind:'simulated'};
 }
 return {environment:{type:'product-backed',database:'postgresql',print_driver:'DryRunDriver',scope:'isolated-test',source:'AI1-Service+AI3-Journal'},reset,act,snapshot,newAgent,dryrunOnce,
  async dispose(){for(const p of agents)await p.end();if(journalDir)await rm(journalDir,{recursive:true,force:true});await pool.end();}};
}
