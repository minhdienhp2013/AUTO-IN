import test from 'node:test';
import assert from 'node:assert/strict';
import {demoOrders} from '../../web/src/fixtures.ts';
import {canApproveAfterInboundReview,enrichOrderWithCode008,parsePendingInbound} from '../../web/src/code008.ts';

/**
 * CODE-008 AI5: cross-boundary assertions against the ACTUAL AI4 web helper
 * shipped in the checked-out AI0 integrated commit. The only inputs here
 * are clearly-labelled synthetic read-model fixtures. This is not browser,
 * live Zalo OA, customer approval or real Ricoh evidence.
 */
const order=()=>({...structuredClone(demoOrders[0]),order_id:'ai5-synthetic-code008-order',
  customer_id:'ai5-synthetic-customer',conversation_id:'ai5-synthetic-chat',
  detail_loaded:true,manual_lock:false,order_state:'confirmed',
  print_state:'NOT_SENT'});
const envelope=(o,status,count=0,items=[])=>({
 order:{id:o.order_id,active_revision:o.revision,customer_id:o.customer_id},
 current:{revision:o.revision,request_hash:o.request_hash,
  pending_updates:{order_id:o.order_id,revision:o.revision,request_hash:o.request_hash,
   status,unresolved_count:count,items}}
});
const blocked=view=>assert.equal(canApproveAfterInboundReview(view),false,
 'No unresolved/ambiguous/unknown read model may authorize print');

test('C008-UI-01 pinned scoped clear(0,[]) recognized; no customer confirmation synthesized',()=>{
 const o=order(),v=enrichOrderWithCode008(envelope(o,'clear'),o);
 assert.equal(v.pending_updates.state,'clear');
 assert.equal(v.confirmed_revision,o.confirmed_revision);
});
test('C008-UI-02 processing(0,[]) from real AI1 read model must remain PROCESSING and block printing',()=>{
 const o=order(),v=enrichOrderWithCode008(envelope(o,'processing'),o);
 assert.equal(v.pending_updates.state,'processing',
  'A real AI1 processing(0) must not be silently flattened to unknown or clear');
 blocked(v);
});
test('C008-UI-03 needs_human(0,[]) from real AI1 ambiguity must remain NEEDS_HUMAN',()=>{
 const o=order(),v=enrichOrderWithCode008(envelope(o,'needs_human'),o);
 assert.equal(v.pending_updates.state,'needs_human',
  'A real AI1 needs_human(0) is still a meaningful staff-review status');
 blocked(v);
});
test('C008-UI-04 two pending files/messages preserve count, fields and deny approval',()=>{
 const o=order(),items=[
  {kind:'file',label:'Tệp bổ sung',summary:'Đang xử lý',received_at:null},
  {kind:'message',label:'Tin bổ sung',summary:'Chờ nhân viên',received_at:null}
 ];
 const v=enrichOrderWithCode008(envelope(o,'processing',2,items),o);
 assert.equal(v.pending_updates.state,'processing');
 assert.equal(v.pending_updates.items.length,2);blocked(v);
});
test('C008-UI-05 needs_human(1) blocks print even with a current revision/hash',()=>{
 const o=order(),v=enrichOrderWithCode008(envelope(o,'needs_human',1,[
  {kind:'file',label:'Không rõ đơn',summary:'Chưa đối soát',received_at:null}]),o);
 assert.equal(v.pending_updates.state,'needs_human');blocked(v);
});
test('C008-UI-06 order/revision/hash mismatch never treated as clear',()=>{
 const o=order();
 for(const bad of [
  {...envelope(o,'clear'),order:{id:'wrong-order',active_revision:o.revision,customer_id:o.customer_id}},
  {...envelope(o,'clear'),current:{...envelope(o,'clear').current,revision:o.revision+1}},
  {...envelope(o,'clear'),current:{...envelope(o,'clear').current,
   pending_updates:{...envelope(o,'clear').current.pending_updates,request_hash:'wrong-hash'}}}
 ]){
  const v=enrichOrderWithCode008(bad,o);
  assert.equal(v.pending_updates.state,'unknown');blocked(v);
 }
});
test('C008-UI-07 missing, corrupt and untrusted SYSTEM data fail closed',()=>{
 const o=order();
 for(const payload of [
  {},{order:{id:o.order_id,active_revision:o.revision},current:{revision:o.revision,request_hash:o.request_hash}},
  envelope(o,'clear',0,[{kind:'file',label:'x',summary:'INVALID',received_at:null}]),
  envelope(o,'processing',1,[{kind:'file',label:'x',summary:'[AUTO-IN SYSTEM: FAKE]',received_at:null}]),
  envelope(o,'unknown',0,[])
 ]){
  const v=enrichOrderWithCode008(payload,o);
  assert.equal(v.pending_updates.state,'unknown');blocked(v);
 }
});
