const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const root=process.env.AI1_BUILD_DIR||path.resolve(__dirname,'../../../dist/backend');
const {validateIncomingQueueBatchInput,selectIncomingQueueEvents,acceptIncomingQueueBatch,
 closeIncomingQueueBatch}=require(path.join(root,'core/oa-intake-batches.js'));

const lease={batch_id:'41',lease_token:'00000000-0000-4000-8000-000000000041',attempts:1,
 key:'test',first_at:1,deadline_at:2,events:[
  {event_id:'code-1',oa_id:'oa-a',customer_id:'customer-a',conversation_id:'chat-a',kind:'text',
   source_text:'secret code must not appear in snapshot',received_at:new Date('2026-10-22T00:00:00Z'),queue_batch_id:'41'},
  {event_id:'file-1',oa_id:'oa-a',customer_id:'customer-a',conversation_id:'chat-a',kind:'file',
   source_text:null,received_at:new Date('2026-10-22T00:00:01Z'),queue_batch_id:'41'}],server_received_event_ids:['code-1','file-1']};

test('Core batch request accepts only the leased queue reference and bounded selectors',()=>{
 const value={queue_batch_id:'41',lease_token:lease.lease_token,purpose:'PILOT',event_ids:['code-1'],
  selection:{code_event_id:'code-1'}};
 assert.deepEqual(validateIncomingQueueBatchInput(value),value);
 assert.throws(()=>validateIncomingQueueBatchInput({...value,event_ids:['code-1','code-1']}),
  error=>'INCOMING_EVENT_SELECTOR_DUPLICATE'===error.code);
 assert.throws(()=>validateIncomingQueueBatchInput({...value,caller_shop_id:'shop-a'}),
  error=>'INCOMING_BATCH_INVALID'===error.code);
});

test('event_ids are selectors verified against durable leased membership and are returned in DB receipt order',()=>{
 assert.deepEqual(selectIncomingQueueEvents(lease,['file-1','code-1']).map(event=>event.event_id),['code-1','file-1']);
 assert.throws(()=>selectIncomingQueueEvents(lease,['old-code-event']),
  error=>'INCOMING_EVENT_MEMBERSHIP_DENIED'===error.code);
 assert.throws(()=>selectIncomingQueueEvents(lease,['code-1','code-1']),
  error=>'INCOMING_EVENT_SELECTOR_DUPLICATE'===error.code);
});

function closeFixture({status='OPEN',closeReason=null,updateReceipt={status:'NEEDS_HUMAN',close_reason:'COLOR_PRINT'}}={}){
 const calls=[];
 const db={async query(sql,args=[]){
  calls.push({sql,args});
  if(sql.includes('to_regclass'))return {rows:[{zalo_batches:'zalo_batches',batch_items:'zalo_batch_items',
   events:'zalo_inbound_events',intake:'core_oa_intake_batches',bindings:'core_oa_intake_event_bindings',
   oa_registry:'core_shop_zalo_oa_registry',batch_oa:true,new_order_requested:true}],rowCount:1};
  if(sql.startsWith('SELECT id::text,oa_id,event_count,status,lease_token::text,lease_until FROM zalo_batches'))
   return {rows:[{id:'41',oa_id:'oa-a',event_count:1,status:'LEASED',lease_token:lease.lease_token,
    lease_until:new Date('2026-10-24T09:00:00.000Z')}],rowCount:1};
  if(sql.startsWith('SELECT clock_timestamp()'))return {rows:[{now:new Date('2026-10-24T08:30:00.000Z')}],rowCount:1};
  if(sql.includes('FROM zalo_batch_items i JOIN zalo_inbound_events'))return {rows:[{
   event_id:'code-1',oa_id:'oa-a',customer_id:'customer-a',conversation_id:'chat-a',kind:'text',
   source_text:'Mã cửa hàng: ABCDEFGHJK',received_at:new Date('2026-10-24T08:20:00.000Z'),queue_batch_id:'41'
  }],rowCount:1};
  if(sql.startsWith('SELECT id,shop_id,oa_id,customer_id,conversation_id,purpose,status,opened_at,expires_at,order_id,revision,close_reason FROM core_oa_intake_batches'))
   return {rows:[{id:'00000000-0000-4000-8000-000000000099',shop_id:'shop-a',oa_id:'oa-a',
    customer_id:'customer-a',conversation_id:'chat-a',purpose:'PILOT',status,close_reason:closeReason,
    opened_at:new Date('2026-10-24T08:00:00.000Z'),expires_at:new Date('2026-10-24T08:30:00.000Z'),
    order_id:null,revision:null}],rowCount:1};
  if(sql.startsWith('SELECT 1 FROM zalo_batch_items q JOIN core_oa_intake_event_bindings'))return {rows:[{}],rowCount:1};
  if(sql.startsWith('UPDATE core_oa_intake_batches SET status=$2,close_reason=$3'))
   return {rows:updateReceipt?[updateReceipt]:[],rowCount:updateReceipt?1:0};
  return {rows:[],rowCount:0};
 }};
 return {calls,store:{async tx(fn){return fn(db)}}};
}
const colorCloseInput={intake_batch_id:'00000000-0000-4000-8000-000000000099',
 queue_batch_id:'41',lease_token:lease.lease_token,reason:'COLOR_PRINT'};

test('COLOR_PRINT closes only the verified leased intake as NEEDS_HUMAN',async()=>{
 const {store,calls}=closeFixture();
 const receipt=await closeIncomingQueueBatch(store,colorCloseInput);
 assert.deepEqual(receipt,{status:'NEEDS_HUMAN',intake_batch_id:colorCloseInput.intake_batch_id,close_reason:'COLOR_PRINT'});
 const update=calls.find(call=>call.sql.startsWith('UPDATE core_oa_intake_batches SET status=$2,close_reason=$3'));
 assert.deepEqual(update.args,[colorCloseInput.intake_batch_id,'NEEDS_HUMAN','COLOR_PRINT']);
});

test('pre-closed intake receipt exposes its existing reason without overwriting it',async()=>{
 for(const closeReason of ['ORDER_ALREADY_AUTHORIZED','COLOR_PRINT']){
  const {store,calls}=closeFixture({status:'NEEDS_HUMAN',closeReason});
  const receipt=await closeIncomingQueueBatch(store,colorCloseInput);
  assert.deepEqual(receipt,{status:'NEEDS_HUMAN',intake_batch_id:colorCloseInput.intake_batch_id,close_reason:closeReason});
  assert.equal(calls.some(call=>call.sql.startsWith('UPDATE core_oa_intake_batches SET status=$2,close_reason=$3')),false);
 }
});

test('close receipt fails if the persisted status/reason cannot be verified',async()=>{
 for(const updateReceipt of [null,{status:'NEEDS_HUMAN',close_reason:'ORDER_ALREADY_AUTHORIZED'}]){
  const {store}=closeFixture({updateReceipt});
  await assert.rejects(closeIncomingQueueBatch(store,colorCloseInput),
   error=>error.code==='INCOMING_BATCH_CLOSE_FAILED');
 }
});

const continueColorInput={queue_batch_id:'41',lease_token:lease.lease_token,purpose:'PILOT',
 boundary:'CONTINUE',event_ids:['color-1'],selection:{settings_event_ids:['color-1']}};
function closedContinueFixture({status='NEEDS_HUMAN',closeReason='COLOR_PRINT',bindingChanges={},extraBinding=false}={}){
 const calls=[],receivedAt=new Date('2026-10-24T08:20:00.000Z');
 const binding={id:colorCloseInput.intake_batch_id,shop_id:'shop-a',oa_id:'oa-a',
  customer_id:'customer-a',conversation_id:'chat-a',purpose:'PILOT',status,
  close_reason:closeReason,opened_at:new Date('2026-10-24T08:00:00.000Z'),
  expires_at:new Date('2026-10-24T08:30:00.000Z'),order_id:null,revision:null,
  event_id:'color-1',queue_batch_id:'41',received_at:receivedAt,event_kind:'text',role:'SETTINGS',
  ...bindingChanges};
 const bindings=extraBinding?[binding,{...binding,event_id:'extra'}]:[binding];
 const db={async query(sql,args=[]){
  calls.push({sql,args});
  if(sql.includes('to_regclass'))return {rows:[{zalo_batches:'zalo_batches',batch_items:'zalo_batch_items',
   events:'zalo_inbound_events',intake:'core_oa_intake_batches',bindings:'core_oa_intake_event_bindings',
   oa_registry:'core_shop_zalo_oa_registry',batch_oa:true,new_order_requested:true}],rowCount:1};
  if(sql.startsWith('SELECT id::text,oa_id,event_count,status,lease_token::text,lease_until FROM zalo_batches'))
   return {rows:[{id:'41',oa_id:'oa-a',event_count:1,status:'LEASED',lease_token:lease.lease_token,
    lease_until:new Date('2026-10-24T09:00:00.000Z')}],rowCount:1};
  if(sql.startsWith('SELECT clock_timestamp()'))return {rows:[{now:new Date('2026-10-24T08:25:00.000Z')}],rowCount:1};
  if(sql.includes('FROM zalo_batch_items i JOIN zalo_inbound_events'))return {rows:[{
   event_id:'color-1',oa_id:'oa-a',customer_id:'customer-a',conversation_id:'chat-a',kind:'text',
   source_text:'In màu',received_at:receivedAt,queue_batch_id:'41'}],rowCount:1};
  if(sql.startsWith('SELECT shop_id FROM core_shop_zalo_oa_registry'))return {rows:[{shop_id:'shop-a'}],rowCount:1};
  if(sql.startsWith('SELECT pg_advisory_xact_lock'))return {rows:[],rowCount:1};
  if(sql.startsWith("UPDATE core_oa_intake_batches SET status='EXPIRED'"))return {rows:[],rowCount:0};
  if(sql.includes('WHERE b.oa_id=$1 AND (b.queue_batch_id=$2::bigint OR b.event_id=ANY($3::text[]))')){
   assert.deepEqual(args,['oa-a','41',['color-1']]);return {rows:bindings,rowCount:bindings.length};
  }
  if(sql.startsWith('SELECT event_id,event_kind,role,received_at FROM core_oa_intake_event_bindings'))
   return {rows:[{event_id:'color-1',event_kind:'text',role:'SETTINGS',received_at:receivedAt}],rowCount:1};
  if(sql.startsWith('SET TRANSACTION'))return {rows:[],rowCount:0};
  throw new Error('unexpected Core replay query');
 }};
 return {calls,store:{async tx(fn){return fn(db)}}};
}

test('actual Core CONTINUE replay returns the same closed color intake without creating another one',async()=>{
 const {store,calls}=closedContinueFixture();
 const first=await acceptIncomingQueueBatch(store,continueColorInput);
 const second=await acceptIncomingQueueBatch(store,continueColorInput);
 assert.deepEqual(second,first);
 assert.equal(first.status,'NEEDS_HUMAN');
 assert.equal(first.close_reason,'COLOR_PRINT');
 assert.equal(first.intake_batch_id,colorCloseInput.intake_batch_id);
 assert.deepEqual(first.events.map(event=>[event.event_id,event.role]),[['color-1','SETTINGS']]);
 assert.equal(calls.some(call=>call.sql.startsWith('INSERT INTO core_oa_intake_batches')),false);
 assert.equal(calls.some(call=>call.sql.startsWith('SELECT id,shop_id,oa_id,customer_id,conversation_id,purpose,status,opened_at,expires_at,order_id,revision,new_order_requested FROM core_oa_intake_batches')),false);
});

test('actual Core replay preserves another human reason and rejects changed queue bindings',async()=>{
 const other=closedContinueFixture({closeReason:'ORDER_ALREADY_AUTHORIZED'});
 const snapshot=await acceptIncomingQueueBatch(other.store,continueColorInput);
 assert.equal(snapshot.status,'NEEDS_HUMAN');
 assert.equal(snapshot.close_reason,'ORDER_ALREADY_AUTHORIZED');
 for(const changes of [{bindingChanges:{shop_id:'shop-b'}},{bindingChanges:{queue_batch_id:'40'}},
  {extraBinding:true},{bindingChanges:{role:'CODE'}},{status:'CLOSED',closeReason:'ABANDONED'}]){
  const {store}=closedContinueFixture(changes);
  await assert.rejects(acceptIncomingQueueBatch(store,continueColorInput),
   error=>['INCOMING_EVENT_ALREADY_BOUND','INCOMING_EVENT_ROLE_CONFLICT'].includes(error.code));
 }
});
