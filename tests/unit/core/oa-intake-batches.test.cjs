const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const root=process.env.AI1_BUILD_DIR||path.resolve(__dirname,'../../../dist/backend');
const {validateIncomingQueueBatchInput,selectIncomingQueueEvents,closeIncomingQueueBatch}=require(path.join(root,'core/oa-intake-batches.js'));

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

test('COLOR_PRINT closes only the verified leased intake as NEEDS_HUMAN',async()=>{
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
  if(sql.startsWith('SELECT id,shop_id,oa_id,customer_id,conversation_id,purpose,status,opened_at,expires_at,order_id,revision FROM core_oa_intake_batches'))
   return {rows:[{id:'00000000-0000-4000-8000-000000000099',shop_id:'shop-a',oa_id:'oa-a',
    customer_id:'customer-a',conversation_id:'chat-a',purpose:'PILOT',status:'OPEN',
    opened_at:new Date('2026-10-24T08:00:00.000Z'),expires_at:new Date('2026-10-24T08:30:00.000Z'),
    order_id:null,revision:null}],rowCount:1};
  if(sql.startsWith('SELECT 1 FROM zalo_batch_items q JOIN core_oa_intake_event_bindings'))return {rows:[{}],rowCount:1};
  if(sql.startsWith('UPDATE core_oa_intake_batches SET status=$2,close_reason=$3'))return {rows:[],rowCount:1};
  return {rows:[],rowCount:0};
 }};
 const store={async tx(fn){return fn(db)}};
 const receipt=await closeIncomingQueueBatch(store,{intake_batch_id:'00000000-0000-4000-8000-000000000099',
  queue_batch_id:'41',lease_token:lease.lease_token,reason:'COLOR_PRINT'});
 assert.deepEqual(receipt,{status:'NEEDS_HUMAN',intake_batch_id:'00000000-0000-4000-8000-000000000099'});
 const update=calls.find(call=>call.sql.startsWith('UPDATE core_oa_intake_batches SET status=$2,close_reason=$3'));
 assert.deepEqual(update.args,['00000000-0000-4000-8000-000000000099','NEEDS_HUMAN','COLOR_PRINT']);
});
