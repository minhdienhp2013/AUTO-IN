import test from 'node:test';
import assert from 'node:assert/strict';
import {ConversationProcessor} from '../../../backend/conversation/processor.ts';
const evt=(id,text='In A4',extra={})=>({
 event_id:id,oa_id:'oa-safe',customer_id:'customer',conversation_id:'chat',
 occurred_at:'2026-10-12T01:00:00Z',kind:'text',text,...extra
});
const batch=(...events)=>({key:'zalo-batch',first_at:0,deadline_at:60000,events});
const gate={async read(){return {mode:'AI',generation:7,conversation_id:'chat'}}};
const documents={async inspect(batch){return batch.events.filter(e=>e.kind==='image'||e.kind==='file').map(e=>({kind:e.kind==='image'?'image':'pdf',preview_trusted:true}))}};
function processor(orders,replies=[]){
 return new ConversationProcessor(gate,documents,orders,{async enqueue(item){replies.push(item)}});
}
test('separate batches >60 seconds append to one order and advance revision',async()=>{
 let revision=0;const seen=[],replies=[],events=new Set();
 const orders={
   async suggest_draft(){assert.fail('legacy proposal must not run')},
   async route_human(){assert.fail('append must not trigger human takeover')},
   async apply_incoming_batch(input){
     seen.push(input);
     assert.deepEqual(input.scope,{oa_id:'oa-safe',customer_id:'customer',conversation_id:'chat'});
     assert.equal(input.expected_generation,7);
     if(events.has(input.event_ids[0]))return {status:'existing',order_id:'order-1'};
     events.add(input.event_ids[0]);revision++;
     return revision===1?{status:'created',order_id:'order-1',active_revision:revision}
       :{status:'appended',order_id:'order-1',active_revision:revision,requires_reconfirmation:true};
   }
 };
 const p=processor(orders,replies);
 const file=evt('file-1',undefined,{kind:'image',text:undefined,file_ref:'synthetic:image'});
 const later=evt('copies-2','Đổi A3, in 3 bản hai mặt',{occurred_at:'2026-10-12T01:05:00Z'});
 assert.equal(await p.consume(batch(file)),'processed');
 assert.equal(await p.consume(batch(later)),'processed');
 assert.equal(revision,2);assert.equal(seen.length,2);
 assert.ok(seen.every(i=>i.intent==='append_or_create'));
 assert.deepEqual(seen[0].changes,['attachment']);
 assert.ok(seen[1].changes.includes('copies'));
 assert.ok(seen[1].changes.includes('paper'));
 assert.ok(seen[1].changes.includes('duplex'));
 assert.deepEqual(seen.map(i=>i.event_ids),[['file-1'],['copies-2']]);
 assert.notEqual(seen[0].idempotency_key,seen[1].idempotency_key);
});
test('explicit separate request is distinguished without AI2 inventing order ID',async()=>{
 const intents=[],orders={
   async suggest_draft(){assert.fail('not legacy')},
   async route_human(){assert.fail('not handover')},
   async apply_incoming_batch(input){intents.push(input.intent);return {status:'created',order_id:'core-created-second-order'}}
 };
 assert.equal(await processor(orders).consume(batch(evt('new','Tạo đơn riêng in A4'))),'processed');
 assert.deepEqual(intents,['explicit_separate']);
});
test('ambiguous and mixed OA, customer or chat never reach a write Port',async()=>{
 let writes=0;const orders={
   async suggest_draft(){writes++;throw Error('must not draft')},
   async route_human(){writes++;throw Error('must not handover')},
   async apply_incoming_batch(){writes++;throw Error('must not append')}
 };
 const p=processor(orders);
 assert.equal(await p.consume(batch(evt('a','Gửi thêm file, tạo đơn riêng in A4'))),'held');
 assert.equal(await p.consume(batch(evt('a','In A4'),evt('b','In A3',{oa_id:'other'}))),'held');
 assert.equal(await p.consume(batch(evt('a','In A4'),evt('b','In A3',{customer_id:'other'}))),'held');
 assert.equal(await p.consume(batch(evt('a','In A4'),evt('b','In A3',{conversation_id:'other'}))),'held');
 assert.equal(writes,0);
});
test('after-approval/stale generation/unclear target holds source batch without reply',async()=>{
 for(const status of ['closed','stale_generation','needs_human','ambiguous']){
   const outbound=[];
   const orders={
     async suggest_draft(){assert.fail('not legacy')},
     async route_human(){assert.fail('not routing')},
     async apply_incoming_batch(){return {status}}
   };
   assert.equal(await processor(orders,outbound).consume(batch(evt('e','In thêm 2 bản'))),'held');
   assert.equal(outbound.length,0);
 }
});
test('ACK loss and concurrent worker replay share event identity and do not duplicate append',async()=>{
 let append=0;const journal=new Map();let lost=true;
 const orders={
   async suggest_draft(){assert.fail('no legacy')},
   async route_human(){assert.fail('no human')},
   async apply_incoming_batch(input){
     let result=journal.get(input.idempotency_key);
     if(!result){append++;result={status:'appended',order_id:'order-1',
       active_revision:2,requires_reconfirmation:true};journal.set(input.idempotency_key,result)}
     if(lost){lost=false;throw Error('simulated lost ACK')}
     return result;
   }
 };
 const p1=processor(orders),p2=processor(orders);
 const a=batch(evt('follow','In thêm 2 bản'));
 await assert.rejects(p1.consume(a),/lost ACK/);
 assert.deepEqual(await Promise.all([p1.consume(a),p2.consume(a)]),['processed','processed']);
 assert.equal(append,1);assert.equal(journal.size,1);
});
test('malformed Core append acknowledgement never completes a batch',async()=>{
 const orders={async suggest_draft(){assert.fail('not legacy')},
   async route_human(){assert.fail('not human')},
   async apply_incoming_batch(){return {status:'appended',order_id:'one',active_revision:2,requires_reconfirmation:false}}};
 await assert.rejects(processor(orders).consume(batch(evt('x','In 2 bản'))),
   /AI1_APPEND_PORT_INVALID_RESULT/);
});
test('without Core append Port, explicit second order stays held, not a duplicate draft',async()=>{
 let drafts=0;const orders={async suggest_draft(){drafts++;return {status:'created',order_id:'one'}},
   async route_human(){throw Error('not human')}};
 assert.equal(await processor(orders).consume(batch(evt('x','Tạo đơn riêng in A4'))),'held');
 assert.equal(drafts,0);
 assert.equal(await processor(orders).consume(batch(evt('a','In A4'))),'processed');
 assert.equal(drafts,1);
});
test('standalone OK remains confirmation candidate and never reaches order Port',async()=>{
 const orders={async suggest_draft(){assert.fail('not draft')},
   async route_human(){assert.fail('not human')},
   async apply_incoming_batch(){assert.fail('not append')}};
 assert.equal(await processor(orders).consume(batch(evt('ok','OK'))),'held');
});

test('forged provider occurred_at cannot override trusted PostgreSQL receive order',async()=>{
 const attempts=[],orders={
   async suggest_draft(){assert.fail('legacy not used')},
   async route_human(){assert.fail('unexpected handover')},
   async apply_incoming_batch(input){
     attempts.push(input);return {status:'created',order_id:'one'};
   }
 };
 const earlier=evt('early','In A4',{occurred_at:'2035-01-01T00:00:00Z'});
 const later=evt('late','Đổi A3',{occurred_at:'2020-01-01T00:00:00Z'});
 const received={...batch(later,earlier),server_received_event_ids:['early','late']};
 const p=processor(orders);
 assert.equal(await p.consume(received),'processed');
 assert.equal(attempts.length,1);
 assert.deepEqual(attempts[0].event_ids,['early','late']);
 assert.equal(attempts[0].text,'In A4\\nĐổi A3');
 const replay={...batch(earlier,later),server_received_event_ids:['early','late']};
 assert.equal(await p.consume(replay),'processed');
 assert.equal(attempts[0].text,attempts[1].text);
 assert.equal(attempts[0].idempotency_key,attempts[1].idempotency_key);
});
test('corrupt DB receive provenance never emits an order or reply',async()=>{
 let writes=0;const orders={
   async suggest_draft(){writes++},
   async route_human(){writes++},
   async apply_incoming_batch(){writes++}
 };
 const p=processor(orders);
 await assert.rejects(p.consume({...batch(evt('a','In A4')),server_received_event_ids:['foreign']}),
   /INVALID_SERVER_EVENT_ORDER/);
 assert.equal(writes,0);
});
