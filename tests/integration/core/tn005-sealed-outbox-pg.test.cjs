const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const path=require('node:path');
const root=process.env.AI1_BUILD_DIR||path.resolve(__dirname,'../../../.ai1-build/backend');
const {PgStore}=require(path.join(root,'storage/database.js'));
const {createTn005SealedOutbox}=require(path.join(root,'core/tn005-sealed-outbox.js'));
const {createSyntheticTn005SuggestedOutboxTick}=require(path.join(root,'jobs/tn005-suggested-outbox-dispatch.js'));
const {sha,canonical}=require(path.join(root,'core/model.js'));
let pg;try{pg=require('pg')}catch{}
const url=process.env.TEST_DATABASE_URL,uuid=()=>randomUUID();
const err=code=>e=>e?.code===code;
test('TN005 real PostgreSQL two-pool CAS, replay, source/revision/handover races, fake provider',{
 skip:!(pg&&url)&&'NOT RUN: isolated PostgreSQL TEST_DATABASE_URL required',timeout:120000
},async t=>{
 const u=new URL(url);assert.ok(['localhost','127.0.0.1','[::1]'].includes(u.hostname));assert.match(u.pathname,/test/i);
 const a=new pg.Pool({connectionString:url,max:5}),b=new pg.Pool({connectionString:url,max:5});
 const shop='autoin-test-tn005-'+uuid(),oa='oa-'+uuid(),customer='customer-'+uuid(),actor=uuid();
 const sourceSha='a'.repeat(64),file='fixture-sealed.pdf',data={documents:[{artifact_name:file}]};
 const createdOrderIds=[];
 const requestHash=sha(canonical(data)),metadata={schema_version:'tn005.first_page.v1',
  status:'SUGGESTED',confidence_label:'high',analyzed_page_count:1,reason_code:'NONE',
  category:'WORKSHEET',method:'pymupdf_page0_text'};
 const text='Trang đầu có vẻ là phiếu học tập. Bạn muốn in bao nhiêu bản, khổ giấy nào và một mặt hay hai mặt? Cửa hàng sẽ kiểm tra bản xem trước để bạn xác nhận.';
 let proofCalls=0, providerCalls=0;
 const trusted={shop_id:shop,oa_id:oa};
 const verify=async binding=>{proofCalls++;return binding.shop_id===shop&&binding.oa_id===oa&&
  binding.request_hash===requestHash&&binding.source_sha256===sourceSha&&binding.artifact_ref===file;};
 const p1=createTn005SealedOutbox({store:new PgStore(a),trusted,verify_sealed_source:verify});
 const p2=createTn005SealedOutbox({store:new PgStore(b),trusted,verify_sealed_source:verify});
 const fake={async send_text(conv,value){providerCalls++;assert.ok(conv.startsWith('conversation-'));assert.equal(value,text);}};
 const fixture=async({shopId=shop,oaId=oa,customerId=customer}={})=>{
  const orderId=uuid(),conv='conversation-'+uuid(),event='event-'+uuid();
  createdOrderIds.push(orderId);
  await a.query('INSERT INTO core_orders(id,shop_id,customer_id,conversation_id) VALUES($1,$2,$3,$4)',[orderId,shopId,customerId,conv]);
  await a.query('INSERT INTO core_revisions(order_id,revision,request_hash,request_data) VALUES($1,1,$2,$3::jsonb)',
   [orderId,requestHash,JSON.stringify(data)]);
  await a.query('INSERT INTO core_conversation_controls(shop_id,conversation_id) VALUES($1,$2)',[shopId,conv]);
  await a.query('INSERT INTO zalo_inbound_events(oa_id,event_id,conversation_id,customer_id,occurred_at,payload_json) VALUES($1,$2,$3,$4,now(),$5::jsonb)',
   [oaId,event,conv,customerId,JSON.stringify({kind:'file',conversation_id:conv,customer_id:customerId})]);
  await a.query('INSERT INTO ai0_inbound_document_artifacts(shop_id,oa_id,event_id,conversation_id,customer_id,artifact_ref,sha256,manifest_ref,manifest_sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
   [shopId,oaId,event,conv,customerId,file,sourceSha,'manifest-'+uuid(),'b'.repeat(64)]);
  await a.query("INSERT INTO ai0_inbound_artifact_drafts(shop_id,oa_id,event_id,actor_id,settings_sha256,status,order_id,completed_at) VALUES($1,$2,$3,$4,$5,'CREATED',$6,now())",
   [shopId,oaId,event,'fixture','c'.repeat(64),orderId]);
  await a.query('INSERT INTO ai0_first_page_suggestions(shop_id,order_id,revision,request_hash,artifact_sha256,metadata) VALUES($1,$2,1,$3,$4,$5::jsonb)',
   [shopId,orderId,requestHash,sourceSha,JSON.stringify(metadata)]);
  return {orderId,conv,event,input:{outbound_id:uuid(),idempotency_key:uuid(),order_id:orderId,
   revision:1,generation:0,request_hash:requestHash,source_sha256:sourceSha,text}};
 };
 const state=async outbound=>(await a.query('SELECT status FROM core_tn005_suggested_outbox WHERE outbound_id=$1',[outbound])).rows[0]?.status;
 const count=async()=>Number((await a.query('SELECT count(*)::int n FROM core_tn005_suggested_outbox WHERE shop_id=$1',[shop])).rows[0].n);
 const guards=async()=>(await a.query(
  'SELECT (SELECT count(*)::int FROM core_confirmations WHERE order_id=ANY($1::uuid[])) confirmations,'+
  '(SELECT count(*)::int FROM core_approvals WHERE order_id=ANY($1::uuid[])) approvals,'+
  '(SELECT count(*)::int FROM core_print_jobs WHERE order_id=ANY($1::uuid[])) jobs',[createdOrderIds])).rows[0];
 try{
  assert.ok((await a.query("SELECT to_regclass('public.core_tn005_suggested_outbox') AS t")).rows[0].t,
   'Migration Core 009 must run before tests');
  await a.query('INSERT INTO core_shop_settings(shop_id) VALUES($1)',[shop]);
  await a.query("INSERT INTO core_users(id,shop_id,username,password_hash,role) VALUES($1,$2,'owner','test-only','owner')",[actor,shop]);
  const before=await guards();
  assert.deepEqual(before,{confirmations:0,approvals:0,jobs:0});
  await t.test('two independent pools: idempotent replay, same revision conflict and exactly-once fake send',async()=>{
   const f=await fixture(),i=f.input;
   const both=await Promise.all([p1.enqueue(i),p2.enqueue(i)]);
   assert.deepEqual(both,[{status:'queued',outbound_id:i.outbound_id},{status:'queued',outbound_id:i.outbound_id}]);
   assert.equal(await count(),1);
   await assert.rejects(p1.enqueue({...i,idempotency_key:uuid()}),err('TN005_IDEMPOTENCY_CONFLICT'));
   await assert.rejects(p2.enqueue({...i,outbound_id:uuid(),idempotency_key:uuid()}),err('TN005_IDEMPOTENCY_CONFLICT'));
   await assert.rejects(p2.enqueue({...i,source_sha256:'f'.repeat(64)}),err('TN005_STALE'));
   await assert.rejects(p1.enqueue({...i,text:'forged text'}),err('TN005_TEXT_UNVERIFIED'));
   const lease=await p1.reserve(i.outbound_id);assert.ok(lease);
   assert.equal(await p2.reserve(i.outbound_id),null);
   assert.equal(await p2.deliverReserved(lease,fake),'sent');assert.equal(await state(i.outbound_id),'SENT');
   assert.equal(await p1.deliverReserved(lease,fake),'blocked');assert.equal(providerCalls,1);
   assert.deepEqual(await p1.enqueue(i),{status:'queued',outbound_id:i.outbound_id});
   assert.equal(await state(i.outbound_id),'SENT');
  });
  await t.test('handover between enqueue/reservation and pre-provider check blocks; no reactivation on AI return',async()=>{
   const f=await fixture();await p1.enqueue(f.input);
   const lease=await p2.reserve(f.input.outbound_id);assert.ok(lease);
   await a.query("UPDATE core_conversation_controls SET status='HUMAN',claimed_by=$3,generation=1 WHERE shop_id=$1 AND conversation_id=$2",[shop,f.conv,actor]);
   assert.equal(await p1.deliverReserved(lease,fake),'blocked');
   assert.equal(await state(f.input.outbound_id),'CANCELLED');assert.equal(providerCalls,1);
   await a.query("UPDATE core_conversation_controls SET status='AI',claimed_by=NULL,generation=2 WHERE shop_id=$1 AND conversation_id=$2",[shop,f.conv]);
   await assert.rejects(p1.enqueue(f.input),err('TN005_HANDOVER'));
   assert.equal(await p2.reserve(f.input.outbound_id),null);
  });
  await t.test('old request hash/revision and source mutation cannot pass fresh CAS',async()=>{
   const f=await fixture();await p1.enqueue(f.input);
   await a.query('INSERT INTO core_revisions(order_id,revision,request_hash,request_data) VALUES($1,2,$2,$3::jsonb)',
    [f.orderId,sha('changed'),JSON.stringify({documents:[{artifact_name:'changed'}]})]);
   await a.query('UPDATE core_orders SET active_revision=2 WHERE id=$1',[f.orderId]);
   assert.equal(await p1.reserve(f.input.outbound_id),null);
   assert.equal(await state(f.input.outbound_id),'CANCELLED');
   await assert.rejects(p2.enqueue(f.input),err('TN005_STALE'));
   const g=await fixture();await p2.enqueue(g.input);
   await a.query('UPDATE core_revisions SET request_hash=$2 WHERE order_id=$1 AND revision=1',
    [g.orderId,sha('changed-request')]);
   assert.equal(await p1.reserve(g.input.outbound_id),null);
   assert.equal(await state(g.input.outbound_id),'CANCELLED');
   const h=await fixture();await p2.enqueue(h.input);
   const lease=await p1.reserve(h.input.outbound_id);assert.ok(lease);
   await a.query('UPDATE ai0_inbound_document_artifacts SET sha256=$2 WHERE event_id=$1 AND shop_id=$3',[h.event,'d'.repeat(64),shop]);
   assert.equal(await p2.deliverReserved(lease,fake),'blocked');
   assert.equal(await state(h.input.outbound_id),'CANCELLED');assert.equal(providerCalls,1);
  });
  await t.test('two-pool generation row race: losing enqueue cannot queue after handover',async()=>{
   const f=await fixture();
   const hold=await a.connect();let tx=false;
   try{
    await hold.query('BEGIN');tx=true;
    await hold.query('SELECT * FROM core_conversation_controls WHERE shop_id=$1 AND conversation_id=$2 FOR UPDATE',[shop,f.conv]);
    const pending=p2.enqueue(f.input);await new Promise(resolve=>setTimeout(resolve,30));
    await hold.query("UPDATE core_conversation_controls SET status='HUMAN',claimed_by=$3,generation=1 WHERE shop_id=$1 AND conversation_id=$2",[shop,f.conv,actor]);
    await hold.query('COMMIT');tx=false;
    await assert.rejects(pending,err('TN005_HANDOVER'));
    assert.equal((await a.query('SELECT count(*)::int n FROM core_tn005_suggested_outbox WHERE order_id=$1',[f.orderId])).rows[0].n,0);
   }finally{if(tx)await hold.query('ROLLBACK');hold.release();}
  });
  await t.test('ambiguous provider failure -> UNKNOWN, never retried; test fake only',async()=>{
   const f=await fixture();await p1.enqueue(f.input);const lease=await p1.reserve(f.input.outbound_id);assert.ok(lease);
   assert.equal(await p2.deliverReserved(lease,{async send_text(){providerCalls++;throw Error('fake timeout');}}),'unknown');
   assert.equal(await state(f.input.outbound_id),'UNKNOWN');
   assert.equal(await p2.deliverReserved(lease,fake),'blocked');
   assert.equal(await p1.reserve(f.input.outbound_id),null);
  });
  await t.test('two independent PG-pool ticks race one QUEUED row; exactly one sender call',async()=>{
   const f=await fixture();await p1.enqueue(f.input);
   let readers=0,releaseReaders;
   const bothRead=new Promise(resolve=>{releaseReaders=resolve;});
   const barrierPool=pool=>({async query(sql,args){
    const result=await pool.query(sql,args);
    if(sql.includes('FROM core_tn005_suggested_outbox')&&sql.includes("status='QUEUED'")){
     readers++;if(readers===2)releaseReaders();await bothRead;
    }
    return result;
   }});
   let dispatchCalls=0;
   const dispatchSender={kind:'synthetic_test',async send_text(conv,value){
    dispatchCalls++;assert.equal(conv,f.conv);assert.equal(value,text);
   }};
   const tick1=createSyntheticTn005SuggestedOutboxTick({pool:barrierPool(a),trusted,
    core:p1,sender:dispatchSender});
   const tick2=createSyntheticTn005SuggestedOutboxTick({pool:barrierPool(b),trusted,
    core:p2,sender:dispatchSender});
   const reports=await Promise.all([tick1.tick(),tick2.tick()]);
   assert.equal(reports.reduce((n,r)=>n+r.selected,0),2,'both readers observed the same candidate');
   assert.equal(reports.reduce((n,r)=>n+r.sent,0),1);
   assert.equal(reports.reduce((n,r)=>n+r.blocked,0),1);
   assert.equal(dispatchCalls,1);
   assert.equal(await state(f.input.outbound_id),'SENT');
  });
  await t.test('foreign shop is outside tick scope and never reaches injected sender',async()=>{
   const foreignShop='autoin-test-tn005-foreign-'+uuid(),foreignOa='oa-'+uuid(),foreignCustomer='customer-'+uuid();
   await a.query('INSERT INTO core_shop_settings(shop_id) VALUES($1)',[foreignShop]);
   const foreign=createTn005SealedOutbox({store:new PgStore(b),trusted:{shop_id:foreignShop,oa_id:foreignOa},
    verify_sealed_source:async binding=>binding.shop_id===foreignShop&&binding.oa_id===foreignOa&&
     binding.request_hash===requestHash&&binding.source_sha256===sourceSha&&binding.artifact_ref===file});
   const f=await fixture({shopId:foreignShop,oaId:foreignOa,customerId:foreignCustomer});
   await foreign.enqueue(f.input);
   assert.equal(await p1.reserve(f.input.outbound_id),null,'fixed current-shop Core cannot reserve foreign row');
   let sends=0;
   const tick=createSyntheticTn005SuggestedOutboxTick({pool:a,trusted,core:p1,
    sender:{kind:'synthetic_test',async send_text(){sends++;}}});
   assert.deepEqual(await tick.tick(),{selected:0,sent:0,blocked:0,unknown:0});
   assert.equal(await state(f.input.outbound_id),'QUEUED','foreign row remains untouched');
   assert.equal(sends,0);
  });
  await t.test('tick records sender timeout as UNKNOWN and a later tick does not retry',async()=>{
   const f=await fixture();await p1.enqueue(f.input);let sends=0;
   const tick=createSyntheticTn005SuggestedOutboxTick({pool:a,trusted,core:p1,
    sender:{kind:'synthetic_test',async send_text(){sends++;throw Error('synthetic timeout');}}});
   assert.deepEqual(await tick.tick(),{selected:1,sent:0,blocked:0,unknown:1});
   assert.equal(await state(f.input.outbound_id),'UNKNOWN');
   assert.deepEqual(await tick.tick(),{selected:0,sent:0,blocked:0,unknown:0});
   assert.equal(sends,1,'UNKNOWN is excluded and never resent');
  });
  assert.deepEqual(await guards(),before,'never change confirmation/approval/print jobs');
  assert.deepEqual(await guards(),{confirmations:0,approvals:0,jobs:0},
   'the tested orders retain zero confirmation, approval, and print-job mutations');
  assert.equal(providerCalls,2);assert.ok(proofCalls>5);
  console.log('PASS TN005 PG TWO POOLS: replay/race/source/revision/handover/fake provider UNKNOWN, no OA or print');
 }finally{await Promise.all([a.end(),b.end()]);}
});
