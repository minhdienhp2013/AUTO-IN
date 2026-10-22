const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const root=process.env.AI1_BUILD_DIR||path.resolve(__dirname,'../../../dist/backend');
const {validateIncomingQueueBatchInput,selectIncomingQueueEvents}=require(path.join(root,'core/oa-intake-batches.js'));

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
