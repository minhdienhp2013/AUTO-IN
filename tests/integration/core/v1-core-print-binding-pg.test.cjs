const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const root=process.env.AI1_BUILD_DIR||path.resolve(__dirname,'../../../.ai1-build/backend');
const {OrderService}=require(path.join(root,'core/service.js'));
const {PgStore}=require(path.join(root,'storage/database.js'));
const {sha,canonical}=require(path.join(root,'core/model.js'));
let pg;try{pg=require('pg')}catch{}
const url=process.env.TEST_DATABASE_URL,k=n=>n+'-'+randomUUID(),uid=()=>randomUUID();
const err=code=>e=>e&&e.code===code;
test('V1-CORE-01 real PG two-pool: confirmed source/quote/plan, concurrent approval, unknown never reclaimed',
 {skip:!(pg&&url)&&'Real isolated TEST_DATABASE_URL/pg missing',timeout:120000},async t=>{
 const parsed=new URL(url);
 assert.ok(['localhost','127.0.0.1','[::1]'].includes(parsed.hostname));
 assert.match(parsed.pathname,/test/i);
 const a=new pg.Pool({connectionString:url,max:8}),b=new pg.Pool({connectionString:url,max:8});
 try{
  const [pa,pb]=await Promise.all([a.query('SELECT pg_backend_pid() pid'),b.query('SELECT pg_backend_pid() pid')]);
  assert.notEqual(pa.rows[0].pid,pb.rows[0].pid);
  const shop=k('v1-shop'),other=k('v1-other'),ownerId=uid(),staffId=uid();
  await a.query("INSERT INTO core_shop_settings(shop_id,open_at,close_at) VALUES($1,'00:00','24:00'),($2,'00:00','24:00')",[shop,other]);
  await a.query("INSERT INTO core_users(id,shop_id,username,password_hash,role) VALUES($1,$3,'owner','test-only','owner'),($2,$3,'staff','test-only','staff')",[ownerId,staffId,shop]);
  const owner={id:ownerId,shop_id:shop,role:'owner',verified:true};
  const staff={id:staffId,shop_id:shop,role:'staff',verified:true};
  const otherStaff={...staff,shop_id:other};
  const processor={id:k('processor'),shop_id:shop,role:'processor',verified:true};
  const agent={id:k('agent'),shop_id:shop,role:'print_agent',verified:true,printer_ids:['RMP7000']};
  const customerId=k('customer'),customer={id:k('cred'),shop_id:shop,role:'customer',customer_id:customerId,verified:true};
  const wrongCustomer={...customer,id:k('wrong'),customer_id:k('another')};
  const A=new OrderService(new PgStore(a)),B=new OrderService(new PgStore(b));
  const jobs=async id=>Number((await a.query('SELECT count(*)::int n FROM core_print_jobs WHERE order_id=$1',[id])).rows[0].n);
  const maker=async tag=>{
   const source={files:[{file_id:k('source-'+tag),sha256:sha(tag),copies:1,format:'pdf'}],
    print:{paper:'A4',duplex:false,copies:1}};
   const draft=await A.createDraft(staff,{customer_id:customerId,request_data:source,idempotency_key:k('draft')});
   const plan={request_hash:draft.request_hash,physical_sheets:1,document_pages:1,printed_faces:1,
    ready:true,printer_id:'RMP7000',artifact_ref:'fixture/synthetic-'+tag+'.pdf',verified_by:processor.id};
   await A.publishVerifiedPlan(processor,draft.order_id,{expected_revision:1,plan,idempotency_key:k('plan')});
   return {id:draft.order_id,source,plan,revision:2};
  };
  const approve=async(id,svc=A,actor=staff)=>svc.approve(actor,id,{expected_revision:2,
   acknowledge_deposit_shortage:true,idempotency_key:k('approve')});
  const confirm=async(id,svc=A)=>svc.confirm(customer,id,{expected_revision:2,kind:'request',idempotency_key:k('confirm')});
  const guards=async()=> (await a.query(
   'SELECT (SELECT count(*)::int FROM core_confirmations WHERE order_id IN (SELECT id FROM core_orders WHERE shop_id=$1)) confirms,'+
   '(SELECT count(*)::int FROM core_approvals WHERE order_id IN (SELECT id FROM core_orders WHERE shop_id=$1)) approvals,'+
   '(SELECT count(*)::int FROM core_print_jobs WHERE order_id IN (SELECT id FROM core_orders WHERE shop_id=$1)) jobs',[shop])).rows[0];
  await t.test('wrong customer/shop, two staff approve same current revision atomically',async()=>{
   const d=await maker('parallel');
   await assert.rejects(A.confirm(wrongCustomer,d.id,{expected_revision:2,kind:'request',idempotency_key:k('wrong-customer')}),err('WRONG_CUSTOMER'));
   await assert.rejects(A.approve(otherStaff,d.id,{expected_revision:2,acknowledge_deposit_shortage:true,idempotency_key:k('wrong-shop')}),err('FORBIDDEN'));
   await assert.rejects(approve(d.id),err('CUSTOMER_NOT_CONFIRMED'));
   await confirm(d.id);
   const race=await Promise.allSettled([approve(d.id,A,owner),approve(d.id,B,staff)]);
   assert.equal(race.filter(x=>x.status==='fulfilled').length,1);
   assert.equal(race.filter(x=>x.status==='rejected'&&x.reason.code==='ALREADY_APPROVED').length,1);
   assert.equal(await jobs(d.id),1);
   const approved=(await a.query("SELECT details FROM core_audit WHERE order_id=$1 AND action='print.approved'",[d.id])).rows;
   assert.equal(approved.length,1);
   assert.match(approved[0].details.plan_sha256,/^[a-f0-9]{64}$/);
   // This race fixture must not steal claims belonging to later test cases.
   await a.query('UPDATE core_print_jobs SET cancelled_at=now() WHERE order_id=$1 AND state=\'NOT_SENT\'',[d.id]);
  });
  await t.test('tampered customer file/settings hash cannot claim an old approved job',async()=>{
   const d=await maker('file-mutation');await confirm(d.id);await approve(d.id);
   const original=(await a.query('SELECT request_hash FROM core_revisions WHERE order_id=$1 AND revision=2',[d.id])).rows[0].request_hash;
   await a.query("UPDATE core_revisions SET request_data=jsonb_set(request_data,'{print,paper}','\"A3\"'::jsonb) WHERE order_id=$1 AND revision=2",[d.id]);
   assert.equal((await a.query('SELECT request_hash FROM core_revisions WHERE order_id=$1 AND revision=2',[d.id])).rows[0].request_hash,original);
   await assert.rejects(A.claim(agent,{printer_id:'RMP7000',idempotency_key:k('claim-hash')}),err('STALE_FILE_BINDING'));
   assert.equal(await jobs(d.id),1);
   const row=(await a.query('SELECT state FROM core_print_jobs WHERE order_id=$1',[d.id])).rows[0];
   assert.equal(row.state,'NOT_SENT');
   // Stop polluted fixture from winning next claim.
   await a.query('UPDATE core_print_jobs SET cancelled_at=now() WHERE order_id=$1',[d.id]);
  });
  await t.test('post-approval plan/source ref or printer settings invalidates old approval before send',async()=>{
   const d=await maker('plan-mutation');await confirm(d.id);await approve(d.id);
   const got=await A.claim(agent,{printer_id:'RMP7000',idempotency_key:k('claim-plan')});
   assert.equal(got.job.order_id,d.id);
   await a.query("UPDATE core_revisions SET plan=jsonb_set(plan,'{artifact_ref}','\"fixture/changed.pdf\"'::jsonb) WHERE order_id=$1 AND revision=2",[d.id]);
   await assert.rejects(B.preflight(agent,got.job.job_id,{expected_revision:2,lease_token:got.job.lease_token}),err('STALE_PRINT_BINDING'));
   await assert.rejects(B.markSending(agent,got.job.job_id,{expected_revision:2,lease_token:got.job.lease_token,idempotency_key:k('bad-send')}),err('STALE_PRINT_BINDING'));
   assert.equal((await a.query('SELECT state FROM core_print_jobs WHERE id=$1',[got.job.job_id])).rows[0].state,'NOT_SENT');
   await a.query('UPDATE core_print_jobs SET cancelled_at=now() WHERE order_id=$1',[d.id]);
  });
  await t.test('reprice rev2 invalidates request confirmation; fresh confirmation permits new job',async()=>{
   const d=await maker('reprice');
   const q1=await A.setQuote(staff,d.id,{expected_revision:2,amount_vnd:20000,deposit_required_vnd:0,
    significant_cost:false,idempotency_key:k('quote1')});
   assert.equal(q1.quote_revision,1);
   await confirm(d.id);await approve(d.id);
   const q2=await B.setQuote(staff,d.id,{expected_revision:2,amount_vnd:30000,deposit_required_vnd:0,
    significant_cost:false,idempotency_key:k('quote2')});
   assert.equal(q2.quote_revision,2);
   await assert.rejects(approve(d.id),e=>['CUSTOMER_NOT_CONFIRMED','STALE_CUSTOMER_CONFIRMATION'].includes(e.code));
   // Force a later timestamp; CI transaction timestamp precision may be the same millisecond.
   await a.query("UPDATE core_quotes SET created_at=created_at-interval '1 second' WHERE order_id=$1 AND quote_revision=2",[d.id]);
   await confirm(d.id);
   const ok=await approve(d.id);
   assert.ok(ok.job_id);
   // Altering quote content outside approved action proves audit fingerprint is checked.
   await a.query('UPDATE core_quotes SET amount_vnd=amount_vnd+1 WHERE order_id=$1 AND quote_revision=2',[d.id]);
   await assert.rejects(A.claim(agent,{printer_id:'RMP7000',idempotency_key:k('claim-quote')}),err('STALE_PRINT_BINDING'));
   assert.equal(await jobs(d.id),2); // old cancelled job + new active job
   await a.query('UPDATE core_print_jobs SET cancelled_at=now() WHERE order_id=$1',[d.id]);
  });
  await t.test('lost/ambiguous send ACK leaves UNKNOWN, never creates or claims another job',async()=>{
   const d=await maker('unknown');await confirm(d.id);
   const approved=await approve(d.id);
   const reserved=await A.claim(agent,{printer_id:'RMP7000',idempotency_key:k('claim-unknown')});
   assert.equal(reserved.job.job_id,approved.job_id);
   const payload={expected_revision:2,lease_token:reserved.job.lease_token,idempotency_key:k('send-once')};
   assert.equal((await A.markSending(agent,approved.job_id,payload)).state,'SENDING');
   assert.equal((await B.markUnknownForReconciliation(staff,approved.job_id,{reason:'synthetic lost ACK',idempotency_key:k('unknown')})).state,'UNKNOWN');
   await assert.rejects(B.markSending(agent,approved.job_id,{...payload,idempotency_key:k('send-again')}),err('NOT_SENDABLE'));
   assert.equal((await B.claim(agent,{printer_id:'RMP7000',idempotency_key:k('no-reclaim')})).job,null);
   assert.equal((await a.query('SELECT state FROM core_print_jobs WHERE id=$1',[approved.job_id])).rows[0].state,'UNKNOWN');
   assert.equal(await jobs(d.id),1);
  });
  const snapshot=await guards();
  assert.ok(snapshot.confirms>=5);
  assert.ok(snapshot.approvals>=5);
  console.log('V1 CORE test fixture checks completed; use runner pass/fail counts as evidence');
 }finally{await Promise.all([a.end(),b.end()]);}
});
