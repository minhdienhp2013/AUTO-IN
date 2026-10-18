const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const root=process.env.AI1_BUILD_DIR||path.resolve(__dirname,'../../../.ai1-build/backend');
const {createCoreModule}=require(path.join(root,'core/factory.js'));
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
  await a.query(fs.readFileSync(path.resolve(__dirname,'../../../backend/storage/migrations/011_print_evidence_binding.sql'),'utf8'));
  await a.query(fs.readFileSync(path.resolve(__dirname,'../../../backend/storage/migrations/012_preview_review_receipts.sql'),'utf8'));
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
   if(state.failVerifier)throw new Error('synthetic verifier unavailable');
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
  // Exercise the same factory entry that AI0 will use for product V1 wiring.
  const A=createCoreModule({pool:a,mode:'v1',evidence:fakePort}).service;
  const B=createCoreModule({pool:b,mode:'v1',evidence:fakePort}).service;
  const evidenceFor=async orderId=>{
   const row=(await a.query('SELECT shop_id,active_revision FROM core_orders WHERE id=$1',[orderId])).rows[0];
   const rev=(await a.query('SELECT request_hash,plan FROM core_revisions WHERE order_id=$1 AND revision=$2',[orderId,row.active_revision])).rows[0];
   const state=states.get(orderId);
   const sources=[{source_artifact_ref:'fixture/source.pdf',format:'pdf',size_bytes:10,source_sha256:sha(state.source)}];
   const body={schema:'ai0.print_evidence.v1',shop_id:row.shop_id,order_id:orderId,
    revision:row.active_revision,request_hash:rev.request_hash,sources,
    source_set_sha256:sha(canonical(sources)),settings_sha256:sha(state.settings),
    manifest_ref:'fixture/manifest',manifest_sha256:sha(state.manifest),
    previews:[{index:0,bytes:300,sha256:sha(state.preview)}],renderer_sha256:sha(state.renderer),
    plan_sha256:sha(canonical(rev.plan)),printer_id:rev.plan.printer_id,
    printer_capability_sha256:sha(state.capability)};
   return sha(canonical(body));
  };
  const review=(id,service=A,actor=staff,override={})=>a.query(
   'SELECT active_revision FROM core_orders WHERE id=$1',[id]).then(async order=>{
    const rev=(await a.query('SELECT request_hash FROM core_revisions WHERE order_id=$1 AND revision=$2',[id,order.rows[0].active_revision])).rows[0];
    return service.reviewPreview(actor,id,{expected_revision:order.rows[0].active_revision,
     expected_request_hash:rev.request_hash,expected_evidence_sha256:await evidenceFor(id),
     decision:'checked',idempotency_key:key('preview-review'),...override});
   });
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
  const confirm=async id=>{await review(id);return A.confirm(customer,id,{expected_revision:2,kind:'request',idempotency_key:key('confirm')});};
  const approve=(id,service=A)=>service.approve(staff,id,{expected_revision:2,
   acknowledge_deposit_shortage:true,idempotency_key:key('approve')});
  const jobCount=async id=>Number((await a.query('SELECT count(*)::int n FROM core_print_jobs WHERE order_id=$1',[id])).rows[0].n);
  const cancel=async id=>a.query("UPDATE core_print_jobs SET cancelled_at=now() WHERE order_id=$1 AND state='NOT_SENT'",[id]);
  const waitForOrderLockWaiters=async minimum=>{
   const deadline=Date.now()+5000;
   while(Date.now()<deadline){
    const waiting=Number((await a.query(
     "SELECT count(*)::int n FROM pg_stat_activity WHERE wait_event_type='Lock' AND state='active' AND query LIKE '%core_orders%FOR UPDATE%'"
    )).rows[0].n);
    if(waiting>=minimum)return;
    await new Promise(resolve=>setTimeout(resolve,10));
   }
   throw new Error(`Timed out waiting for ${minimum} Core order-lock waiters`);
  };
  await t.test('missing/stale/wrong-scope review blocks every confirmation/approval path with zero writes',async()=>{
   const conv=key('missing-review-conv'),id=await make('missing-review',conv);
   const challengePort=createVerifiedConfirmationPort({store:new PgStore(b),trusted:{shop_id:shop,oa_id:key('missing-review-oa')},evidence:fakePort});
   const requestHash=(await a.query('SELECT request_hash FROM core_revisions WHERE order_id=$1 AND revision=2',[id])).rows[0].request_hash;
   const target={order_id:id,expected_revision:2,request_hash:requestHash,kind:'request',expected_generation:0};
   await assert.rejects(A.confirm(customer,id,{expected_revision:2,kind:'request',idempotency_key:key('no-review-confirm')}),error('PREVIEW_REVIEW_REQUIRED'));
   await assert.rejects(approve(id),error('PREVIEW_REVIEW_REQUIRED'));
   await assert.rejects(challengePort.issue_challenge(target),error('PREVIEW_REVIEW_REQUIRED'));
   const counts=await a.query('SELECT '+
    '(SELECT count(*)::int FROM core_confirmation_challenges WHERE order_id=$1) challenges,'+
    '(SELECT count(*)::int FROM core_confirmations WHERE order_id=$1) confirmations,'+
    '(SELECT count(*)::int FROM core_approvals WHERE order_id=$1) approvals,'+
    '(SELECT count(*)::int FROM core_print_jobs WHERE order_id=$1) jobs',[id]);
   assert.deepEqual(counts.rows[0],{challenges:0,confirmations:0,approvals:0,jobs:0});
   const wrongScope={...staff,shop_id:key('wrong-shop')};
   await assert.rejects(review(id,A,wrongScope),error('FORBIDDEN'));
   assert.equal(await count(a,'core_preview_review_receipts',id),0);
   const currentEvidence=await evidenceFor(id);
   await assert.rejects(A.reviewPreview(staff,id,{expected_revision:2,expected_request_hash:requestHash,
    expected_evidence_sha256:sha('wrong-evidence'),decision:'checked',idempotency_key:key('stale-evidence')}),error('STALE_PRINT_EVIDENCE'));
   await assert.rejects(A.reviewPreview(staff,id,{expected_revision:2,expected_request_hash:sha('wrong-request'),
    expected_evidence_sha256:currentEvidence,decision:'checked',idempotency_key:key('stale-request')}),error('STALE_REQUEST_HASH'));
   assert.equal(await count(a,'core_preview_review_receipts',id),0);
   const historical=await make('review-cannot-authorize-old-confirmation');
   const historicalProof=await evidenceFor(historical),historicalId=uid();
   await a.query(`INSERT INTO core_confirmations
    (id,order_id,revision,request_hash,kind,customer_id,channel,evidence_sha256,created_at)
    VALUES($1,$2,2,$3,'request',$4,'verified_credential',$5,now()-interval '1 minute')`,
    [historicalId,historical,requestHash,customerId,historicalProof]);
   await a.query(`INSERT INTO core_audit(id,shop_id,actor_id,action,order_id,details,created_at)
    VALUES($1,$2,$3,'customer.confirmed',$4,$5::jsonb,now()-interval '1 minute')`,
    [uid(),shop,'synthetic-old-customer',historical,JSON.stringify({confirmation_id:historicalId,evidence_sha256:historicalProof})]);
   await review(historical);
   await assert.rejects(approve(historical),error('PREVIEW_REVIEW_REQUIRED'));
   assert.equal(await count(a,'core_approvals',historical),0);
   assert.equal(await count(a,'core_print_jobs',historical),0);
  });
  await t.test('review receipt binds exact snapshot and idempotent replay/conflict',async()=>{
   const id=await make('review-idempotency');
   const order=(await a.query('SELECT active_revision FROM core_orders WHERE id=$1',[id])).rows[0];
   const rev=(await a.query('SELECT request_hash FROM core_revisions WHERE order_id=$1 AND revision=$2',[id,order.active_revision])).rows[0];
   const payload={expected_revision:order.active_revision,expected_request_hash:rev.request_hash,
    expected_evidence_sha256:await evidenceFor(id),decision:'checked',idempotency_key:key('same-review')};
   const first=await A.reviewPreview(staff,id,payload),replayed=await A.reviewPreview(staff,id,payload);
   assert.equal(replayed.receipt_id,first.receipt_id);
   assert.equal(await count(a,'core_preview_review_receipts',id),1);
   await assert.rejects(A.reviewPreview(staff,id,{...payload,expected_evidence_sha256:sha('different')}),error('IDEMPOTENCY_CONFLICT'));
   assert.equal(await count(a,'core_preview_review_receipts',id),1);
   const view=await A.getOrder(staff,id);
   assert.deepEqual(view.current.print_evidence,{schema:'ai0.print_evidence.v1',order_id:id,
    revision:order.active_revision,request_hash:rev.request_hash,evidence_sha256:payload.expected_evidence_sha256});
   assert.equal(view.current.preview_review.status,'matching');
   assert.equal(view.current.preview_review.receipt_id,first.receipt_id);
   states.get(id).preview+='-changed-after-review';
   const stale=await A.getOrder(staff,id);
   assert.equal(stale.current.preview_review.status,'stale');
   assert.equal(stale.current.preview_review.evidence_sha256,(await evidenceFor(id)));
  });
  await t.test('Word REVIEW_REQUIRED and ready=false plans block confirmation and approval with zero writes',async()=>{
   for(const [label,mutation] of [
    ['explicit-review-required',{status:'REVIEW_REQUIRED'}],
    ['not-ready',{ready:false}]
   ]){
    const id=await make('word-'+label);
    await a.query('UPDATE core_revisions SET plan=plan || $2::jsonb WHERE order_id=$1 AND revision=2',
     [id,JSON.stringify(mutation)]);
    await assert.rejects(A.confirm(customer,id,{expected_revision:2,kind:'request',
     idempotency_key:key('word-confirm-'+label)}),error('UNTRUSTED_PLAN'));
    await assert.rejects(approve(id),error('UNTRUSTED_PLAN'));
    const counts=await a.query('SELECT '+
     '(SELECT count(*)::int FROM core_preview_review_receipts WHERE order_id=$1) reviews,'+
     '(SELECT count(*)::int FROM core_confirmations WHERE order_id=$1) confirmations,'+
     '(SELECT count(*)::int FROM core_approvals WHERE order_id=$1) approvals,'+
     '(SELECT count(*)::int FROM core_print_jobs WHERE order_id=$1) jobs',[id]);
    assert.deepEqual(counts.rows[0],{reviews:0,confirmations:0,approvals:0,jobs:0});
    const outboxTable=(await a.query("SELECT to_regclass('public.core_tn005_suggested_outbox') AS relation")).rows[0].relation;
    if(outboxTable){
     const outbox=await a.query('SELECT count(*)::int n FROM core_tn005_suggested_outbox WHERE order_id=$1',[id]);
     assert.equal(outbox.rows[0].n,0);
    }
   }
  });
  await t.test('confirmation pins evidence; source/manifest/settings/preview drift blocks approval',async()=>{
   for(const part of ['source','manifest','settings','preview']){
    const id=await make('before-approve-'+part);await confirm(id);
    const column=(await a.query("SELECT evidence_sha256 FROM core_confirmations WHERE order_id=$1 AND kind='request'",[id])).rows[0];
    assert.match(column.evidence_sha256,/^[0-9a-f]{64}$/);
    const audit=(await a.query("SELECT details FROM core_audit WHERE action='customer.confirmed' AND order_id=$1",[id])).rows[0];
    assert.equal(audit.details.evidence_sha256,column.evidence_sha256);
    states.get(id)[part]+='-changed';
    assert.equal((await A.getOrder(staff,id)).current.request_confirmed,false);
    await assert.rejects(approve(id),error('PREVIEW_REVIEW_REQUIRED'));
    assert.equal(await jobCount(id),0);
   }
  });
  await t.test('factory-injected verifier errors fail closed at confirmation, approval and send gates',async()=>{
   const id=await make('verifier-outage');
   states.get(id).failVerifier=true;
   await assert.rejects(confirm(id),error('PRINT_EVIDENCE_UNAVAILABLE'));
   assert.equal((await a.query('SELECT count(*)::int n FROM core_confirmations WHERE order_id=$1',[id])).rows[0].n,0);

   states.get(id).failVerifier=false;
   await confirm(id);
   states.get(id).failVerifier=true;
   await assert.rejects(approve(id),error('PRINT_EVIDENCE_UNAVAILABLE'));
   assert.equal((await a.query('SELECT count(*)::int n FROM core_approvals WHERE order_id=$1',[id])).rows[0].n,0);
   assert.equal(await jobCount(id),0);

   states.get(id).failVerifier=false;
   const approved=await approve(id);
   const lease=(await A.claim(agent,{printer_id:'RMP7000',idempotency_key:key('outage-lease')})).job;
   assert.equal(lease.job_id,approved.job_id);
   states.get(id).failVerifier=true;
   await assert.rejects(B.preflight(agent,lease.job_id,{expected_revision:2,lease_token:lease.lease_token}),error('PRINT_EVIDENCE_UNAVAILABLE'));
   await assert.rejects(B.markSending(agent,lease.job_id,{expected_revision:2,lease_token:lease.lease_token,
    idempotency_key:key('outage-sending')}),error('PRINT_EVIDENCE_UNAVAILABLE'));
   assert.equal((await a.query('SELECT state FROM core_print_jobs WHERE id=$1',[lease.job_id])).rows[0].state,'NOT_SENT');
   await cancel(id);
  });

  await t.test('verified OA challenge binds evidence at issue and click, stale preview cannot confirm',async()=>{
   const conv=key('verified-conversation'),oa=key('oa'),id=await make('verified-oa',conv);
   const port={store:new PgStore(b),trusted:{shop_id:shop,oa_id:oa},evidence:fakePort};
   const challengePort=createVerifiedConfirmationPort(port);
   const hash=(await a.query('SELECT request_hash FROM core_revisions WHERE order_id=$1 AND revision=2',[id])).rows[0].request_hash;
   const target={order_id:id,expected_revision:2,request_hash:hash,kind:'request',expected_generation:0};
   await review(id);
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
   await assert.rejects(challengePort.confirm_verified_event({...target,event_id:oldEvent}),error('PREVIEW_REVIEW_REQUIRED'));
   assert.equal((await a.query('SELECT count(*)::int n FROM core_confirmations WHERE order_id=$1',[id])).rows[0].n,0);
   await review(id);
   await assert.rejects(challengePort.confirm_verified_event({...target,event_id:oldEvent}),error('PREVIEW_REVIEW_REQUIRED'));
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
  await t.test('revision wins queued order-lock race; stale customer confirmation creates no challenge, approval or job',async()=>{
   const conv=key('revision-race-conv'),id=await make('revision-wins-race',conv);
   await review(id);
   const requestHash=(await a.query(
    'SELECT request_hash FROM core_revisions WHERE order_id=$1 AND revision=2',[id])).rows[0].request_hash;
   const challengePort=createVerifiedConfirmationPort({store:new PgStore(b),
    trusted:{shop_id:shop,oa_id:key('revision-race-oa')},evidence:fakePort});
   const target={order_id:id,expected_revision:2,request_hash:requestHash,kind:'request',expected_generation:0};
   const lock=await a.connect();
   await lock.query('BEGIN');
   await lock.query('SELECT id FROM core_orders WHERE id=$1 FOR UPDATE',[id]);
   try{
    // Queue the legitimate revision mutation before stale confirmation consumers.
    const reviseRace=A.revise(staff,id,{expected_revision:2,
     request_data:{files:[{file_id:'fixture/revised-source.pdf',copies:1,format:'pdf'}],
      settings:{paper:'A4',duplex:false,copies:1}},idempotency_key:key('revision-race')});
    await waitForOrderLockWaiters(1);
    const confirmRace=assert.rejects(B.confirm(customer,id,
     {expected_revision:2,kind:'request',idempotency_key:key('stale-confirm-race')}),error('STALE_REVISION'));
    await waitForOrderLockWaiters(2);
    const challengeRace=challengePort.issue_challenge(target);
    await waitForOrderLockWaiters(3);
    await lock.query('COMMIT');
    await reviseRace;
    await confirmRace;
    assert.deepEqual(await challengeRace,{status:'stale'});
   }finally{
    await lock.query('ROLLBACK').catch(()=>{});
    lock.release();
   }
   await assert.rejects(approve(id),error('STALE_REVISION'));
   const writes=await a.query('SELECT '+
    '(SELECT count(*)::int FROM core_confirmation_challenges WHERE order_id=$1) challenges,'+
    '(SELECT count(*)::int FROM core_confirmations WHERE order_id=$1) confirmations,'+
    '(SELECT count(*)::int FROM core_approvals WHERE order_id=$1) approvals,'+
    '(SELECT count(*)::int FROM core_print_jobs WHERE order_id=$1) jobs',[id]);
   assert.deepEqual(writes.rows[0],{challenges:0,confirmations:0,approvals:0,jobs:0});
   const outboxTable=(await a.query("SELECT to_regclass('public.core_tn005_suggested_outbox') AS relation")).rows[0].relation;
   if(outboxTable){
    const outbox=await a.query('SELECT count(*)::int n FROM core_tn005_suggested_outbox WHERE order_id=$1',[id]);
    assert.equal(outbox.rows[0].n,0);
   }
  });
  await t.test('source/manifest/settings/preview changed after approval blocks claim with no extra job',async()=>{
   for(const part of ['source','manifest','settings','preview']){
    const id=await make('before-claim-'+part);await confirm(id);await approve(id);
    states.get(id)[part]+='-changed';
    assert.equal((await A.getOrder(staff,id)).current.staff_approved,false);
    await assert.rejects(A.claim(agent,{printer_id:'RMP7000',idempotency_key:key('claim')}),error('PREVIEW_REVIEW_REQUIRED'));
    assert.equal((await a.query('SELECT state FROM core_print_jobs WHERE order_id=$1',[id])).rows[0].state,'NOT_SENT');
    assert.equal(await jobCount(id),1);
    await cancel(id);
   }
  });
  await t.test('preflight and mark-sending both recheck the current evidence',async()=>{
   const id=await make('before-send');await confirm(id);const approved=await approve(id);
   const claim=(await A.claim(agent,{printer_id:'RMP7000',idempotency_key:key('lease')})).job;
   assert.equal(claim.job_id,approved.job_id);
   const preflight=await B.preflight(agent,claim.job_id,{expected_revision:2,lease_token:claim.lease_token});
   assert.equal(preflight.allowed,true);
   assert.deepEqual(Object.keys(preflight.review_receipt).sort(),[
    'receipt_id','shop_id','order_id','revision','request_hash','evidence_sha256',
    'reviewer_id','reviewed_at','decision'
   ].sort());
   assert.equal(preflight.review_receipt.decision,'checked');
   assert.equal(preflight.review_receipt.shop_id,shop);
   assert.equal(preflight.review_receipt.order_id,id);
   assert.equal(preflight.review_receipt.reviewer_id,staffId);
   assert.deepEqual(Object.keys(preflight.trusted_evidence).sort(),[
    'schema','shop_id','order_id','revision','request_hash','evidence_sha256',
    'settings_sha256','renderer_sha256','printer_capability_sha256','preview_sha256','printer_id'
   ].sort());
   assert.deepEqual(preflight.trusted_evidence.preview_sha256,[sha(states.get(id).preview)]);
   assert.deepEqual(preflight.trusted_job,{job_id:claim.job_id,shop_id:shop,order_id:id,
    revision:2,request_hash:preflight.review_receipt.request_hash,approval_id:approved.approval_id,
    printer_id:'RMP7000',evidence_sha256:preflight.review_receipt.evidence_sha256,
    mode:'simulation',state:'NOT_SENT'});
   const publicView=await A.getOrder(staff,id);
   assert.equal('review_receipt' in publicView,false);
   assert.equal('trusted_job' in publicView,false);
   states.get(id).preview+='-after-lease';
   await assert.rejects(B.preflight(agent,claim.job_id,{expected_revision:2,lease_token:claim.lease_token}),error('PREVIEW_REVIEW_REQUIRED'));
   await assert.rejects(B.markSending(agent,claim.job_id,{expected_revision:2,lease_token:claim.lease_token,
    idempotency_key:key('sending')}),error('PREVIEW_REVIEW_REQUIRED'));
   assert.equal((await a.query('SELECT state FROM core_print_jobs WHERE id=$1',[claim.job_id])).rows[0].state,'NOT_SENT');
   await cancel(id);
  });
  await t.test('Word REVIEW_REQUIRED after approval is blocked at preflight and send',async()=>{
   const id=await make('word-review-after-approval');await confirm(id);const approved=await approve(id);
   const claim=(await A.claim(agent,{printer_id:'RMP7000',idempotency_key:key('word-review-lease')})).job;
   assert.equal(claim.job_id,approved.job_id);
   await a.query("UPDATE core_revisions SET plan=plan || '{\"status\":\"REVIEW_REQUIRED\"}'::jsonb WHERE order_id=$1 AND revision=2",[id]);
   await assert.rejects(B.preflight(agent,claim.job_id,{expected_revision:2,lease_token:claim.lease_token}),error('UNTRUSTED_PLAN'));
   await assert.rejects(B.markSending(agent,claim.job_id,{expected_revision:2,lease_token:claim.lease_token,
    idempotency_key:key('word-review-send')}),error('UNTRUSTED_PLAN'));
   assert.equal((await a.query('SELECT state FROM core_print_jobs WHERE id=$1',[claim.job_id])).rows[0].state,'NOT_SENT');
   assert.equal(await jobCount(id),1);
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
