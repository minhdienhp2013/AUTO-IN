const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const root=process.env.AI1_BUILD_DIR||path.resolve(__dirname,'../../../.ai1-build/backend');
const {PgStore}=require(path.join(root,'storage/database.js'));
const {createCustomerPrintChoicePort,CUSTOMER_PRINT_CHOICES_SCHEMA}=require(
 path.join(root,'core/customer-print-choice-port.js'));
const {sha,canonical}=require(path.join(root,'core/model.js'));
let pg;try{pg=require('pg');}catch{/* installed in CI */}
const url=process.env.TEST_DATABASE_URL,ready=Boolean(pg&&url);
const key=prefix=>prefix+'-'+randomUUID();
const nowIso=()=>new Date().toISOString();

test('REAL PostgreSQL customer print-choice evidence is scope/hash/source bound and side-effect free',
 {skip:!ready&&'Requires isolated TEST_DATABASE_URL and pg'},async t=>{
 const a=new pg.Pool({connectionString:url,max:8}),b=new pg.Pool({connectionString:url,max:8});
 try{
  const dbName=(await a.query('SELECT current_database() AS name')).rows[0].name;
  assert.match(dbName,/test/i,'Refuse a non-test database');
  const [pidA,pidB]=await Promise.all([a.query('SELECT pg_backend_pid() pid'),b.query('SELECT pg_backend_pid() pid')]);
  assert.notEqual(pidA.rows[0].pid,pidB.rows[0].pid,'Use two independent PostgreSQL pools');
  for(const [pool,file] of [
   [a,'../../../backend/storage/migrations/005_ai_order_port.sql'],
   [a,'../../../backend/storage/migrations/007_active_order_inbound.sql'],
   [a,'../../../backend/integrations/zalo/migrations/001_zalo_durable.sql'],
   [a,'../../../backend/composition/migrations/001_document_artifacts.sql'],
   [a,'../../../backend/composition/migrations/003_inbound_drafts.sql'],
   [a,'../../../backend/composition/migrations/006_source_adoption_receipts.sql'],
   [a,'../../../backend/storage/migrations/010_customer_print_choice_evidence.sql']
  ]) await pool.query(fs.readFileSync(path.resolve(__dirname,file),'utf8'));

  const storeA=new PgStore(a),storeB=new PgStore(b);
  const verify=async binding=>binding.shop_id.length>0&&binding.oa_id.length>0&&
   /^[a-f0-9]{64}$/.test(binding.request_hash)&&/^[a-f0-9]{64}$/.test(binding.source_sha256)&&
   binding.artifact_ref.includes(binding.source_sha256);
  async function fixture({staffDefaults=true}={}){
   const shop=key('choice-shop'),oa=key('choice-oa'),customer=key('choice-customer'),
    conversation=key('choice-chat'),actorId=randomUUID(),orderId=randomUUID(),sourceEvent=key('source-event');
   const sourceSha=sha(key('sealed-source')),file=`doc-fixture01/source-000-${sourceSha}.pdf`;
   const initialData={source:'zalo_ai_suggestion',conversation_id:conversation,event_ids:[sourceEvent],text:'Gửi tài liệu'};
   const adoptedData={documents:[{artifact_name:file,...(staffDefaults?{copies:7,paper:'A4',duplex:true}:{})}]};
   const initialHash=sha(canonical(initialData)),adoptedHash=sha(canonical(adoptedData));
   const settingsHash=sha(canonical({request_data:adoptedData,customer_id:customer,
    conversation_id:conversation,sha256:sourceSha}));
   const proposalFingerprint=sha(canonical({conversation_id:conversation,event_ids:[sourceEvent]}));
   await a.query('INSERT INTO core_shop_settings(shop_id,mode) VALUES($1,\'simulation\')',[shop]);
   await a.query('INSERT INTO core_orders(id,shop_id,customer_id,conversation_id,active_revision) VALUES($1,$2,$3,$4,2)',
    [orderId,shop,customer,conversation]);
   await a.query('INSERT INTO core_revisions(order_id,revision,request_hash,request_data) VALUES($1,1,$2,$3::jsonb)',
    [orderId,initialHash,JSON.stringify(initialData)]);
   await a.query('INSERT INTO core_revisions(order_id,revision,request_hash,request_data) VALUES($1,2,$2,$3::jsonb)',
    [orderId,adoptedHash,JSON.stringify(adoptedData)]);
   await a.query('INSERT INTO core_conversation_controls(shop_id,conversation_id,status,generation) VALUES($1,$2,\'AI\',0)',
    [shop,conversation]);
   await a.query('INSERT INTO core_ai_draft_proposals(shop_id,oa_id,conversation_id,customer_id,event_fingerprint,idempotency_key,content_hash,order_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    [shop,oa,conversation,customer,proposalFingerprint,key('proposal'),sha('synthetic-proposal'),orderId]);
   const sourcePayload={kind:'file',filename:'print.pdf',customer_id:customer,conversation_id:conversation};
   await a.query('INSERT INTO zalo_inbound_events(oa_id,event_id,conversation_id,customer_id,occurred_at,received_at,payload_json) VALUES($1,$2,$3,$4,now(),now()-interval \'5 minutes\',$5::jsonb)',
    [oa,sourceEvent,conversation,customer,JSON.stringify(sourcePayload)]);
   await a.query('INSERT INTO ai0_inbound_document_artifacts(shop_id,oa_id,event_id,conversation_id,customer_id,artifact_ref,sha256,manifest_ref,manifest_sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [shop,oa,sourceEvent,conversation,customer,file,sourceSha,file.split('/')[0]+'/manifest.json',sha('synthetic-manifest')]);
   await a.query('INSERT INTO ai0_inbound_artifact_drafts(shop_id,oa_id,event_id,actor_id,settings_sha256,status,order_id,created_at,completed_at) VALUES($1,$2,$3,$4,$5,\'CREATED\',$6,now()-interval \'4 minutes\',now()-interval \'4 minutes\')',
    [shop,oa,sourceEvent,actorId,settingsHash,orderId]);
   const processor={id:actorId,shop_id:shop,role:'processor',verified:true};
   const portA=createCustomerPrintChoicePort({store:storeA,trusted:{shop_id:shop,oa_id:oa},processor,verify_sealed_source:verify});
   const portB=createCustomerPrintChoicePort({store:storeB,trusted:{shop_id:shop,oa_id:oa},processor,verify_sealed_source:verify});
   const addEvent=async(text,{oaId=oa,customerId=customer,conversationId=conversation,kind='text'}={})=>{
    const eventId=key('choice-event');
    await a.query('INSERT INTO zalo_inbound_events(oa_id,event_id,conversation_id,customer_id,occurred_at,received_at,payload_json) VALUES($1,$2,$3,$4,now(),now(),$5::jsonb)',
     [oaId,eventId,conversationId,customerId,JSON.stringify({kind,text})]);
    return eventId;
   };
   const base={order_id:orderId,expected_revision:2,expected_request_hash:adoptedHash,
    expected_source_sha256:sourceSha,idempotency_key:key('choice-batch')};
   return {shop,oa,customer,conversation,orderId,sourceEvent,sourceSha,file,initialData,adoptedData,
    adoptedHash,processor,portA,portB,base,addEvent};
  }
  async function snapshot(pool,orderId){
   return (await pool.query(
    'SELECT (SELECT active_revision FROM core_orders WHERE id=$1) active_revision,'+
    '(SELECT count(*)::int FROM core_revisions WHERE order_id=$1) revisions,'+
    '(SELECT count(*)::int FROM core_order_inbound_reviews WHERE order_id=$1) reviews,'+
    '(SELECT count(*)::int FROM core_order_customer_print_choice_batches WHERE order_id=$1) batches,'+
    '(SELECT count(*)::int FROM core_order_customer_print_choice_evidence WHERE order_id=$1) evidence,'+
    '(SELECT plan IS NOT NULL FROM core_revisions WHERE order_id=$1 AND revision=(SELECT active_revision FROM core_orders WHERE id=$1)) ready,'+
    '(SELECT plan FROM core_revisions WHERE order_id=$1 AND revision=(SELECT active_revision FROM core_orders WHERE id=$1)) active_plan,'+
    '(SELECT count(*)::int FROM core_confirmations WHERE order_id=$1) confirmations,'+
    '(SELECT count(*)::int FROM core_approvals WHERE order_id=$1) approvals,'+
    '(SELECT count(*)::int FROM core_print_jobs WHERE order_id=$1) print_jobs,'+
    '(SELECT count(*)::int FROM zalo_outbound WHERE conversation_id=(SELECT conversation_id FROM core_orders WHERE id=$1)) zalo_replies',
    [orderId])).rows[0];
  }
  async function inputFor(f,texts){
   return {...f.base,event_ids:await Promise.all(texts.map(text=>f.addEvent(text)))};
  }
  async function unchanged(f,operation){
   const before=await snapshot(a,f.orderId);
   await assert.rejects(operation);
   assert.deepEqual(await snapshot(a,f.orderId),before,'rejected evidence has no mutation');
  }

  await t.test('exact customer literals create normalized, source-bound revision evidence; replay races are once-only',async()=>{
   const f=await fixture();
   const choiceInput=await inputFor(f,['in 2 bản','đổi khổ giấy sang A3','in hai mặt']);
   const [one,two]=await Promise.all([f.portA.apply(choiceInput),f.portB.apply(choiceInput)]);
   assert.deepEqual([one.status,two.status].sort(),['appended','existing']);
   const applied=one.status==='appended'?one:two;
   const replay=one.status==='existing'?one:two;
   assert.equal(applied.revision,3);assert.equal(replay.request_hash,applied.request_hash);
   assert.deepEqual(applied.fields,['copies','duplex','paper_size']);
   const rev=(await a.query('SELECT request_hash,request_data,plan FROM core_revisions WHERE order_id=$1 AND revision=3',[f.orderId])).rows[0];
   assert.equal(rev.request_hash,applied.request_hash);
   assert.equal(rev.request_hash,sha(canonical(rev.request_data)));
   assert.equal(rev.plan,null);
   assert.equal(rev.request_data.customer_print_choices.schema_version,CUSTOMER_PRINT_CHOICES_SCHEMA);
   assert.deepEqual(rev.request_data.customer_print_choices.fields.copies,
    {value:2,origin:'customer',event_id:choiceInput.event_ids[0],parser_version:'vn-print-setting.literal.v1'});
   assert.equal(rev.request_data.customer_print_choices.fields.paper_size.value,'A3');
   assert.equal(rev.request_data.customer_print_choices.fields.duplex.value,true);
   assert.deepEqual(rev.request_data.documents,f.adoptedData.documents,'staff adoption defaults remain intact and distinct');
   const evidence=(await a.query('SELECT shop_id,oa_id,customer_id,conversation_id,order_id::text,revision,'+
    'source_event_id,source_sha256,request_hash,field,value,origin,event_id,event_revision,parser_version '+
    'FROM core_order_customer_print_choice_evidence WHERE order_id=$1 ORDER BY field',[f.orderId])).rows;
   assert.equal(evidence.length,3);
   for(const row of evidence){
    assert.equal(row.shop_id,f.shop);assert.equal(row.oa_id,f.oa);assert.equal(row.customer_id,f.customer);
    assert.equal(row.conversation_id,f.conversation);assert.equal(row.revision,3);
    assert.equal(row.source_event_id,f.sourceEvent);assert.equal(row.source_sha256,f.sourceSha);
    assert.equal(row.request_hash,applied.request_hash);assert.equal(row.origin,'customer');
    assert.equal(row.event_revision,3);assert.equal(row.parser_version,'vn-print-setting.literal.v1');
   }
   assert.equal((await a.query('SELECT active_revision FROM core_orders WHERE id=$1',[f.orderId])).rows[0].active_revision,3);
   assert.deepEqual(await snapshot(a,f.orderId),{
    active_revision:3,revisions:3,reviews:3,batches:1,evidence:3,ready:false,active_plan:null,
    confirmations:0,approvals:0,print_jobs:0,zalo_replies:0
   });
   const wrongPayload={...choiceInput,duplex:false};
   await assert.rejects(f.portA.apply(wrongPayload),e=>e.code==='CUSTOMER_PRINT_CHOICE_INVALID_INPUT');
   await assert.rejects(f.portA.apply({...choiceInput,
    event_ids:[await f.addEvent('in 4 bản')]}),e=>e.code==='CUSTOMER_PRINT_CHOICE_IDEMPOTENCY_CONFLICT');
   assert.equal((await a.query('SELECT count(*)::int n FROM core_revisions WHERE order_id=$1',[f.orderId])).rows[0].n,3);
  });

  await t.test('a later capture does not carry older revision evidence forward',async()=>{
   const f=await fixture(),firstEvent=await f.addEvent('in 2 bản');
   const first=await f.portA.apply({...f.base,event_ids:[firstEvent]});
   const secondEvent=await f.addEvent('đổi khổ giấy sang A3');
   const second=await f.portA.apply({order_id:f.orderId,expected_revision:first.revision,
    expected_request_hash:first.request_hash,expected_source_sha256:f.sourceSha,
    idempotency_key:key('new-capture'),event_ids:[secondEvent]});
   assert.equal(second.revision,4);
   const revision=(await a.query('SELECT request_hash,request_data,plan FROM core_revisions WHERE order_id=$1 AND revision=4',
    [f.orderId])).rows[0];
   assert.equal(revision.request_hash,second.request_hash);
   assert.equal(revision.request_hash,sha(canonical(revision.request_data)));
   assert.equal(revision.plan,null);
   assert.deepEqual(Object.keys(revision.request_data.customer_print_choices.fields),['paper_size']);
   assert.deepEqual(revision.request_data.customer_print_choices.fields.paper_size,
    {value:'A3',origin:'customer',event_id:secondEvent,parser_version:'vn-print-setting.literal.v1'});
   const evidence=(await a.query('SELECT revision,field,event_id,event_revision,request_hash FROM core_order_customer_print_choice_evidence '+
    'WHERE order_id=$1 ORDER BY revision,field',[f.orderId])).rows;
   assert.deepEqual(evidence.map(row=>[row.revision,row.field,row.event_id,row.event_revision]),
    [[3,'copies',firstEvent,3],[4,'paper_size',secondEvent,4]]);
   assert.equal(evidence[0].request_hash,first.request_hash);
   assert.equal(evidence[1].request_hash,second.request_hash);
   assert.deepEqual(await snapshot(a,f.orderId),{
    active_revision:4,revisions:4,reviews:2,batches:2,evidence:2,ready:false,active_plan:null,
    confirmations:0,approvals:0,print_jobs:0,zalo_replies:0
   });
  });

  await t.test('evidence copied into a later revision is stale and blocks trigger',async()=>{
   const f=await fixture(),firstEvent=await f.addEvent('in 2 bản');
   const first=await f.portA.apply({...f.base,event_ids:[firstEvent]});
   await a.query('INSERT INTO core_revisions(order_id,revision,request_hash,request_data,plan) '+
    'SELECT order_id,4,request_hash,request_data,NULL FROM core_revisions WHERE order_id=$1 AND revision=$2',
    [f.orderId,first.revision]);
   await a.query('UPDATE core_orders SET active_revision=4 WHERE id=$1',[f.orderId]);
   const before=await snapshot(a,f.orderId),newEvent=await f.addEvent('in 3 bản');
   await assert.rejects(f.portA.apply({order_id:f.orderId,expected_revision:4,
    expected_request_hash:first.request_hash,expected_source_sha256:f.sourceSha,
    idempotency_key:key('stale-copied-choice'),event_ids:[newEvent]}),
    e=>e.code==='CUSTOMER_PRINT_CHOICE_EVIDENCE_TAMPERED');
   assert.deepEqual(await snapshot(a,f.orderId),before);
  });

  await t.test('wrong shop, OA, customer, conversation, and order cannot bind event IDs',async()=>{
   const f=await fixture(),valid=await f.addEvent('in 3 bản');
   const before=await snapshot(a,f.orderId);
   const otherShop=key('foreign-shop'),wrongShopProcessor={id:randomUUID(),shop_id:otherShop,role:'processor',verified:true};
   await a.query('INSERT INTO core_shop_settings(shop_id) VALUES($1)',[otherShop]);
   const wrongShop=createCustomerPrintChoicePort({store:storeA,trusted:{shop_id:otherShop,oa_id:f.oa},
    processor:wrongShopProcessor,verify_sealed_source:verify});
   await assert.rejects(wrongShop.apply({...f.base,event_ids:[valid]}),e=>e.code==='CUSTOMER_PRINT_CHOICE_ORDER_SCOPE');
   const wrongOa=createCustomerPrintChoicePort({store:storeA,trusted:{shop_id:f.shop,oa_id:key('wrong-oa')},
    processor:f.processor,verify_sealed_source:verify});
   await assert.rejects(wrongOa.apply({...f.base,event_ids:[valid]}),e=>e.code==='CUSTOMER_PRINT_CHOICE_SOURCE_NOT_ADOPTED');
   for(const overrides of [{customerId:key('wrong-customer')},{conversationId:key('wrong-chat')}]){
    const id=await f.addEvent('in 3 bản',overrides);
    await assert.rejects(f.portA.apply({...f.base,idempotency_key:key('scope'),event_ids:[id]}),
     e=>e.code==='CUSTOMER_PRINT_CHOICE_EVENT_SCOPE');
   }
   const other=await fixture();
   await assert.rejects(other.portA.apply({...other.base,event_ids:[valid]}),e=>e.code==='CUSTOMER_PRINT_CHOICE_EVENT_SCOPE');
   assert.deepEqual(await snapshot(a,f.orderId),before);
   assert.equal((await a.query('SELECT active_revision FROM core_orders WHERE id=$1',[other.orderId])).rows[0].active_revision,2);
  });

  await t.test('stale revision, request hash, source SHA, altered request data and tampered sealed source fail closed',async()=>{
   const f=await fixture(),event=await f.addEvent('in 3 bản');
   const before=await snapshot(a,f.orderId);
   await assert.rejects(f.portA.apply({...f.base,expected_revision:3,event_ids:[event]}),
    e=>e.code==='CUSTOMER_PRINT_CHOICE_STALE_REVISION');
   await assert.rejects(f.portA.apply({...f.base,expected_request_hash:sha('wrong-hash'),event_ids:[event]}),
    e=>e.code==='CUSTOMER_PRINT_CHOICE_STALE_BINDING');
   await assert.rejects(f.portA.apply({...f.base,expected_source_sha256:sha('wrong-source'),event_ids:[event]}),
    e=>e.code==='CUSTOMER_PRINT_CHOICE_STALE_BINDING');
   await a.query("UPDATE core_revisions SET request_data=jsonb_set(request_data,'{tamper}','true'::jsonb) WHERE order_id=$1 AND revision=2",[f.orderId]);
   await assert.rejects(f.portA.apply({...f.base,idempotency_key:key('request-tamper'),event_ids:[event]}),
    e=>e.code==='CUSTOMER_PRINT_CHOICE_STALE_BINDING');
   await a.query('UPDATE core_revisions SET request_data=$2::jsonb WHERE order_id=$1 AND revision=2',
    [f.orderId,JSON.stringify(f.adoptedData)]);
   const tamperedSourceSha=sha('tampered-source');
   const tamperedArtifactRef=f.file.replace(f.sourceSha,tamperedSourceSha);
   const tamperedAdoptionData={documents:[{...f.adoptedData.documents[0],artifact_name:tamperedArtifactRef}]};
   const tamperedRequestHash=sha(canonical(tamperedAdoptionData));
   await a.query('UPDATE ai0_inbound_document_artifacts SET artifact_ref=$4,sha256=$5 WHERE shop_id=$1 AND oa_id=$2 AND event_id=$3',
    [f.shop,f.oa,f.sourceEvent,tamperedArtifactRef,tamperedSourceSha]);
   await a.query('UPDATE core_revisions SET request_hash=$2,request_data=$3::jsonb WHERE order_id=$1 AND revision=2',
    [f.orderId,tamperedRequestHash,JSON.stringify(tamperedAdoptionData)]);
   await assert.rejects(f.portA.apply({...f.base,idempotency_key:key('source-tamper'),
    expected_request_hash:tamperedRequestHash,expected_source_sha256:tamperedSourceSha,event_ids:[event]}),
    e=>e.code==='CUSTOMER_PRINT_CHOICE_ADOPTION_TAMPERED');
   assert.deepEqual(await snapshot(a,f.orderId),before);
  });

  await t.test('sealed-source verifier false and throw fail closed without READY or outbound mutations',async t2=>{
   for(const [name,verify_sealed_source] of [
    ['returns false',async()=>false],
    ['throws',async()=>{throw new Error('synthetic verifier failure');}]
   ]) await t2.test(name,async()=>{
    const f=await fixture(),event=await f.addEvent('in 2 bản');
    const guarded=createCustomerPrintChoicePort({store:storeA,
     trusted:{shop_id:f.shop,oa_id:f.oa},processor:f.processor,verify_sealed_source});
    const before=await snapshot(a,f.orderId);
    assert.equal(before.ready,false);assert.equal(before.active_plan,null);
    await assert.rejects(guarded.apply({...f.base,event_ids:[event]}),
     error=>error.code==='CUSTOMER_PRINT_CHOICE_SOURCE_UNVERIFIED');
    assert.deepEqual(await snapshot(a,f.orderId),before,
     `verifier ${name} must preserve revisions, evidence, reviews, READY, approvals, print jobs and outbound`);
   });
  });

  await t.test('ambiguous text, repeated field contradiction and existing evidence tamper need review',async()=>{
   const ambiguous=await fixture(),bad=await ambiguous.addEvent('in 2 bản khổ A4');
   await unchanged(ambiguous,()=>ambiguous.portA.apply({...ambiguous.base,event_ids:[bad]}));
   const contradictory=await fixture(),conflict=await inputFor(contradictory,['in 2 bản','in 3 bản']);
   await unchanged(contradictory,()=>contradictory.portA.apply(conflict));
   const tampered=await fixture(),first=await inputFor(tampered,['in 2 bản']);
   const accepted=await tampered.portA.apply(first);
   await a.query("UPDATE core_order_customer_print_choice_evidence SET value='99'::jsonb WHERE order_id=$1 AND revision=$2 AND field='copies'",
    [tampered.orderId,accepted.revision]);
   const nextEvent=await tampered.addEvent('đổi khổ giấy sang A5');
   await assert.rejects(tampered.portA.apply({order_id:tampered.orderId,expected_revision:accepted.revision,
    expected_request_hash:accepted.request_hash,expected_source_sha256:tampered.sourceSha,
    idempotency_key:key('after-tamper'),event_ids:[nextEvent]}),
    e=>e.code==='CUSTOMER_PRINT_CHOICE_EVIDENCE_TAMPERED');
   assert.equal((await a.query('SELECT active_revision FROM core_orders WHERE id=$1',[tampered.orderId])).rows[0].active_revision,accepted.revision);
   assert.equal((await a.query('SELECT count(*)::int n FROM core_confirmations WHERE order_id=$1',[tampered.orderId])).rows[0].n,0);
   assert.equal((await a.query('SELECT count(*)::int n FROM core_approvals WHERE order_id=$1',[tampered.orderId])).rows[0].n,0);
   assert.equal((await a.query('SELECT count(*)::int n FROM core_print_jobs WHERE order_id=$1',[tampered.orderId])).rows[0].n,0);
   assert.equal((await a.query('SELECT count(*)::int n FROM zalo_outbound WHERE conversation_id=$1',[tampered.conversation])).rows[0].n,0);
  });
 }finally{await Promise.all([a.end(),b.end()]);}
});
