import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import pg from 'pg';
import {asSqlPool,assertIsolatedSimulationDatabase} from '../../backend/composition/postgres.ts';
import {createOfficialZaloWebhookPlugin} from '../../backend/composition/official-zalo-webhook.ts';
import {buildIntegratedApp} from '../../backend/composition/runtime.ts';
import {createCoreModule} from '../../backend/core/factory.ts';
import {passwordHash} from '../../backend/core/auth.ts';

const url=process.env.TEST_DATABASE_URL;
const unique=prefix=>prefix+'-'+randomUUID();
const signature=(raw,app,stamp,secret)=>'mac='+createHash('sha256')
 .update(app).update(raw).update(String(stamp)).update(secret).digest('hex');

test('AI5 PR66 independent CODE402: migrations 004/005, signed custody, owner audit/followup, 409 and inbound-first scope race',{
 skip:!url?'TEST_DATABASE_URL missing: official quarantine composition NOT RUN':false,
 timeout:120000
},async()=>{
 assertIsolatedSimulationDatabase(url);
 const a=new pg.Pool({connectionString:url,max:6});
 const b=new pg.Pool({connectionString:url,max:4});
 const shop=unique('official-shop'),oa=unique('official-oa'),appId=unique('official-app');
 const providerUser=unique('provider-user'),customer=unique('customer'),conversation=unique('conversation');
 const secret='synthetic-only-'+randomUUID()+randomUUID();
 const password='isolated-'+randomUUID(),core=createCoreModule({pool:asSqlPool(a)});
 let app,owner,ownerToken,orderIds=[];
 const reviewReceiptIds=[];
 async function makeOrder(label){
  const draft=await core.service.createDraft(owner,{
   customer_id:customer,conversation_id:conversation,
   request_data:{synthetic_manual_order:label},
   idempotency_key:unique('create')
  });
  orderIds.push(draft.order_id);
  const processor={id:unique('processor'),shop_id:shop,role:'processor',verified:true};
  await core.service.publishVerifiedPlan(processor,draft.order_id,{
   expected_revision:1,
   plan:{request_hash:draft.request_hash,ready:true,printer_id:'RMP7000',
    verified_by:processor.id,artifact_ref:'synthetic-only-fixture',
    document_pages:1,printed_faces:1,physical_sheets:1},
   idempotency_key:unique('plan')
  });
  await core.service.confirm({
   id:unique('customer-session'),shop_id:shop,customer_id:customer,
   role:'customer',verified:true
  },draft.order_id,{expected_revision:2,kind:'request',idempotency_key:unique('confirm')});
  return draft.order_id;
 }
 async function approval(orderId,key){
  return app.inject({method:'POST',url:'/api/v1/orders/'+orderId+'/approvals',
   headers:{authorization:'Bearer '+ownerToken},
   payload:{expected_revision:2,acknowledge_deposit_shortage:true,idempotency_key:key}});
 }
 async function postEvent(eventName,msgId,extra={}){
  const timestamp=Date.now();
  const raw=Buffer.from(JSON.stringify({
   app_id:appId,timestamp,event_name:eventName,
   sender:{id:providerUser},recipient:{id:oa},message:{msg_id:msgId,...extra}
  }));
  const response=await app.inject({method:'POST',url:'/webhooks/zalo',
   headers:{'content-type':'application/json','x-zevent-signature':signature(raw,appId,timestamp,secret)},
   payload:raw});
  return {response,raw};
 }
 try{
  // The actual isolated DB is prepared with npm run db:migrate in CI.
  // Assert BOTH migration artifacts exist and the production migration runner
  // applies AI2 004 before AI0 005. No fake/in-memory database substitute.
  const script=readFileSync(new URL('../../scripts/database.ts',import.meta.url),'utf8');
  // Demand 004 in the executed AI2 migration loop and 005 in AI0's
  // explicit readFile call. Merely finding filenames/comments is insufficient.
  const loopStart=script.indexOf('for (const file of [');
  const migrationA=script.indexOf("'004_official_quarantine.sql'",loopStart);
  const loopClose=script.indexOf('])',migrationA);
  const execAi2=script.indexOf('await connection.query(await readFile(new URL(',loopClose);
  const ai2Path=script.indexOf('`../backend/integrations/zalo/migrations/${file}`',execAi2);
  const migrationB=script.indexOf("await connection.query(await readFile(new URL('../backend/composition/migrations/005_official_zalo_quarantine.sql'");
  assert.ok(loopStart>0 && migrationA>loopStart && loopClose>migrationA &&
   execAi2>loopClose && ai2Path>execAi2 && migrationB>ai2Path,
   'Migration order regression: AI2 004 MUST precede AI0 005');
  const migrated=await a.query(
   "SELECT to_regclass('public.zalo_official_quarantine') quarantine,"+
   "to_regclass('public.zalo_official_quarantine_scopes') scopes,"+
   "to_regclass('public.ai0_official_zalo_oa_registry') registry,"+
   "to_regclass('public.ai0_official_quarantine_reviews') reviews");
  for(const [label,table] of Object.entries(migrated.rows[0]))
   assert.ok(table,'Missing migrated real PostgreSQL relation '+label);
  await a.query('INSERT INTO core_shop_settings(shop_id) VALUES($1)',[shop]);
  await core.auth.bootstrapOwner({shop_id:shop,username:'owner',password,bootstrap_enabled:true});
  const login=await core.auth.login(shop,'owner',password);
  owner=login.principal;ownerToken=login.token;
  // A real staff session is authenticated but must NEVER clear OA custody.
  const staffPass='synthetic-staff-'+randomUUID();
  const staffId=randomUUID();
  await a.query("INSERT INTO core_users(id,shop_id,username,password_hash,role) VALUES($1,$2,'worker',$3,'staff')",
   [staffId,shop,await passwordHash(staffPass)]);
  const staffLogin=await core.auth.login(shop,'worker',staffPass);
  const staffToken=staffLogin.token;

  await a.query(
   'INSERT INTO ai0_official_zalo_oa_registry(oa_id,app_id,shop_id,enabled) VALUES($1,$2,$3,true)',
   [oa,appId,shop]);
  await a.query(
   'INSERT INTO ai0_official_zalo_identity_map(oa_id,shop_id,provider_user_id,customer_id,conversation_id,verified_by) '+
   'VALUES($1,$2,$3,$4,$5,$6)',[oa,shop,providerUser,customer,conversation,owner.id]);

  const plugin=await createOfficialZaloWebhookPlugin(asSqlPool(a),{
   app_id:appId,oa_id:oa,oa_secret_key:secret
  });
  app=buildIntegratedApp({pool:asSqlPool(a),zaloWebhook:plugin});
  await app.ready();

  const text=await postEvent('user_send_text',unique('text'),{text:'OK',
   confirmation_postback:{kind:'verified_confirmation_accept',challenge_token:'untrusted-self-declared'}});
  assert.equal(text.response.statusCode,200,text.response.body);
  assert.equal(text.response.json().status,'accepted');
  assert.equal((await a.query('SELECT count(*)::int n FROM zalo_process_queue WHERE oa_id=$1',[oa])).rows[0].n,1);
  const persistedText=(await a.query(
   'SELECT payload_json FROM zalo_inbound_events WHERE oa_id=$1',[oa])).rows[0].payload_json;
  assert.equal(persistedText.confirmation_postback,undefined,
   'signed OK with self-declared confirmation_postback must be stripped');
  assert.equal((await a.query('SELECT count(*)::int n FROM zalo_confirmation_candidates WHERE oa_id=$1',[oa])).rows[0].n,0);
  assert.equal((await a.query('SELECT count(*)::int n FROM core_orders WHERE shop_id=$1',[shop])).rows[0].n,0,
   'plain OK cannot create a customer confirmation, new order, approval or print job');


  const image=await postEvent('user_send_image',unique('image'),{attachments:[{type:'image',url:'synthetic://fixture'}]});
  assert.equal(image.response.statusCode,200,image.response.body);
  assert.equal(image.response.json().status,'held');
  const receiptId=image.response.json().receipt_id;
  reviewReceiptIds.push(receiptId);
  let saved=await a.query(
   "SELECT status,customer_id,conversation_id,received_at FROM zalo_official_quarantine WHERE id=$1",[receiptId]);
  assert.equal(saved.rows[0].status,'NEEDS_HUMAN');
  assert.equal(saved.rows[0].customer_id,customer);
  assert.equal(saved.rows[0].conversation_id,conversation);
  assert.ok(saved.rows[0].received_at instanceof Date);
  const signedReplay=await app.inject({method:'POST',url:'/webhooks/zalo',
   headers:{'content-type':'application/json',
    'x-zevent-signature':signature(image.raw,appId,JSON.parse(image.raw.toString('utf8')).timestamp,secret)},
   payload:image.raw});
  assert.equal(signedReplay.statusCode,200);
  assert.equal(signedReplay.json().status,'duplicate');
  assert.equal(signedReplay.json().receipt_id,receiptId,'lost ACK must not mint another receipt');
  const countCustody=async()=>Number((await a.query(
   "SELECT count(*)::int n FROM zalo_official_quarantine WHERE oa_id=$1",[oa])).rows[0].n);
  assert.equal(await countCustody(),1);


  const bad=await app.inject({method:'POST',url:'/webhooks/zalo',
   headers:{'content-type':'application/json','x-zevent-signature':'mac='+'0'.repeat(64)},
   payload:image.raw});
  assert.equal(bad.statusCode,403);
  assert.equal((await a.query('SELECT count(*)::int n FROM zalo_official_quarantine WHERE oa_id=$1',[oa])).rows[0].n,1);
  const original=JSON.parse(image.raw.toString('utf8'));
  const foreignRaw=Buffer.from(JSON.stringify({...original,recipient:{id:'wrong-'+oa}}));
  const foreign=await app.inject({method:'POST',url:'/webhooks/zalo',headers:{
   'content-type':'application/json',
   'x-zevent-signature':signature(foreignRaw,appId,original.timestamp,secret)
  },payload:foreignRaw});
  assert.equal(foreign.statusCode,422,'valid MAC cannot override trusted OA scope');
  assert.equal(foreign.json().error.code,'INVALID_OFFICIAL_EVENT');
  assert.equal(await countCustody(),1,'wrong signature or OA must cause zero durable writes');
  assert.equal((await a.query('SELECT count(*)::int n FROM zalo_confirmation_candidates WHERE oa_id=$1',[oa])).rows[0].n,0,
    'candidate cannot be minted from an unsupported image or signed OK');


  const order1=await makeOrder('pending-gate');
  let rejected=await approval(order1,unique('approval'));
  assert.equal(rejected.statusCode,409,rejected.body);
  assert.equal(rejected.json().error.code,'PENDING_INBOUND_REVIEW');
  assert.equal((await a.query('SELECT count(*)::int n FROM core_approvals WHERE order_id=$1',[order1])).rows[0].n,0);
  assert.equal((await a.query('SELECT count(*)::int n FROM core_print_jobs WHERE order_id=$1',[order1])).rows[0].n,0);

  const reconcileUrl='/api/v1/official-zalo/quarantine/'+receiptId+'/reconcile';
  const followup={disposition:'NEEDS_FOLLOW_UP',note:'Synthetic document needs human clarification',
   idempotency_key:unique('followup')};
  const unauth=await app.inject({method:'POST',url:reconcileUrl,payload:followup});
  assert.equal(unauth.statusCode,401,'Anonymous users must never reconcile quarantine');
  const staffDenied=await app.inject({method:'POST',url:reconcileUrl,
   headers:{authorization:'Bearer '+staffToken},payload:followup});
  assert.equal(staffDenied.statusCode,403,'Authenticated staff != owner');
  assert.equal((await a.query('SELECT count(*)::int n FROM ai0_official_quarantine_reviews WHERE receipt_id=$1',[receiptId])).rows[0].n,
   0,'Unauthorized reconciliation must create ZERO audit rows');
  const follow=await app.inject({method:'POST',url:reconcileUrl,
   headers:{authorization:'Bearer '+ownerToken},payload:followup});
  assert.equal(follow.statusCode,200,follow.body);
  assert.equal(follow.json().status,'pending');
  assert.equal(follow.json().pending,true);
  const followReplay=await app.inject({method:'POST',url:reconcileUrl,
   headers:{authorization:'Bearer '+ownerToken},payload:followup});
  assert.equal(followReplay.statusCode,200);
  assert.equal(followReplay.json().review_id,follow.json().review_id);
  assert.equal(followReplay.json().replayed,true);
  assert.equal((await a.query("SELECT status FROM zalo_official_quarantine WHERE id=$1",[receiptId])).rows[0].status,
    'NEEDS_HUMAN','NEEDS_FOLLOW_UP cannot clear the pending gate');
  const still409=await approval(order1,unique('approval-after-followup'));
  assert.equal(still409.statusCode,409);
  assert.equal(still409.json().error.code,'PENDING_INBOUND_REVIEW');
  assert.equal((await a.query('SELECT count(*)::int n FROM core_approvals WHERE order_id=$1',[order1])).rows[0].n,0);
  assert.equal((await a.query('SELECT count(*)::int n FROM core_print_jobs WHERE order_id=$1',[order1])).rows[0].n,0);
  const reviewBody={disposition:'NO_ORDER_CHANGE',note:'Da doi soat, khong can doi don',
   idempotency_key:unique('review')};
  const cleared=await app.inject({method:'POST',url:reconcileUrl,
   headers:{authorization:'Bearer '+ownerToken},payload:reviewBody});
  assert.equal(cleared.statusCode,200,cleared.body);
  assert.equal(cleared.json().status,'reviewed');
  const replay=await app.inject({method:'POST',url:reconcileUrl,
   headers:{authorization:'Bearer '+ownerToken},payload:reviewBody});
  assert.equal(replay.statusCode,200,replay.body);
  assert.equal(replay.json().review_id,cleared.json().review_id);
  assert.equal(replay.json().replayed,true);
  assert.equal((await a.query('SELECT count(*)::int n FROM ai0_official_quarantine_reviews WHERE receipt_id=$1',[receiptId])).rows[0].n,2,'one followup + one clear, replay cannot add audit rows');
  assert.equal((await a.query('SELECT status FROM zalo_official_quarantine WHERE id=$1',[receiptId])).rows[0].status,'REVIEWED');

  const approved=await approval(order1,unique('approval-after-review'));
  assert.equal(approved.statusCode,200,approved.body);
  assert.ok(approved.json().job_id);
  assert.equal((await a.query('SELECT count(*)::int n FROM core_print_jobs WHERE order_id=$1',[order1])).rows[0].n,1);

  // The quarantine scope lock is the shared serialization point. If receipt
  // owns it first, approval waits; after receipt commits, approval is HTTP 409
  // and creates no approval or print job.
  const order2=await makeOrder('scope-race');
  const pids=await Promise.all([
   a.query('SELECT pg_backend_pid() pid'),b.query('SELECT pg_backend_pid() pid')
  ]);
  assert.notEqual(pids[0].rows[0].pid,pids[1].rows[0].pid);
  const held=await b.connect();
  let transactionOpen=false;
  try{
   await held.query('BEGIN');transactionOpen=true;
   await held.query('INSERT INTO zalo_official_quarantine_scopes(oa_id) VALUES($1) ON CONFLICT (oa_id) DO NOTHING',[oa]);
   await held.query('SELECT oa_id FROM zalo_official_quarantine_scopes WHERE oa_id=$1 FOR UPDATE',[oa]);
   let settled=false;
   const pendingApproval=approval(order2,unique('racing-approval')).then(response=>{settled=true;return response});
   await new Promise(resolve=>setTimeout(resolve,100));
   assert.equal(settled,false,'approval must wait for the same OA scope row');
   const digest=createHash('sha256').update('synthetic-race-receipt').digest('hex');
   const receipt=randomUUID();
   // Valid AI2 custody row committed by the transaction holding the scope lock.
   await held.query(
    "INSERT INTO zalo_official_quarantine(id,oa_id,raw_sha256,kind,status) VALUES($1,$2,$3,'click','NEEDS_HUMAN')",
    [receipt,oa,digest]);
   await held.query('COMMIT');transactionOpen=false;
   const response=await pendingApproval;
   assert.equal(response.statusCode,409,response.body);
   assert.equal(response.json().error.code,'PENDING_INBOUND_REVIEW');
   assert.equal((await a.query('SELECT count(*)::int n FROM core_approvals WHERE order_id=$1',[order2])).rows[0].n,0);
   assert.equal((await a.query('SELECT count(*)::int n FROM core_print_jobs WHERE order_id=$1',[order2])).rows[0].n,0);
  assert.equal((await a.query('SELECT count(*)::int n FROM core_confirmations WHERE order_id=$1',[order2])).rows[0].n,1,
    'one explicit separate customer confirmation; quarantine does not create another');
  assert.equal((await a.query('SELECT count(*)::int n FROM zalo_confirmation_candidates WHERE oa_id=$1',[oa])).rows[0].n,0,
    'unsupported signed click must not become a consent candidate');
   reviewReceiptIds.push(receipt);
  }finally{
   if(transactionOpen)await held.query('ROLLBACK');
   held.release();
  }
 }finally{
  if(app)await app.close();
  if(reviewReceiptIds.length)await a.query(
   'DELETE FROM ai0_official_quarantine_reviews WHERE receipt_id=ANY($1::uuid[])',[reviewReceiptIds]);
  await a.query('DELETE FROM ai0_official_quarantine_reviews WHERE shop_id=$1',[shop]);
  await a.query('DELETE FROM zalo_official_quarantine WHERE oa_id=$1',[oa]);
  await a.query('DELETE FROM zalo_official_quarantine_scopes WHERE oa_id=$1',[oa]);
  await a.query('DELETE FROM zalo_process_queue WHERE oa_id=$1',[oa]);
  await a.query('DELETE FROM zalo_inbound_events WHERE oa_id=$1',[oa]);
  await a.query('DELETE FROM ai0_official_zalo_identity_map WHERE oa_id=$1',[oa]);
  await a.query('DELETE FROM ai0_official_zalo_oa_registry WHERE oa_id=$1',[oa]);
  if(orderIds.length){
   await a.query('DELETE FROM core_print_jobs WHERE order_id=ANY($1::uuid[])',[orderIds]);
   await a.query('DELETE FROM core_approvals WHERE order_id=ANY($1::uuid[])',[orderIds]);
   await a.query('DELETE FROM core_confirmations WHERE order_id=ANY($1::uuid[])',[orderIds]);
   await a.query('DELETE FROM core_revisions WHERE order_id=ANY($1::uuid[])',[orderIds]);
   await a.query('DELETE FROM core_audit WHERE shop_id=$1',[shop]);
   await a.query('DELETE FROM core_idempotency WHERE shop_id=$1',[shop]);
   await a.query('DELETE FROM core_orders WHERE id=ANY($1::uuid[])',[orderIds]);
   await a.query('DELETE FROM core_conversation_controls WHERE shop_id=$1',[shop]);
  }
  await a.query('DELETE FROM core_sessions WHERE user_id IN (SELECT id FROM core_users WHERE shop_id=$1)',[shop]);
  await a.query('DELETE FROM core_users WHERE shop_id=$1',[shop]);
  await a.query('DELETE FROM core_shop_settings WHERE shop_id=$1',[shop]);
  await Promise.all([a.end(),b.end()]);
 }
});
