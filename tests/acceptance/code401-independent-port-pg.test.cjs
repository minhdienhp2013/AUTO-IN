const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID,randomBytes}=require('node:crypto');
const root=process.env.AI1_BUILD_DIR||path.resolve(__dirname,'../../dist/backend');
// Keep all product Core imports behind integration mode. Browser-only builds
// web/ but NOT dist/backend; loading Core at module initialization would turn
// a legitimate PG-only SKIP into a false Chromium job failure.
const integrationMode=process.env.AUTOIN_RUN_PRODUCT_ACCEPTANCE==='1';
const {PgStore,OrderService,createVerifiedConfirmationPort}=integrationMode?{
  PgStore:require(path.join(root,'storage/database.js')).PgStore,
  OrderService:require(path.join(root,'core/service.js')).OrderService,
  createVerifiedConfirmationPort:require(path.join(root,'core/verified-confirmation-port.js')).createVerifiedConfirmationPort
}:{PgStore:null,OrderService:null,createVerifiedConfirmationPort:null};
let pg;try{pg=require('pg');}catch{/* AI0 owns deps */}
const url=process.env.TEST_DATABASE_URL;
const ready=Boolean(pg&&url&&integrationMode);
const uuid=()=>randomUUID();
const k=p=>p+'-'+uuid();
const principal=(shop,id)=>({id,shop_id:shop,role:'staff',verified:true});

// Synthetic postback: this fixture stands for an AI0-verified, explicitly accepted
// provider BUTTON. It is NOT evidence that Zalo's live signature verification works.
async function inbound(pool,oa,conv,customer,eventId,challenge,opts={}) {
 const postback=challenge?{kind:opts.kind??'verified_confirmation_accept',challenge_id:challenge.challenge_id,
   challenge_token:opts.token??challenge.challenge_token}:undefined;
 const payload=postback?{kind:'postback',confirmation_postback:postback}:{kind:'text',text:'OK'};
 await pool.query(`INSERT INTO zalo_inbound_events(oa_id,event_id,conversation_id,customer_id,occurred_at,payload_json)
   VALUES($1,$2,$3,$4,now(),$5::jsonb)`,[oa,eventId,conv,customer,JSON.stringify(payload)]);
}
const count=async(pool,table,orderId)=>Number((await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE order_id=$1`,[orderId])).rows[0].n);

test('AI5 independent CODE-401: actual integrated Core PG receipt time, strict postback, 2 workers, ACK replay and staff approve',
 {skip:!ready&&'NOT RUN in browser/HTTP mode: requires --integration, dist/backend and real isolated PostgreSQL'},async()=>{
 const a=new pg.Pool({connectionString:url,max:6});
 const b=new pg.Pool({connectionString:url,max:6});
 try{
  const db=(await a.query('SELECT current_database() name')).rows[0].name;
  assert.match(db,/test/i,'Never run on production DB');
  const [pidA,pidB]=await Promise.all([a.query('SELECT pg_backend_pid() pid'),b.query('SELECT pg_backend_pid() pid')]);
  assert.notEqual(pidA.rows[0].pid,pidB.rows[0].pid);
  await a.query(fs.readFileSync(path.resolve(__dirname,'../../backend/storage/migrations/006_verified_confirmation.sql'),'utf8'));
  const shop=k('confirm-shop'),oa=k('confirm-oa'),conv=k('confirm-conv'),customer=k('confirm-customer');
  const staffId=uuid();
  await a.query('INSERT INTO core_shop_settings(shop_id) VALUES($1)',[shop]);
  await a.query("INSERT INTO core_users(id,shop_id,username,password_hash,role) VALUES($1,$2,'staff','synthetic-test-hash','staff')",[staffId,shop]);
  const staff=principal(shop,staffId),service=new OrderService(new PgStore(a));
  const portA=createVerifiedConfirmationPort({store:new PgStore(a),trusted:{shop_id:shop,oa_id:oa}});
  const portB=createVerifiedConfirmationPort({store:new PgStore(b),trusted:{shop_id:shop,oa_id:oa}});
  const draft=await service.createDraft(staff,{customer_id:customer,conversation_id:conv,
    request_data:{files:[{file_id:'fixture/public/a4.pdf',copies:151,format:'pdf'}]},idempotency_key:k('draft')});
  const processor={id:'verified-processor',shop_id:shop,role:'processor',verified:true};
  const plan={request_hash:draft.request_hash,physical_sheets:151,document_pages:151,
   printed_faces:151,ready:true,printer_id:'RMP7000',artifact_ref:'fixture-only',verified_by:processor.id};
  await service.publishVerifiedPlan(processor,draft.order_id,{expected_revision:1,plan,idempotency_key:k('plan')});
  const target={order_id:draft.order_id,expected_revision:2,request_hash:draft.request_hash,
   kind:'request',expected_generation:0};
  await assert.rejects(service.approve(staff,draft.order_id,{expected_revision:2,acknowledge_deposit_shortage:true,
    idempotency_key:k('approve-before')}),e=>e.code==='CUSTOMER_NOT_CONFIRMED');
  const challenge=await portA.issue_challenge(target);
  assert.equal(challenge.status,'issued');
  assert.equal(await count(a,'core_confirmations',draft.order_id),0,'Issuing a challenge cannot confirm');
  const noClick=k('plain-OK');await inbound(a,oa,conv,customer,noClick,null);
  await assert.rejects(portA.confirm_verified_event({...target,event_id:noClick}),e=>e.code==='CONFIRMATION_CHALLENGE_REQUIRED');
  const wrongCustomer=k('wrong-customer');await inbound(a,oa,conv,'wrong-customer',wrongCustomer,challenge);
  await assert.rejects(portA.confirm_verified_event({...target,event_id:wrongCustomer}),e=>e.code==='UNVERIFIED_CONFIRMATION_EVENT');
  const wrongOa=k('wrong-oa');await inbound(a,'other-'+oa,conv,customer,wrongOa,challenge);
  await assert.rejects(portB.confirm_verified_event({...target,event_id:wrongOa}),e=>e.code==='UNVERIFIED_CONFIRMATION_EVENT');
  const wrongSecret=k('wrong-token');await inbound(a,oa,conv,customer,wrongSecret,challenge,{token:randomBytes(32).toString('base64url')});
  await assert.rejects(portA.confirm_verified_event({...target,event_id:wrongSecret}),e=>e.code==='CONFIRMATION_CHALLENGE_MISMATCH');
  // A text event, malformed evidence, and a received-before-issue event
  // cannot be promoted to acceptance merely by holding the right token.
  const disguised=k('text-disguised');await inbound(a,oa,conv,customer,disguised,challenge);
  await a.query("UPDATE zalo_inbound_events SET payload_json=jsonb_set(payload_json,'{kind}','\"text\"'::jsonb) WHERE oa_id=$1 AND event_id=$2",
   [oa,disguised]);
  await assert.rejects(portA.confirm_verified_event({...target,event_id:disguised}),
   e=>e.code==='CONFIRMATION_CHALLENGE_REQUIRED');
  const smuggled=k('extra-field');await inbound(a,oa,conv,customer,smuggled,challenge);
  await a.query("UPDATE zalo_inbound_events SET payload_json=jsonb_set(payload_json,'{confirmation_postback,forged}','true'::jsonb) WHERE oa_id=$1 AND event_id=$2",
   [oa,smuggled]);
  await assert.rejects(portA.confirm_verified_event({...target,event_id:smuggled}),
   e=>e.code==='CONFIRMATION_CHALLENGE_REQUIRED');
  const unsupported=k('unsupported-unverified');await inbound(a,oa,conv,customer,unsupported,challenge);
  await a.query("UPDATE zalo_inbound_events SET payload_json=jsonb_set(payload_json,'{kind}','\"unsupported\"'::jsonb) WHERE oa_id=$1 AND event_id=$2",
   [oa,unsupported]);
  await assert.rejects(portA.confirm_verified_event({...target,event_id:unsupported}),
   e=>e.code==='CONFIRMATION_CHALLENGE_REQUIRED',
   'unsupported non-HMAC fixture marker cannot assert customer acceptance');
  const early=k('early-receipt');await inbound(a,oa,conv,customer,early,challenge);
  await a.query("UPDATE zalo_inbound_events SET received_at=(SELECT created_at-interval '1 second' FROM core_confirmation_challenges WHERE id=$1) WHERE oa_id=$2 AND event_id=$3",
   [challenge.challenge_id,oa,early]);
  // AI5 independent regression: make the provider-claimed occurred_at appear
  // safely AFTER the challenge was issued, while the trusted DB received_at
  // remains BEFORE issuance. The Core gate must use PostgreSQL receipt time.
  await a.query("UPDATE zalo_inbound_events SET occurred_at=(SELECT created_at+interval '1 second' FROM core_confirmation_challenges WHERE id=$1) WHERE oa_id=$2 AND event_id=$3",
   [challenge.challenge_id,oa,early]);
  await assert.rejects(portA.confirm_verified_event({...target,event_id:early}),
   e=>e.code==='CONFIRMATION_EVENT_OUTSIDE_CHALLENGE');
  assert.equal(await count(a,'core_confirmations',draft.order_id),0,
   'Forged provider occurred_at after challenge cannot override pre-issue DB receipt');
  assert.equal(await count(a,'core_print_jobs',draft.order_id),0);
  const late=k('late-receipt');await inbound(b,oa,conv,customer,late,challenge);
  await a.query("UPDATE zalo_inbound_events SET received_at=(SELECT expires_at+interval '1 second' FROM core_confirmation_challenges WHERE id=$1) WHERE oa_id=$2 AND event_id=$3",
   [challenge.challenge_id,oa,late]);
  await assert.rejects(portB.confirm_verified_event({...target,event_id:late}),
   e=>e.code==='CONFIRMATION_EVENT_OUTSIDE_CHALLENGE');
  assert.equal(await count(a,'core_confirmations',draft.order_id),0);
  assert.equal(await count(a,'core_print_jobs',draft.order_id),0);
  const event=k('confirm-event');await inbound(a,oa,conv,customer,event,challenge);
  assert.deepEqual(await portA.confirm_verified_event({...target,expected_revision:1,event_id:event}),{status:'stale'});
  assert.deepEqual(await portA.confirm_verified_event({...target,request_hash:'f'.repeat(64),event_id:event}),{status:'stale'});
  const wrongPort=createVerifiedConfirmationPort({store:new PgStore(b),trusted:{shop_id:k('other-shop'),oa_id:oa}});
  await assert.rejects(wrongPort.confirm_verified_event({...target,event_id:event}),e=>e.code==='CONFIRMATION_SCOPE_DENIED');
  const [r1,r2]=await Promise.all([
   portA.confirm_verified_event({...target,event_id:event}),portB.confirm_verified_event({...target,event_id:event})
  ]);
  assert.deepEqual([r1.status,r2.status].sort(),['confirmed','existing']);
  assert.equal(r1.confirmation_id,r2.confirmation_id,'Lost ACK must return same DB confirmation');
  assert.equal(await count(a,'core_confirmations',draft.order_id),1);
  assert.equal(await count(a,'core_print_jobs',draft.order_id),0,'Customer confirmation does not create print job');
  assert.equal(await count(a,'core_approvals',draft.order_id),0,'Customer confirmation does not approve');
  const secondEvent=k('replay');await inbound(a,oa,conv,customer,secondEvent,challenge);
  await assert.rejects(portA.confirm_verified_event({...target,event_id:secondEvent}),e=>e.code==='CONFIRMATION_REPLAY');
  await assert.rejects(service.approve(staff,draft.order_id,{expected_revision:2,
    acknowledge_deposit_shortage:true,idempotency_key:k('no-quote')}),e=>e.code==='QUOTE_REQUIRED');
  const quote=await service.setQuote(staff,draft.order_id,{expected_revision:2,amount_vnd:40000,
    deposit_required_vnd:12000,significant_cost:false,idempotency_key:k('quote')});
  assert.equal(quote.quote_revision,1);
  const quoteTarget={...target,kind:'quote',quote_revision:1};
  assert.deepEqual(await portA.issue_challenge({...quoteTarget,quote_revision:99}),{status:'stale'});
  const quoteChallenge=await portA.issue_challenge(quoteTarget);assert.equal(quoteChallenge.status,'issued');
  await assert.rejects(service.approve(staff,draft.order_id,{expected_revision:2,quote_revision:1,
    acknowledge_deposit_shortage:true,idempotency_key:k('no-price')}),e=>e.code==='PRICE_CONFIRMATION_REQUIRED');
  const qEvent=k('quote-confirm');await inbound(a,oa,conv,customer,qEvent,quoteChallenge);
  const qConfirmation=await portB.confirm_verified_event({...quoteTarget,event_id:qEvent});
  assert.equal(qConfirmation.status,'confirmed');
  assert.equal(await count(a,'core_confirmations',draft.order_id),2);
  assert.equal(await count(a,'core_print_jobs',draft.order_id),0);
  // Challenge issued before approval must not become a late NEW confirmation.
  const outstanding=await portB.issue_challenge(quoteTarget);
  assert.equal(outstanding.status,'issued');
  const approved=await service.approve(staff,draft.order_id,{expected_revision:2,quote_revision:1,
    acknowledge_deposit_shortage:true,idempotency_key:k('staff-only-approve')});
  assert.equal(approved.deposit_short_vnd,12000);
  assert.equal(await count(a,'core_print_jobs',draft.order_id),1);
  assert.deepEqual(await portA.issue_challenge(target),{status:'stale'},
   'no fresh customer request challenge after staff approval');
  assert.deepEqual(await portB.issue_challenge(quoteTarget),{status:'stale'},
   'no fresh quote challenge after staff approval');
  const lateEvent=k('late-postback');await inbound(b,oa,conv,customer,lateEvent,outstanding);
  assert.deepEqual(await portB.confirm_verified_event({...quoteTarget,event_id:lateEvent}),
   {status:'stale'},'outstanding postback cannot mint confirmation after approval');
  assert.equal(await count(a,'core_confirmations',draft.order_id),2);
  const committedRetry=await portB.confirm_verified_event({...target,event_id:event});
  assert.equal(committedRetry.status,'existing','loss of ACK remains idempotent after approval');
  assert.equal(committedRetry.confirmation_id,r1.confirmation_id);
  assert.equal(await count(a,'core_confirmations',draft.order_id),2);
  assert.equal(await count(a,'core_print_jobs',draft.order_id),1);

  const fresh=await service.createDraft(staff,{customer_id:customer,conversation_id:conv,
   request_data:{title:'stale-after-revise'},idempotency_key:k('fresh-draft')});
  const stale={order_id:fresh.order_id,expected_revision:1,request_hash:fresh.request_hash,kind:'request',expected_generation:0};
  const oldChallenge=await portA.issue_challenge(stale);assert.equal(oldChallenge.status,'issued');
  await service.revise(staff,fresh.order_id,{expected_revision:1,request_data:{title:'new-revision'},idempotency_key:k('revise')});
  const staleEvent=k('stale-revision');await inbound(a,oa,conv,customer,staleEvent,oldChallenge);
  assert.deepEqual(await portB.confirm_verified_event({...stale,event_id:staleEvent}),{status:'stale'});
  assert.equal(await count(a,'core_confirmations',fresh.order_id),0);
  // A handover before response makes a once-valid challenge stale, even after ACK loss.
  const another=await service.createDraft(staff,{customer_id:customer,conversation_id:conv,
    request_data:{title:'handover'},idempotency_key:k('another-draft')});
  const takeTarget={order_id:another.order_id,expected_revision:1,request_hash:another.request_hash,kind:'request',expected_generation:0};
  const handChallenge=await portA.issue_challenge(takeTarget);assert.equal(handChallenge.status,'issued');
  const handEvent=k('handover-event');await inbound(a,oa,conv,customer,handEvent,handChallenge);
  await service.handover(staff,conv,{expected_generation:0,idempotency_key:k('handover')});
  assert.deepEqual(await portA.confirm_verified_event({...takeTarget,event_id:handEvent}),{status:'stale'});
  assert.equal(await count(a,'core_confirmations',another.order_id),0);
 }finally{await Promise.all([a.end(),b.end()]);}
});
