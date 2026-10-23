const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');
const root=process.env.AI1_BUILD_DIR||path.resolve(__dirname,'../../../dist/backend');
const {PgStore}=require(path.join(root,'storage/database.js'));
const {createIncomingBatchPort}=require(path.join(root,'core/incoming-batch-port.js'));
const {acceptIncomingQueueBatch,bindIntakeBatchToRevision}=require(path.join(root,'core/oa-intake-batches.js'));
const {pilotSettingsHash}=require(path.join(root,'core/pilot-shop-code.js'));
const {canonical}=require(path.join(root,'core/model.js'));
let pg;try{pg=require('pg');}catch{}
const url=process.env.TEST_DATABASE_URL;
const uuid=()=>randomUUID();
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const skip=!(pg&&url)&&'SKIP - REAL PostgreSQL regression requires isolated TEST_DATABASE_URL and pg; mock tests are not PostgreSQL PASS';
const migrations=[
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
 '../../../backend/composition/migrations/008_pilot_private_sources.sql',
 '../../../backend/storage/migrations/015_oa_intake_batches.sql',
 '../../../backend/storage/migrations/016_persist_intake_new_order_intent.sql'
];
const settings={copies:2,duplex:true,paper:'A4',color:'black_white'};
const err=code=>error=>error&&error.code===code;

test('AI1 Core REAL PostgreSQL: pilot PDF/DOCX bytes, revision binding, settings, lease and replay',
 {skip,timeout:120000},async()=>{
 const parsed=new URL(url);
 assert.ok(['localhost','127.0.0.1','[::1]'].includes(parsed.hostname),'TEST_DATABASE_URL must be local/disposable');
 assert.match(parsed.pathname,/test/i,'TEST_DATABASE_URL database name must identify a test database');
 const pool=new pg.Pool({connectionString:url,max:5});
 const store=new PgStore(pool);
 const fixtures=[];
 try{
  const database=(await pool.query('SELECT current_database() AS name')).rows[0].name;
  assert.match(database,/test/i,'Never use a production database');
  for(const file of migrations)await pool.query(fs.readFileSync(path.resolve(__dirname,file),'utf8'));

  async function fixture(label,format,readerMode='good',newBoundary=false){
   const id=uuid(),shop=`pilot-source-${label}-${id}`,oa=`oa-${id}`,customer=`customer-${id}`,
    conversation=`chat-${id}`,processor={id:`processor-${id}`,shop_id:shop,role:'processor',verified:true};
   await pool.query('INSERT INTO core_shop_settings(shop_id) VALUES($1)',[shop]);
   await pool.query('INSERT INTO core_shop_zalo_oa_registry(shop_id,oa_id,app_id) VALUES($1,$2,$3)',[shop,oa,`app-${id}`]);
   const leases=[],fixtureRecord={id,shop,oa,customer,conversation,leases,port:null,apply:null,
    intake_batch_ids:[],intake_batch_id:null,old_order_id:null,code_event_id:null,new_boundary_event_id:null,new_boundary_lease:null,
    file_event_id:null,settings_event_id:null,bytes:null,sha256:null,artifact:null};
   fixtures.push(fixtureRecord);
   const event=async(kind,text)=>{
    const eventId=`${kind}-${uuid()}`,token=uuid();
    const batchId=(await pool.query("INSERT INTO zalo_batches(batch_key,oa_id,event_count,status,lease_token,lease_until) "+
     "VALUES($1,$2,1,'LEASED',$3,clock_timestamp()+interval '5 minutes') RETURNING id::text",
     [`queue-${id}-${uuid()}`,oa,token])).rows[0].id;
    await pool.query('INSERT INTO zalo_inbound_events(oa_id,event_id,conversation_id,customer_id,occurred_at,payload_json) VALUES($1,$2,$3,$4,clock_timestamp(),$5::jsonb)',
     [oa,eventId,conversation,customer,JSON.stringify({kind,...(text===null?{}:{text})})]);
    await pool.query('INSERT INTO zalo_batch_items(batch_id,oa_id,event_id) VALUES($1,$2,$3)',[batchId,oa,eventId]);
    const lease={queue_batch_id:batchId,lease_token:token,event_id:eventId};leases.push(lease);return lease;
   };
   const bytes=format==='PDF'?Buffer.from('%PDF-1.7\npublic synthetic PDF bytes\n'):
    Buffer.from([0x50,0x4b,0x03,0x04,0x00,0x00,0x00,0x00,0x44,0x4f,0x43,0x58]);
   const sha256=digest(bytes),artifact=`doc-${id.replaceAll('-','')}/source-000-${sha256}.${format==='PDF'?'pdf':'docx'}`;
   const code=await event('text','PILOT-CODE-PRIVATE-FIXTURE');
   fixtureRecord.code_event_id=code.event_id;
   const opened=await acceptIncomingQueueBatch(store,{queue_batch_id:code.queue_batch_id,
    lease_token:code.lease_token,purpose:'PILOT',event_ids:[code.event_id],selection:{code_event_id:code.event_id}});
   fixtureRecord.intake_batch_ids.push(opened.intake_batch_id);
   fixtureRecord.intake_batch_id=opened.intake_batch_id;
   assert.equal(opened.readiness,'WAITING_FOR_FILE','code can be durably accepted before its file');
   let activeIntake=opened;
   if(newBoundary){
    const oldOrderId=uuid(),oldData={event_ids:[code.event_id],source:'legacy-open-fixture',incoming_batches:[]};
    await pool.query('INSERT INTO core_orders(id,shop_id,customer_id,conversation_id) VALUES($1,$2,$3,$4)',
     [oldOrderId,shop,customer,conversation]);
    await pool.query('INSERT INTO core_revisions(order_id,revision,request_hash,request_data) VALUES($1,1,$2,$3::jsonb)',
     [oldOrderId,digest(Buffer.from(JSON.stringify(oldData))),JSON.stringify(oldData)]);
    await store.tx(db=>bindIntakeBatchToRevision(db,{intake_batch_id:opened.intake_batch_id,shop_id:shop,oa_id:oa,
     customer_id:customer,conversation_id:conversation,order_id:oldOrderId,revision:1,purpose:'PILOT'}));
    await pool.query('INSERT INTO core_ai_draft_proposals(shop_id,oa_id,conversation_id,customer_id,event_fingerprint,idempotency_key,content_hash,order_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
     [shop,oa,conversation,customer,digest('old-order-fingerprint'),`old-${id}`,digest('old-order-content'),oldOrderId]);
    const boundaryEvent=await event('text','Đơn mới');
    fixtureRecord.new_boundary_event_id=boundaryEvent.event_id;
    fixtureRecord.new_boundary_lease=boundaryEvent;
    activeIntake=await acceptIncomingQueueBatch(store,{queue_batch_id:boundaryEvent.queue_batch_id,
     lease_token:boundaryEvent.lease_token,purpose:'PILOT',event_ids:[boundaryEvent.event_id],boundary:'NEW'});
    fixtureRecord.old_order_id=oldOrderId;
    fixtureRecord.intake_batch_ids.push(activeIntake.intake_batch_id);
    fixtureRecord.intake_batch_id=activeIntake.intake_batch_id;
    assert.notEqual(activeIntake.intake_batch_id,opened.intake_batch_id);
    assert.equal((await pool.query('SELECT status,new_order_requested FROM core_oa_intake_batches WHERE id=$1',
     [opened.intake_batch_id])).rows[0].status,'CLOSED');
    assert.equal((await pool.query('SELECT new_order_requested FROM core_oa_intake_batches WHERE id=$1',
     [activeIntake.intake_batch_id])).rows[0].new_order_requested,true);
   }
   const settingEvent=await event('text','A4 black-and-white, two copies, duplex');
   const withSettings=await acceptIncomingQueueBatch(store,{queue_batch_id:settingEvent.queue_batch_id,
    lease_token:settingEvent.lease_token,purpose:'PILOT',event_ids:[settingEvent.event_id],
    selection:{settings_event_ids:[settingEvent.event_id]}});
   assert.equal(withSettings.intake_batch_id,activeIntake.intake_batch_id);
   assert.equal(withSettings.readiness,'WAITING_FOR_FILE');
   const file=await event('file',null);
   await pool.query('INSERT INTO ai0_pilot_private_sources(shop_id,oa_id,event_id,customer_id,conversation_id,format,artifact_ref,sha256,size_bytes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [shop,oa,file.event_id,customer,conversation,format,artifact,sha256,bytes.length]);
   const ready=await acceptIncomingQueueBatch(store,{queue_batch_id:file.queue_batch_id,
    lease_token:file.lease_token,purpose:'PILOT',event_ids:[file.event_id],selection:{source_event_id:file.event_id}});
   assert.equal(ready.intake_batch_id,activeIntake.intake_batch_id);
   assert.equal(ready.readiness,'READY','source and settings make the revision ready; shop code remains a separate gate');
   const reader={async read_sealed(input){
    assert.deepEqual(input,{oa_id:oa,provider_event_id:file.event_id,artifact_ref:artifact});
    return readerMode==='wrong-bytes'?new Uint8Array([...bytes,0x00]):new Uint8Array(bytes);
   }};
   const port=createIncomingBatchPort({store,trusted:{shop_id:shop,oa_id:oa},processor,
    sealed_source_reader:reader});
   const apply={scope:{oa_id:oa,customer_id:customer,conversation_id:conversation},
    queue_batch_id:file.queue_batch_id,lease_token:file.lease_token,intake_batch_id:activeIntake.intake_batch_id,
    purpose:'PILOT',expected_generation:0,event_ids:[file.event_id],text:'server-bound-pilot-settings',
    idempotency_key:`apply-${id}`,intent:'append_or_create',changes:['attachment','copies','paper','duplex'],
    pilot_settings:settings};
   Object.assign(fixtureRecord,{port,apply,bytes,sha256,artifact,file_event_id:file.event_id,
    settings_event_id:settingEvent.event_id});
   return fixtureRecord;
  }
  const pdf=await fixture('pdf','PDF');
  const pdfResult=await pdf.port.apply_incoming_batch(pdf.apply);
  assert.equal(pdfResult.status,'created');
  const pdfRevision=(await pool.query('SELECT request_hash,request_data FROM core_revisions WHERE order_id=$1 AND revision=1',
   [pdfResult.order_id])).rows[0];
  assert.equal(pdfRevision.request_data.documents[0].artifact_name,pdf.artifact);
  assert.deepEqual(pdfRevision.request_data.sealed_source,{format:'PDF',sha256:pdf.sha256,size_bytes:pdf.bytes.length,
   provider_event_id:pdf.file_event_id});
  assert.deepEqual(pdfRevision.request_data.pilot_settings,settings);
  assert.equal(pdfRevision.request_data.pilot_settings_sha256,pilotSettingsHash(settings));
  assert.deepEqual(pdfRevision.request_data.settings_event_ids,[pdf.settings_event_id]);
  assert.ok(JSON.stringify(pdfRevision.request_data).length<4096,'request_data stores metadata, never source bytes');
  const pdfReplay=await pdf.port.apply_incoming_batch(pdf.apply);
  assert.deepEqual(pdfReplay,{status:'existing',order_id:pdfResult.order_id,active_revision:1});
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM core_print_jobs WHERE order_id=$1',[pdfResult.order_id])).rows[0].n,0,
   'binding source/settings creates no print job');

  const docx=await fixture('docx','DOCX');
  const docxResult=await docx.port.apply_incoming_batch(docx.apply);
  assert.equal(docxResult.status,'created');
  const docxRevision=(await pool.query('SELECT request_hash,request_data FROM core_revisions WHERE order_id=$1 AND revision=1',
   [docxResult.order_id])).rows[0];
  assert.equal(docxRevision.request_data.documents[0].artifact_name,docx.artifact);
  assert.equal(docxRevision.request_data.sealed_source.format,'DOCX');
  assert.equal(docxRevision.request_data.sealed_source.sha256,docx.sha256);
  assert.equal(JSON.stringify(docxResult).includes('bytes'),false,'Core return DTO is metadata-only');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM core_print_jobs WHERE order_id=$1',[docxResult.order_id])).rows[0].n,0);

  const newBoundary=await fixture('new-boundary','PDF','good',true);
  const boundaryReplay=await acceptIncomingQueueBatch(store,{queue_batch_id:newBoundary.new_boundary_lease.queue_batch_id,
   lease_token:newBoundary.new_boundary_lease.lease_token,purpose:'PILOT',event_ids:[newBoundary.new_boundary_event_id],boundary:'NEW'});
  assert.equal(boundaryReplay.intake_batch_id,newBoundary.intake_batch_ids[1],
   'replaying the NEW lease resolves to its original intake without closing the later file/settings intake');
  const boundaryRace=await Promise.all([
   newBoundary.port.apply_incoming_batch(newBoundary.apply),
   newBoundary.port.apply_incoming_batch(newBoundary.apply)
  ]);
  assert.deepEqual(boundaryRace.map(result=>result.status).sort(),['created','existing'],
   'concurrent apply calls use the persisted NEW boundary and create one order');
  assert.equal(boundaryRace[0].order_id,boundaryRace[1].order_id);
  const newBoundaryResult=boundaryRace.find(result=>result.status==='created');
  assert.ok(newBoundaryResult);
  assert.equal(newBoundaryResult.status,'created');
  assert.notEqual(newBoundaryResult.order_id,newBoundary.old_order_id,
   'persisted NEW intent creates a new order even when an older order is still open');
  assert.equal(newBoundaryResult.active_revision,1);
  assert.equal((await pool.query('SELECT active_revision FROM core_orders WHERE id=$1',[newBoundary.old_order_id])).rows[0].active_revision,1,
   'the older open order is not appended or revised');
  const newBoundaryRevisionRow=(await pool.query('SELECT request_hash,request_data FROM core_revisions WHERE order_id=$1 AND revision=1',
   [newBoundaryResult.order_id])).rows[0];
  const newBoundaryRevision=newBoundaryRevisionRow.request_data;
  assert.equal(newBoundaryRevisionRow.request_hash,digest(Buffer.from(canonical(newBoundaryRevision))),
   'revision hash covers the persisted NEW provenance and source/settings binding');
  const newBoundaryIntake=(await pool.query('SELECT status,order_id::text,revision,new_order_requested FROM core_oa_intake_batches WHERE id=$1',
   [newBoundary.intake_batch_ids[1]])).rows[0];
  assert.deepEqual(newBoundaryIntake,{status:'BOUND',order_id:newBoundaryResult.order_id,revision:1,new_order_requested:true});
  assert.equal(newBoundaryRevision.documents[0].artifact_name,newBoundary.artifact);
  assert.equal(newBoundaryRevision.sealed_source.provider_event_id,newBoundary.file_event_id);
  assert.deepEqual(newBoundaryRevision.pilot_settings,settings);
  assert.equal(newBoundaryRevision.incoming_batches[0].order_intent,'NEW');
  assert.ok(newBoundaryRevision.event_ids.includes(newBoundary.new_boundary_event_id),
   'NEW boundary event is recorded as context provenance on the new order');
  assert.ok(newBoundaryRevision.event_ids.includes(newBoundary.settings_event_id));
  assert.ok(newBoundaryRevision.event_ids.includes(newBoundary.file_event_id));
  assert.equal(newBoundaryRevision.event_ids.includes(newBoundary.code_event_id),false,
   'CODE bound to the old intake is not reused on the new order');
  const oldCodeBinding=(await pool.query('SELECT intake_batch_id::text,role FROM core_oa_intake_event_bindings WHERE oa_id=$1 AND event_id=$2',
   [newBoundary.oa,newBoundary.code_event_id])).rows[0];
  assert.deepEqual(oldCodeBinding,{intake_batch_id:newBoundary.intake_batch_ids[0],role:'CODE'});
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM core_oa_intake_event_bindings WHERE intake_batch_id=$1 AND event_id=$2',
   [newBoundary.intake_batch_ids[1],newBoundary.code_event_id])).rows[0].n,0,
   'old CODE remains bound only to the prior intake');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM core_order_inbound_reviews WHERE order_id=$1 AND event_id=$2',
   [newBoundaryResult.order_id,newBoundary.code_event_id])).rows[0].n,0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM core_order_inbound_reviews WHERE order_id=$1',
   [newBoundaryResult.order_id])).rows[0].n,newBoundaryRevision.event_ids.length);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM core_print_jobs WHERE order_id=$1',
   [newBoundaryResult.order_id])).rows[0].n,0,'order creation does not bypass the existing print gate');
  assert.deepEqual(await newBoundary.port.apply_incoming_batch(newBoundary.apply),
   {status:'existing',order_id:newBoundaryResult.order_id,active_revision:1},'replay stays idempotent');

  const wrong=await fixture('wrong-hash','PDF','wrong-bytes');
  await assert.rejects(wrong.port.apply_incoming_batch(wrong.apply),err('INCOMING_SOURCE_NOT_VERIFIED'));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM core_orders WHERE shop_id=$1',[wrong.shop])).rows[0].n,0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM core_print_jobs WHERE order_id IN (SELECT id FROM core_orders WHERE shop_id=$1)',[wrong.shop])).rows[0].n,0);

  const invalidSettings=await fixture('bad-settings','PDF');
  await assert.rejects(invalidSettings.port.apply_incoming_batch({...invalidSettings.apply,
   pilot_settings:{...settings,copies:0}}),err('INVALID_INCOMING_PILOT_SETTINGS'));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM core_orders WHERE shop_id=$1',[invalidSettings.shop])).rows[0].n,0);

  const expired=await fixture('expired-lease','PDF');
  await pool.query("UPDATE zalo_batches SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[expired.apply.queue_batch_id]);
  await assert.rejects(expired.port.apply_incoming_batch(expired.apply),err('INCOMING_BATCH_LEASE_LOST'));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM core_orders WHERE shop_id=$1',[expired.shop])).rows[0].n,0);

  const stale=await fixture('stale-revision','PDF');
  const staleOrder=uuid(),initialData={documents:[{artifact_name:'old/source.pdf',copies:1,duplex:false,paper:'A4'}]},
   initialHash=digest(Buffer.from(JSON.stringify(initialData)));
  await pool.query('INSERT INTO core_orders(id,shop_id,customer_id,conversation_id) VALUES($1,$2,$3,$4)',
   [staleOrder,stale.shop,stale.customer,stale.conversation]);
  await pool.query('INSERT INTO core_revisions(order_id,revision,request_hash,request_data) VALUES($1,1,$2,$3::jsonb)',
   [staleOrder,initialHash,JSON.stringify(initialData)]);
  await store.tx(db=>bindIntakeBatchToRevision(db,{intake_batch_id:stale.intake_batch_id,shop_id:stale.shop,oa_id:stale.oa,
   customer_id:stale.customer,conversation_id:stale.conversation,order_id:staleOrder,revision:1,purpose:'PILOT'}));
  await pool.query('INSERT INTO core_ai_draft_proposals(shop_id,oa_id,conversation_id,customer_id,event_fingerprint,idempotency_key,content_hash,order_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
   [stale.shop,stale.oa,stale.conversation,stale.customer,'e'.repeat(64),`prior-${stale.id}`,'f'.repeat(64),staleOrder]);
  await pool.query('INSERT INTO core_revisions(order_id,revision,request_hash,request_data) VALUES($1,2,$2,$3::jsonb)',
   [staleOrder,digest('revision-2'),JSON.stringify({documents:[{artifact_name:'new/source.pdf'}]})]);
  await pool.query('UPDATE core_orders SET active_revision=2 WHERE id=$1',[staleOrder]);
  await assert.rejects(stale.port.apply_incoming_batch(stale.apply),err('INCOMING_REVISION_CHANGED'));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM core_print_jobs WHERE order_id=$1',[staleOrder])).rows[0].n,0);
 }finally{
  for(const fixture of fixtures.reverse()){
   await pool.query('DELETE FROM core_order_inbound_reviews WHERE shop_id=$1',[fixture.shop]).catch(()=>{});
   await pool.query('DELETE FROM core_order_supplement_batches WHERE shop_id=$1',[fixture.shop]).catch(()=>{});
   await pool.query('DELETE FROM core_ai_draft_proposals WHERE shop_id=$1',[fixture.shop]).catch(()=>{});
   await pool.query('DELETE FROM core_oa_intake_event_bindings WHERE intake_batch_id IN (SELECT id FROM core_oa_intake_batches WHERE shop_id=$1)',[fixture.shop]).catch(()=>{});
   await pool.query('DELETE FROM core_oa_intake_batches WHERE shop_id=$1',[fixture.shop]).catch(()=>{});
   await pool.query('DELETE FROM ai0_pilot_private_sources WHERE shop_id=$1',[fixture.shop]).catch(()=>{});
   await pool.query('DELETE FROM core_revisions WHERE order_id IN (SELECT id FROM core_orders WHERE shop_id=$1)',[fixture.shop]).catch(()=>{});
   await pool.query('DELETE FROM core_orders WHERE shop_id=$1',[fixture.shop]).catch(()=>{});
   await pool.query('DELETE FROM core_conversation_controls WHERE shop_id=$1',[fixture.shop]).catch(()=>{});
   for(const lease of fixture.leases.reverse()){
    await pool.query('DELETE FROM zalo_batch_items WHERE oa_id=$1 AND event_id=$2',[fixture.oa,lease.event_id]).catch(()=>{});
    await pool.query('DELETE FROM zalo_process_queue WHERE oa_id=$1 AND event_id=$2',[fixture.oa,lease.event_id]).catch(()=>{});
    await pool.query('DELETE FROM zalo_inbound_events WHERE oa_id=$1 AND event_id=$2',[fixture.oa,lease.event_id]).catch(()=>{});
    await pool.query('DELETE FROM zalo_batches WHERE id=$1',[lease.queue_batch_id]).catch(()=>{});
   }
   await pool.query('DELETE FROM core_shop_zalo_oa_registry WHERE shop_id=$1',[fixture.shop]).catch(()=>{});
   await pool.query('DELETE FROM core_shop_settings WHERE shop_id=$1',[fixture.shop]).catch(()=>{});
  }
  await pool.end();
 }
});
