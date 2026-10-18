const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const root=process.env.AI1_BUILD_DIR||path.resolve(__dirname,'../../../.ai1-build/backend');
const {OrderService}=require(path.join(root,'core/service.js'));
const {createVerifiedConfirmationPort}=require(path.join(root,'core/verified-confirmation-port.js'));
const {PgStore}=require(path.join(root,'storage/database.js'));
const {sha,canonical}=require(path.join(root,'core/model.js'));
let pg;try{pg=require('pg')}catch{}
const url=process.env.TEST_DATABASE_URL,uid=()=>randomUUID(),key=x=>x+'-'+uid();
const error=code=>e=>e&&e.code===code;
test('V1-CORE-02 REAL PG two pools: PR150 evidence bound at confirmation, approval, claim/preflight/send',
 {skip:!(pg&&url)&&'NOT RUN - isolated PostgreSQL TEST_DATABASE_URL required',timeout:120000},async t=>{
 const u=new URL(url);
 assert.ok(['localhost','127.0.0.1','[::1]'].includes(u.hostname));
 assert.match(u.pathname,/test/i);
 const a=new pg.Pool({connectionString:url,max:6}),b=new pg.Pool({connectionString:url,max:6});
 try{
  const shop=key('v1-evidence-shop');
  await a.query("INSERT INTO core_shop_settings(shop_id,open_at,close_at) VALUES($1,'00:00','24:00')",[shop]);
  const staffId=uid();
  await a.query("INSERT INTO core_users(id,shop_id,username,password_hash,role) VALUES($1,$2,'staff','test-only','staff')",[staffId,shop]);
  const staff={id:staffId,shop_id:shop,verified:true,role:'staff'};
  const processor={id:'verified-processor',shop_id:shop,verified:true,role:'processor'};
  const customerId=key('customer');
  const customer={id:key('customer-credential'),shop_id:shop,role:'customer',customer_id:customerId,verified:true};
  const agent={id:key('agent'),shop_id:shop,role:'print_agent',verified:true,printer_ids:['RMP7000']};
  const states=new Map();
  // FAKE/TEST ONLY: AI0 must replace with real source-byte/manifest/preview verifier.
  const fakePort={async read_verified(_db,scope){
   const state=states.get(scope.order_id);
   if(!state)return null;
   const sources=[{source_artifact_ref:'fixture/source.pdf',format:'pdf',size_bytes:10,
    source_sha256:sha(state.source)}];
   const body={schema:'ai0.print_evidence.v1',shop_id:scope.shop_id,order_id:scope.order_id,
    revision:scope.revision,request_hash:scope.request_hash,sources,
    source_set_sha256:sha(canonical(sources)),settings_sha256:sha(state.settings),
    manifest_ref:'fixture/manifest',manifest_sha256:sha(state.manifest),
    previews:[{index:0,bytes:300,sha256:sha(state.preview)}],
    renderer_sha256:sha(state.renderer),plan_sha256:sha(canonical(scope.plan)),
    printer_id:scope.plan.printer_id,printer_capability_sha256:sha(state.capability)};
   return {...body,evidence_sha256:sha(canonical(body))};
  }};
  const A=new OrderService(new PgStore(a),()=>new Date(),fakePort);
  const B=new OrderService(new PgStore(b),()=>new Date(),fakePort);
  const make=async(label,conversation_id)=>{
   const data={files:[{file_id:'fixture/source.pdf',copies:1,format:'pdf'}],
    settings:{paper:'A4',duplex:false,copies:1}};
   const draft=await A.createDraft(staff,{customer_id:customerId,...(conversation_id?{conversation_id}:{}),request_data:data,
    idempotency_key:key('create')});
   const plan={request_hash:draft.request_hash,physical_sheets:1,document_pages:1,printed_faces:1,
    ready:true,printer_id:'RMP7000',artifact_ref:'fixture/source.pdf',verified_by:processor.id};
   const revision=await A.publishVerifiedPlan(processor,draft.order_id,
    {expected_revision:1,plan,idempotency_key:key('plan')});
   assert.equal(revision.revision,2);
   states.set(draft.order_id,{source:'sealed-'+label,settings:'A4 duplex0',
    manifest:'manifest-'+label,preview:'page0-'+label,renderer:'PDF-v1',capability:'Ricoh-driver-fixture'});
   return draft.order_id;
  };
  const confirm=id=>A.confirm(customer,id,{expected_revision:2,kind:'request',idempotency_key:key('confirm')});
  const approve=(id,service=A)=>service.approve(staff,id,{expected_revision:2,
   acknowledge_deposit_shortage:true,idempotency_key:key('approve')});
  const jobCount=async id=>Number((await a.query('SELECT count(*)::int n FROM core_print_jobs WHERE order_id=$1',[id])).rows[0].n);
  const cancel=async id=>a.query("UPDATE core_print_jobs SET cancelled_at=now() WHERE order_id=$1 AND state='NOT_SENT'",[id]);
  await t.test('confirmation pins evidence; source/manifest/settings/preview/renderer/capability drift blocks approval',async()=>{
   for(const part of ['source','manifest','settings','preview','renderer','capability']){
    const id=await make('before-approve-'+part);await confirm(id);
    const column=(await a.query("SELECT evidence_sha256 FROM core_confirmations WHERE order_id=$1 AND kind='request'",[id])).rows[0];
    assert.match(column.evidence_sha256,/^[0-9a-f]{64}$/);
    const audit=(await a.query("SELECT details FROM core_audit WHERE action='customer.confirmed' AND order_id=$1",[id])).rows[0];
    assert.equal(audit.details.evidence_sha256,column.evidence_sha256);
    states.get(id)[part]+='-changed';
    assert.equal((await A.getOrder(staff,id)).current.request_confirmed,false);
    await assert.rejects(approve(id),error('STALE_PRINT_EVIDENCE'));
    assert.equal(await jobCount(id),0);
   }
  });
  await t.test('same-key confirmation and approval retries are idempotent and create one job',async()=>{
   const id=await make('idempotent');
   const confirmInput={expected_revision:2,kind:'request',idempotency_key:key('confirm-stable')};
   const first=await A.confirm(customer,id,confirmInput);
   const retry=await B.confirm(customer,id,confirmInput);
   assert.deepEqual(retry,first);
   assert.equal((await a.query("SELECT count(*)::int n FROM core_confirmations WHERE order_id=$1 AND kind='request'",[id])).rows[0].n,1);
   const stored=(await a.query("SELECT evidence_sha256 FROM core_confirmations WHERE order_id=$1 AND kind='request'",[id])).rows[0];
   assert.match(stored.evidence_sha256,/^[0-9a-f]{64}$/);
   const approveInput={expected_revision:2,acknowledge_deposit_shortage:true,idempotency_key:key('approve-stable')};
   const approved=await A.approve(staff,id,approveInput);
   const approveRetry=await B.approve(staff,id,approveInput);
   assert.deepEqual(approveRetry,approved);
   assert.equal(await jobCount(id),1);
   const bound=(await a.query('SELECT a.evidence_sha256 approval,j.evidence_sha256 job FROM core_approvals a JOIN core_print_jobs j ON j.approval_id=a.id WHERE j.order_id=$1',[id])).rows[0];
   assert.equal(bound.approval,stored.evidence_sha256);assert.equal(bound.job,stored.evidence_sha256);
   await cancel(id);
  });
  await t.test('verified OA challenge binds evidence at issue and click, stale preview cannot confirm',async()=>{
   const conv=key('verified-conversation'),oa=key('oa'),id=await make('verified-oa',conv);
   const port={store:new PgStore(b),trusted:{shop_id:shop,oa_id:oa},evidence:fakePort};
   const challengePort=createVerifiedConfirmationPort(port);
   const hash=(await a.query('SELECT request_hash FROM core_revisions WHERE order_id=$1 AND revision=2',[id])).rows[0].request_hash;
   const target={order_id:id,expected_revision:2,request_hash:hash,kind:'request',expected_generation:0};
   const initial=await challengePort.issue_challenge(target);assert.equal(initial.status,'issued');
   assert.match((await a.query('SELECT evidence_sha256 FROM core_confirmation_challenges WHERE id=$1',[initial.challenge_id])).rows[0].evidence_sha256,/^[0-9a-f]{64}$/);
   states.get(id).preview+='-preview-rerendered';
   const inbound=async ch=>{
    const event=key('postback');
    await a.query(
     'INSERT INTO zalo_inbound_events(oa_id,event_id,conversation_id,customer_id,occurred_at,payload_json) VALUES($1,$2,$3,$4,now(),$5::jsonb)',
     [oa,event,conv,customerId,JSON.stringify({confirmation_postback:{
      kind:'verified_confirmation_accept',challenge_id:ch.challenge_id,challenge_token:ch.challenge_token}})]);
    return event;
   };
   const oldEvent=await inbound(initial);
   assert.deepEqual(await challengePort.confirm_verified_event({...target,event_id:oldEvent}),{status:'stale'});
   assert.equal((await a.query('SELECT count(*)::int n FROM core_confirmations WHERE order_id=$1',[id])).rows[0].n,0);
   const newer=await challengePort.issue_challenge(target);
   assert.equal(newer.status,'issued');
   const event=await inbound(newer);
   const accepted=await challengePort.confirm_verified_event({...target,event_id:event});
   assert.equal(accepted.status,'confirmed');
   const acceptedProof=(await a.query('SELECT evidence_sha256 FROM core_confirmations WHERE id=$1',[accepted.confirmation_id])).rows[0].evidence_sha256;
   assert.match(acceptedProof,/^[0-9a-f]{64}$/);
   const audit=(await a.query("SELECT details FROM core_audit WHERE order_id=$1 AND action='customer.confirmed_verified_event'",[id])).rows[0];
   assert.match(audit.details.evidence_sha256,/^[0-9a-f]{64}$/);
   const approved=await A.approve(staff,id,{expected_revision:2,acknowledge_deposit_shortage:true,idempotency_key:key('approve-verified')});
   assert.ok(approved.job_id);
   assert.equal((await a.query('SELECT evidence_sha256 FROM core_print_jobs WHERE id=$1',[approved.job_id])).rows[0].evidence_sha256,acceptedProof);
   const oldId=await make('legacy-challenge',conv);
   const oldHash=(await a.query('SELECT request_hash FROM core_revisions WHERE order_id=$1 AND revision=2',[oldId])).rows[0].request_hash;
   const oldTarget={order_id:oldId,expected_revision:2,request_hash:oldHash,kind:'request',expected_generation:0};
   const legacyChallengePort=createVerifiedConfirmationPort({store:new PgStore(a),trusted:{shop_id:shop,oa_id:oa}});
   const oldChallenge=await legacyChallengePort.issue_challenge(oldTarget);
   assert.equal(oldChallenge.status,'issued');
   assert.equal((await a.query('SELECT evidence_sha256 FROM core_confirmation_challenges WHERE id=$1',[oldChallenge.challenge_id])).rows[0].evidence_sha256,null);
   const legacyEventId=await inbound(oldChallenge);
   assert.deepEqual(await challengePort.confirm_verified_event({...oldTarget,event_id:legacyEventId}),{status:'stale'});
   assert.equal((await a.query('SELECT count(*)::int n FROM core_confirmations WHERE order_id=$1',[oldId])).rows[0].n,0);
   await cancel(id);
  });
  await t.test('two pools compete on same digest, exactly one approval/job',async()=>{
   const id=await make('race');await confirm(id);
   const rs=await Promise.allSettled([approve(id,A),approve(id,B)]);
   assert.equal(rs.filter(x=>x.status==='fulfilled').length,1);
   assert.equal(rs.filter(x=>x.status==='rejected'&&x.reason.code==='ALREADY_APPROVED').length,1);
   assert.equal(await jobCount(id),1);
   const binding=(await a.query(
    'SELECT a.evidence_sha256 AS approved,j.evidence_sha256 AS job FROM core_approvals a JOIN core_print_jobs j ON j.approval_id=a.id WHERE j.order_id=$1',[id])).rows[0];
   assert.match(binding.approved,/^[0-9a-f]{64}$/);assert.equal(binding.approved,binding.job);
   const audit=(await a.query("SELECT details FROM core_audit WHERE action='print.approved' AND order_id=$1",[id])).rows[0];
   assert.match(audit.details.evidence_sha256,/^[0-9a-f]{64}$/);
   await cancel(id);
  });
  await t.test('source/manifest/settings/preview/renderer/capability changed after approval blocks claim with no extra job',async()=>{
   for(const part of ['source','manifest','settings','preview','renderer','capability']){
    const id=await make('before-claim-'+part);await confirm(id);await approve(id);
    states.get(id)[part]+='-changed';
    assert.equal((await A.getOrder(staff,id)).current.staff_approved,false);
    await assert.rejects(A.claim(agent,{printer_id:'RMP7000',idempotency_key:key('claim')}),error('STALE_PRINT_EVIDENCE'));
    assert.equal((await a.query('SELECT state FROM core_print_jobs WHERE order_id=$1',[id])).rows[0].state,'NOT_SENT');
    assert.equal(await jobCount(id),1);
    await cancel(id);
   }
  });
  await t.test('legacy NULL evidence cannot confirm, approve, claim, preflight or mark sending',async()=>{
   const legacy=new OrderService(new PgStore(a),()=>new Date());
   const confirmationId=await make('legacy-confirmation');
   await legacy.confirm(customer,confirmationId,{expected_revision:2,kind:'request',idempotency_key:key('legacy-confirm')});
   assert.equal((await a.query("SELECT evidence_sha256 FROM core_confirmations WHERE order_id=$1",[confirmationId])).rows[0].evidence_sha256,null);
   await assert.rejects(approve(confirmationId),error('STALE_PRINT_EVIDENCE'));
   assert.equal((await a.query('SELECT count(*)::int n FROM core_approvals WHERE order_id=$1',[confirmationId])).rows[0].n,0);
   assert.equal(await jobCount(confirmationId),0);

   const jobOrder=await make('legacy-job');
   await legacy.confirm(customer,jobOrder,{expected_revision:2,kind:'request',idempotency_key:key('legacy-job-confirm')});
   const oldApproval=await legacy.approve(staff,jobOrder,{expected_revision:2,acknowledge_deposit_shortage:true,idempotency_key:key('legacy-job-approve')});
   const old=(await a.query('SELECT a.evidence_sha256 approval,j.evidence_sha256 job FROM core_approvals a JOIN core_print_jobs j ON j.approval_id=a.id WHERE j.id=$1',[oldApproval.job_id])).rows[0];
   assert.equal(old.approval,null);assert.equal(old.job,null);
   await assert.rejects(A.claim(agent,{printer_id:'RMP7000',idempotency_key:key('legacy-claim')}),error('STALE_PRINT_EVIDENCE'));
   assert.equal((await a.query('SELECT state FROM core_print_jobs WHERE id=$1',[oldApproval.job_id])).rows[0].state,'NOT_SENT');
   const lease='legacy-null-test-lease';
   await a.query("UPDATE core_print_jobs SET claimed_by=$2,lease_secret_hash=$3,lease_until=now()+interval '60 seconds' WHERE id=$1",
    [oldApproval.job_id,agent.id,sha(lease)]);
   await assert.rejects(A.preflight(agent,oldApproval.job_id,{expected_revision:2,lease_token:lease}),error('STALE_PRINT_EVIDENCE'));
   await assert.rejects(A.markSending(agent,oldApproval.job_id,{expected_revision:2,lease_token:lease,idempotency_key:key('legacy-send')}),error('STALE_PRINT_EVIDENCE'));
   assert.equal((await a.query('SELECT state FROM core_print_jobs WHERE id=$1',[oldApproval.job_id])).rows[0].state,'NOT_SENT');
   await cancel(jobOrder);
  });
  await t.test('preflight and mark-sending both recheck the current evidence',async()=>{
   const id=await make('before-send');await confirm(id);const approved=await approve(id);
   const claim=(await A.claim(agent,{printer_id:'RMP7000',idempotency_key:key('lease')})).job;
   assert.equal(claim.job_id,approved.job_id);
   states.get(id).preview+='-after-lease';
   await assert.rejects(B.preflight(agent,claim.job_id,{expected_revision:2,lease_token:claim.lease_token}),error('STALE_PRINT_EVIDENCE'));
   await assert.rejects(B.markSending(agent,claim.job_id,{expected_revision:2,lease_token:claim.lease_token,
    idempotency_key:key('sending')}),error('STALE_PRINT_EVIDENCE'));
   assert.equal((await a.query('SELECT state FROM core_print_jobs WHERE id=$1',[claim.job_id])).rows[0].state,'NOT_SENT');
   await cancel(id);
  });
  await t.test('ambiguous ACK stays UNKNOWN; no automatic second job or provider call',async()=>{
   const id=await make('lost-ack');await confirm(id);const approved=await approve(id);
   const lease=(await A.claim(agent,{printer_id:'RMP7000',idempotency_key:key('lease')})).job;
   assert.equal((await B.markSending(agent,approved.job_id,{expected_revision:2,lease_token:lease.lease_token,
    idempotency_key:key('send-once')})).state,'SENDING');
   await A.markUnknownForReconciliation(staff,approved.job_id,{reason:'fake ACK lost',idempotency_key:key('unknown')});
   states.get(id).manifest+='-after-ack';
   assert.equal((await a.query('SELECT state FROM core_print_jobs WHERE id=$1',[approved.job_id])).rows[0].state,'UNKNOWN');
   assert.equal((await B.claim(agent,{printer_id:'RMP7000',idempotency_key:key('reclaim')})).job,null);
   assert.equal(await jobCount(id),1);
  });
  console.log('PASS V1-CORE-02 real PostgreSQL evidence fake port (NO REAL FILE/DRIVER/NETWORK)');
 }finally{await Promise.all([a.end(),b.end()]);}
});
