import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyIncomingOrderBatch as classify,
  classifyIncomingOrderBoundary as boundary} from '../../../backend/conversation/order-batch-intent.ts';
const evt=(id,text,extra={})=>({event_id:id,oa_id:'oa1',customer_id:'c1',
  conversation_id:'chat1',occurred_at:'2026-10-12T02:00:00Z',kind:'text',text,...extra});
const batch=(...events)=>({key:'batch',first_at:0,deadline_at:60000,events});
for(const [message, expected, parts] of [
 ['In 3 bản A4 hai mặt','append_or_create',['copies','paper','duplex']],
 ['Đổi sang A3','append_or_create',['paper']],
 ['Gửi thêm file nữa','append_or_create',['print_request']],
 ['Tạo đơn riêng in A4','explicit_separate',['paper']],
 ['Không tạo đơn riêng, in 2 bản','clarify',[]],
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
test('explicit new-order wording maps to NEW even when the signal is a standalone lease',()=>{
 for(const message of ['Đơn mới','Tạo đơn mới','Làm đơn riêng','Tách đơn','Đơn khác, A4','Đơn thứ 2'])
   assert.equal(boundary(batch(evt('new',message))),'NEW',message);
 assert.equal(classify(batch(evt('new-only','Đơn mới'))).reason,'NO_PRINT_CONTENT');
});
test('negated, contradictory, questioned and unclear new-order intent is ambiguous',()=>{
 for(const message of [
   'Không tạo đơn',
   'Không tạo đơn mới',
   'Không tạo đơn nào',
   'Không tạo đơn nữa',
   'Không tạo đơn mới nữa',
   'không tạo đơn mới',
   'Không muốn tạo đơn mới',
   'Không cần lập đơn',
   'Đừng mở đơn mới',
   'Chưa tạo đơn',
   'Chưa cần đơn riêng',
   'Đừng mở đơn khác',
   'Đơn mới nhưng tiếp tục đơn cũ',
   'Đơn mới, gửi thêm file vào đơn cũ',
   'Có phải đơn mới?',
   'Làm một đơn rồi gửi file'
 ]){
   assert.equal(boundary(batch(evt('ambiguous',message))),'AMBIGUOUS',message);
   assert.equal(classify(batch(evt('ambiguous',message))).intent,'clarify',message);
 }
});
test('affirmative new-order controls remain NEW',()=>{
 for(const message of ['Đơn mới','Tạo đơn mới'])
   assert.equal(boundary(batch(evt('affirmative',message))),'NEW',message);
 const created=classify(batch(evt('create-request','Tạo đơn mới, A4, in 2 bản'),
   evt('create-file',undefined,{kind:'file'})));
 assert.equal(created.intent,'explicit_separate');
 assert.ok(created.changes.includes('attachment'));
});
test('wrong OA/customer/conversation and conflicted explicit instructions fail closed',()=>{
 assert.equal(classify(batch(evt('1','In A4'),evt('2','In A4',{customer_id:'other'}))).intent,'clarify');
 assert.equal(classify(batch(evt('1','In A4'),evt('2','In A4',{oa_id:'other'}))).intent,'clarify');
 assert.equal(classify(batch(evt('1','In A4'),evt('2','In A4',{conversation_id:'other'}))).intent,'clarify');
 assert.equal(classify(batch(evt('3','Gửi thêm file, tạo đơn riêng in A4'))).reason,'CONFLICTING_INTENTS');
});
