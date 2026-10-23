const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const root=process.env.AI1_BUILD_DIR||path.resolve(__dirname,'../../../dist/backend');
const {PgStore}=require(path.join(root,'storage/database.js'));
const {OrderService}=require(path.join(root,'core/service.js'));
const {bindIntakeBatchToRevision}=require(path.join(root,'core/oa-intake-batches.js'));
const {createIncomingBatchPort}=require(path.join(root,'core/incoming-batch-port.js'));
let pg;try{pg=require('pg')}catch{}
const url=process.env.TEST_DATABASE_URL,uid=()=>randomUUID();
const error=code=>e=>e&&e.code===code;
const skip=!(pg&&url)&&'SKIP - PostgreSQL regression requires isolated TEST_DATABASE_URL and pg; no simulated PASS';

test('AI1 OA intake batch REAL PostgreSQL: code-before-file, durable membership, lease, expiry and no old-event reuse',
 {skip,timeout:120000},async()=>{
 const parsed=new URL(url);
 assert.ok(['localhost','127.0.0.1','[::1]'].includes(parsed.hostname),'TEST_DATABASE_URL must use local disposable PostgreSQL');
 assert.match(parsed.pathname,/test/i,'TEST_DATABASE_URL database name must identify a test database');
 const pool=new pg.Pool({connectionString:url,max:5}),store=new PgStore(pool),service=new OrderService(store);
 const suffix=uid(),shop=`intake-${suffix}`,oa=`oa-${suffix}`,customer=`customer-${suffix}`,conversation=`chat-${suffix}`;
 const order1=uid(),order2=uid(),revisionData={documents:[]},requestHash='a'.repeat(64);
 const leases=[];
 const migrationFiles=[
  '../../../backend/integrations/zalo/migrations/001_zalo_durable.sql',
  '../../../backend/integrations/zalo/migrations/002_zalo_oa_scope.sql',
  '../../../backend/storage/migrations/001_core.sql',
  '../../../backend/storage/migrations/002_send_mode.sql',
  '../../../backend/storage/migrations/003_confirmed_queue.sql',
  '../../../backend/storage/migrations/004_conversation_generation.sql',
  '../../../backend/storage/migrations/005_ai_order_port.sql',
  '../../../backend/storage/migrations/007_active_order_inbound.sql',
  '../../../backend/storage/migrations/011_print_evidence_binding.sql',
  '../../../backend/storage/migrations/013_inbound_review_items.sql',
  '../../../backend/storage/migrations/014_pilot_shop_code.sql',
  '../../../backend/composition/migrations/005_official_zalo_shop_registry.sql',
  '../../../backend/storage/migrations/015_oa_intake_batches.sql',
  '../../../backend/storage/migrations/016_persist_intake_new_order_intent.sql',
  '../../../backend/storage/migrations/017_controlled_test_scopes.sql'
 ];
 try{
  const database=(await pool.query('SELECT current_database() AS name')).rows[0].name;
  assert.match(database,/test/i,'Never touch production DB');
  for(const file of migrationFiles)await pool.query(fs.readFileSync(path.resolve(__dirname,file),'utf8'));
  await pool.query('INSERT INTO core_shop_settings(shop_id) VALUES($1)',[shop]);
  await pool.query('INSERT INTO core_shop_zalo_oa_registry(shop_id,oa_id,app_id) VALUES($1,$2,$3)',[shop,oa,`app-${suffix}`]);
  for(const id of [order1,order2]){
   await pool.query('INSERT INTO core_orders(id,shop_id,customer_id,conversation_id,active_revision) VALUES($1,$2,$3,$4,1)',
    [id,shop,customer,conversation]);
   await pool.query('INSERT INTO core_revisions(order_id,revision,request_hash,request_data) VALUES($1,1,$2,$3::jsonb)',
    [id,requestHash,JSON.stringify(revisionData)]);
  }
  const leasedEvent=async(kind,text,who=customer,chat=conversation)=>{
   const eventId=`${kind}-${uid()}`,batchId=(await pool.query(
    "INSERT INTO zalo_batches(batch_key,oa_id,event_count,status,lease_token,lease_until) VALUES($1,$2,1,'LEASED',$3,clock_timestamp()+interval '2 minutes') RETURNING id::text",
    [`batch-${uid()}`,oa,uid()])).rows[0].id;
   const leaseToken=(await pool.query('SELECT lease_token::text AS lease_token FROM zalo_batches WHERE id=$1',[batchId])).rows[0].lease_token;
   await pool.query('INSERT INTO zalo_inbound_events(oa_id,event_id,conversation_id,customer_id,occurred_at,payload_json) VALUES($1,$2,$3,$4,clock_timestamp(),$5::jsonb)',
    [oa,eventId,chat,who,JSON.stringify({kind,text})]);
   await pool.query('INSERT INTO zalo_batch_items(batch_id,oa_id,event_id) VALUES($1,$2,$3)',[batchId,oa,eventId]);
   const value={queue_batch_id:batchId,lease_token:leaseToken,event_id:eventId};leases.push(value);return value;
  };
  const code=await leasedEvent('text','RAW-CODE-PRIVATE-TEST');
  const codeInput={queue_batch_id:code.queue_batch_id,lease_token:code.lease_token,purpose:'PILOT',
   event_ids:[code.event_id],selection:{code_event_id:code.event_id}};
  const opened=await service.acceptIncomingQueueBatch(codeInput);
  assert.equal(opened.status,'OPEN');assert.equal(opened.readiness,'WAITING_FOR_FILE');
  assert.deepEqual(opened.events.map(item=>item.role),['CODE']);
  assert.equal(JSON.stringify(opened).includes('RAW-CODE-PRIVATE-TEST'),false,'Core batch snapshot is metadata-only');
  const repeated=await Promise.all([service.acceptIncomingQueueBatch(codeInput),service.acceptIncomingQueueBatch(codeInput)]);
  assert.deepEqual(repeated.map(item=>item.intake_batch_id),[opened.intake_batch_id,opened.intake_batch_id]);

  const settingsEvent=await leasedEvent('text','A4 black-and-white, 2 copies, duplex');
  const withSettings=await service.acceptIncomingQueueBatch({queue_batch_id:settingsEvent.queue_batch_id,
   lease_token:settingsEvent.lease_token,purpose:'PILOT',event_ids:[settingsEvent.event_id],
   selection:{settings_event_ids:[settingsEvent.event_id]}});
  assert.equal(withSettings.intake_batch_id,opened.intake_batch_id);
  assert.equal(withSettings.readiness,'WAITING_FOR_FILE','settings can be durably held before the source arrives');

  const file=await leasedEvent('file',null);
  const ready=await service.acceptIncomingQueueBatch({queue_batch_id:file.queue_batch_id,lease_token:file.lease_token,
   purpose:'PILOT',event_ids:[file.event_id],selection:{source_event_id:file.event_id}});
  assert.equal(ready.intake_batch_id,opened.intake_batch_id,'file arriving later completes the open code batch');
  assert.equal(ready.readiness,'READY');
  assert.deepEqual(ready.events.map(item=>item.role),['CODE','SETTINGS','SOURCE']);
  await store.tx(db=>bindIntakeBatchToRevision(db,{intake_batch_id:ready.intake_batch_id,shop_id:shop,oa_id:oa,
   customer_id:customer,conversation_id:conversation,order_id:order1,revision:1,purpose:'PILOT'}));
  await assert.rejects(store.tx(db=>bindIntakeBatchToRevision(db,{intake_batch_id:ready.intake_batch_id,shop_id:shop,oa_id:oa,
   customer_id:customer,conversation_id:conversation,order_id:order2,revision:1,purpose:'PILOT'})),error('INCOMING_BATCH_ORDER_CONFLICT'));

  const closed=await service.closeIncomingQueueBatch({intake_batch_id:ready.intake_batch_id,queue_batch_id:file.queue_batch_id,
   lease_token:file.lease_token,reason:'ABANDONED'});
  assert.equal(closed.status,'CLOSED');
  await assert.rejects(service.acceptIncomingQueueBatch({...codeInput,boundary:'NEW'}),error('INCOMING_EVENT_ALREADY_BOUND'));
  const persisted=(await pool.query('SELECT intake_batch_id::text,status,order_id::text,revision FROM core_oa_intake_batches WHERE id=$1',
   [ready.intake_batch_id])).rows[0];
  assert.equal(persisted.status,'CLOSED');assert.equal(persisted.order_id,order1);assert.equal(Number(persisted.revision),1);

  const expiring=await leasedEvent('text','EXPIRE-ME');
  const toExpire=await service.acceptIncomingQueueBatch({queue_batch_id:expiring.queue_batch_id,lease_token:expiring.lease_token,
   purpose:'ORDER',event_ids:[expiring.event_id]});
  await pool.query("UPDATE core_oa_intake_batches SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[toExpire.intake_batch_id]);
  await service.expireIncomingQueueBatches(50,shop);
  assert.equal((await pool.query('SELECT status FROM core_oa_intake_batches WHERE id=$1',[toExpire.intake_batch_id])).rows[0].status,'EXPIRED');

  const orderCustomer=`order-customer-${suffix}`,orderConversation=`order-chat-${suffix}`;
  const orderEvent=await leasedEvent('text','Tạo đơn tổng hợp',orderCustomer,orderConversation);
  const orderBatch=await service.acceptIncomingQueueBatch({queue_batch_id:orderEvent.queue_batch_id,
   lease_token:orderEvent.lease_token,purpose:'ORDER',event_ids:[orderEvent.event_id]});
  const processor={id:`processor-${suffix}`,shop_id:shop,role:'processor',verified:true};
  const orderPort=createIncomingBatchPort({store,trusted:{shop_id:shop,oa_id:oa},processor});
  const applyInput={scope:{oa_id:oa,customer_id:orderCustomer,conversation_id:orderConversation},
   queue_batch_id:orderEvent.queue_batch_id,lease_token:orderEvent.lease_token,intake_batch_id:orderBatch.intake_batch_id,
   purpose:'ORDER',expected_generation:0,event_ids:[orderEvent.event_id],text:'Tạo đơn tổng hợp',
   idempotency_key:`order-${suffix}`,intent:'append_or_create',changes:[]};
  const applied=await orderPort.apply_incoming_batch(applyInput);
  assert.equal(applied.status,'created');
  const replay=await orderPort.apply_incoming_batch(applyInput);
  assert.equal(replay.status,'existing');assert.equal(replay.order_id,applied.order_id);
  const bound=(await pool.query('SELECT status,order_id::text,revision FROM core_oa_intake_batches WHERE id=$1',
   [orderBatch.intake_batch_id])).rows[0];
  assert.equal(bound.status,'BOUND');assert.equal(bound.order_id,applied.order_id);assert.equal(Number(bound.revision),1);
 }finally{
  for(const lease of leases.reverse()){
   await pool.query('DELETE FROM core_oa_intake_event_bindings WHERE oa_id=$1 AND event_id=$2',[oa,lease.event_id]).catch(()=>{});
   await pool.query('DELETE FROM zalo_batch_items WHERE oa_id=$1 AND event_id=$2',[oa,lease.event_id]).catch(()=>{});
   await pool.query('DELETE FROM zalo_process_queue WHERE oa_id=$1 AND event_id=$2',[oa,lease.event_id]).catch(()=>{});
   await pool.query('DELETE FROM zalo_inbound_events WHERE oa_id=$1 AND event_id=$2',[oa,lease.event_id]).catch(()=>{});
   await pool.query('DELETE FROM zalo_batches WHERE id=$1',[lease.queue_batch_id]).catch(()=>{});
  }
  await pool.query('DELETE FROM core_oa_intake_event_bindings WHERE intake_batch_id IN (SELECT id FROM core_oa_intake_batches WHERE shop_id=$1)',[shop]).catch(()=>{});
  await pool.query('DELETE FROM core_oa_intake_batches WHERE shop_id=$1',[shop]).catch(()=>{});
  await pool.query('DELETE FROM core_order_inbound_reviews WHERE oa_id=$1',[oa]).catch(()=>{});
  await pool.query('DELETE FROM core_order_supplement_batches WHERE shop_id=$1',[shop]).catch(()=>{});
  await pool.query('DELETE FROM core_ai_draft_proposals WHERE shop_id=$1',[shop]).catch(()=>{});
  await pool.query('DELETE FROM core_revisions WHERE order_id IN (SELECT id FROM core_orders WHERE shop_id=$1)',[shop]).catch(()=>{});
  await pool.query('DELETE FROM core_orders WHERE shop_id=$1',[shop]).catch(()=>{});
  await pool.query('DELETE FROM core_conversation_controls WHERE shop_id=$1',[shop]).catch(()=>{});
  await pool.query('DELETE FROM core_shop_zalo_oa_registry WHERE shop_id=$1',[shop]).catch(()=>{});
  await pool.query('DELETE FROM core_shop_settings WHERE shop_id=$1',[shop]).catch(()=>{});
  await pool.end();
 }
});
