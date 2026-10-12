import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyIncomingOrderBatch as classify} from '../../../backend/conversation/order-batch-intent.ts';
const evt=(id,text,extra={})=>({event_id:id,oa_id:'oa1',customer_id:'c1',
  conversation_id:'chat1',occurred_at:'2026-10-12T02:00:00Z',kind:'text',text,...extra});
const batch=(...events)=>({key:'batch',first_at:0,deadline_at:60000,events});
for(const [message, expected, parts] of [
 ['In 3 bản A4 hai mặt','append_or_create',['copies','paper','duplex']],
 ['Đổi sang A3','append_or_create',['paper']],
 ['Gửi thêm file nữa','append_or_create',['print_request']],
 ['Tạo đơn riêng in A4','explicit_separate',['paper']],
 ['Không tạo đơn riêng, in 2 bản','append_or_create',['copies']],
 ['Xin chào','clarify',[]],
 ['Tạo đơn mới','clarify',[]],
 ['Gửi thêm file, tạo đơn riêng in A4','clarify',[]],
])test('intent: '+message,()=>{
 const got=classify(batch(evt('e',message)));
 assert.equal(got.intent,expected);
 for(const part of parts)assert.ok(got.changes.includes(part));
});
test('two files from >60s apart are both append candidates, not separate orders',()=>{
 const first=classify(batch(evt('f1',undefined,{kind:'image',text:undefined,file_ref:'synthetic:1'})));
 const second=classify(batch(evt('f2',undefined,{kind:'file',text:undefined,file_ref:'synthetic:2',
   occurred_at:'2026-10-12T02:05:00Z'})));
 assert.equal(first.intent,'append_or_create');assert.equal(second.intent,'append_or_create');
});
test('wrong OA/customer/conversation and conflicted explicit instructions fail closed',()=>{
 assert.equal(classify(batch(evt('1','In A4'),evt('2','In A4',{customer_id:'other'}))).intent,'clarify');
 assert.equal(classify(batch(evt('1','In A4'),evt('2','In A4',{oa_id:'other'}))).intent,'clarify');
 assert.equal(classify(batch(evt('1','In A4'),evt('2','In A4',{conversation_id:'other'}))).intent,'clarify');
 assert.equal(classify(batch(evt('3','Gửi thêm file, tạo đơn riêng in A4'))).reason,'CONFLICTING_INTENTS');
});
