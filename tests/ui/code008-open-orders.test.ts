import test from 'node:test';
import assert from 'node:assert/strict';
import { demoOrders } from '../../web/src/fixtures.ts';
import { canApproveAfterInboundReview, canEditPrintRequest, enrichOrderWithCode008, groupOpenOrdersByChat,
  hasClearPendingInbound, parsePendingInbound, requiresCustomerReconfirmation } from '../../web/src/code008.ts';

const order=(id:string,customer_id='cust1',conversation_id='conv1')=>({ ...structuredClone(demoOrders[0]), order_id:id,
  customer_id,conversation_id,detail_loaded:true,manual_lock:false,order_state:'confirmed' as const,
  print_state:'NOT_SENT' as const});
const pending=(o:ReturnType<typeof order>,status:'clear'|'processing'|'needs_human',count:number,items:unknown[]=[])=>({
  order:{id:o.order_id,active_revision:o.revision,customer_id:o.customer_id},
  current:{revision:o.revision,request_hash:o.request_hash,pending_updates:{order_id:o.order_id,revision:o.revision,
    request_hash:o.request_hash,status,unresolved_count:count,items}}
});

test('missing pending-updates read model stays UNKNOWN and blocks live approval',()=>{
  const o=order('one');
  const result=enrichOrderWithCode008({order:{id:'one',active_revision:o.revision,customer_id:'cust1'},
    current:{revision:o.revision,request_hash:o.request_hash}},o);
  assert.equal(result.pending_updates?.state,'unknown');assert.equal(canApproveAfterInboundReview(result),false);
});
test('server CLEAR with exact order/revision/hash may unblock, but never supplies customer confirmation',()=>{
  const o=order('one');const view=enrichOrderWithCode008(pending(o,'clear',0),o);
  assert.equal(hasClearPendingInbound(view),true);
  assert.equal(view.confirmed_revision,o.confirmed_revision);
  assert.equal(canApproveAfterInboundReview(view),true);
});
test('follow-up file and message marked NEEDS_HUMAN block approval; no silent append',()=>{
  const o=order('one');
  const view=enrichOrderWithCode008(pending(o,'needs_human',2,[
    {kind:'file',label:'Tệp gửi thêm',summary:'Chưa đối soát',received_at:null},
    {kind:'message',label:'Khách nhắn bổ sung',summary:'Đổi khổ giấy',received_at:null}]),o);
  assert.equal(view.pending_updates?.items.length,2);assert.equal(view.pending_updates?.state,'needs_human');
  assert.equal(canApproveAfterInboundReview(view),false);
});
test('stale revision/hash/order, invalid zero processing, system markers never become CLEAR',()=>{
  const o=order('one');
  for(const mutated of [
    {...pending(o,'clear',0),current:{...pending(o,'clear',0).current,revision:o.revision+1}},
    {...pending(o,'clear',0),current:{...pending(o,'clear',0).current,pending_updates:{...pending(o,'clear',0).current.pending_updates,request_hash:'stale'}}},
    pending(o,'processing',0),
    pending(o,'clear',0,[{kind:'message',label:'x',summary:'[AUTO-IN SYSTEM: ATTACHMENT_ONLY]',received_at:null}])
  ])assert.notEqual(parsePendingInbound(mutated,o).state,'clear');
});
test('same customer and chat shows two SEPARATE open orders, never groups another customer/chat',()=>{
  const groups=groupOpenOrdersByChat([order('a'),order('b'),order('c','cust1','another-chat'),order('d','cust2','conv1')]);
  assert.equal(groups.length,3);
  assert.deepEqual(groups.find(g=>g.customer_id==='cust1'&&g.conversation_id==='conv1')?.orders.map(o=>o.order_id),['a','b']);
});
test('list-only, approved, closed and sent jobs are excluded from open chat list',()=>{
  assert.equal(groupOpenOrdersByChat([ {...order('one'),detail_loaded:false},
    {...order('two'),order_state:'approved'}, {...order('three'),print_state:'SENDING'} ]).length,0);
});
test('revision > 1 missing matching confirmation requires customer reconfirmation',()=>{
  const o=order('one');o.revision=3;o.confirmed_revision=2;
  assert.equal(requiresCustomerReconfirmation(o),true);
  o.confirmed_revision=3;assert.equal(requiresCustomerReconfirmation(o),false);
});
test('after staff approval or printed job, request editing is locked; payment remains separate',()=>{
  const o=order('one');assert.equal(canEditPrintRequest(o),true);
  assert.equal(canEditPrintRequest({...o,order_state:'approved'}),false);
  assert.equal(canEditPrintRequest({...o,print_state:'UNKNOWN'}),false);
  assert.equal(canEditPrintRequest({...o,manual_lock:true}),false);
});
test('backend processing(0,[]) means waiting for verified plan, NEVER CLEAR',()=>{
  const o=order('zero-plan');
  const view=enrichOrderWithCode008(pending(o,'processing',0),o);
  assert.equal(view.pending_updates?.state,'processing');
  assert.equal(view.pending_updates?.unresolved_count,0);
  assert.equal(hasClearPendingInbound(view),false);
  assert.equal(canApproveAfterInboundReview(view),false);
});
test('backend needs_human(0,[]) means missing trusted scope, NEVER CLEAR',()=>{
  const o=order('missing-scope');
  const view=enrichOrderWithCode008(pending(o,'needs_human',0),o);
  assert.equal(view.pending_updates?.state,'needs_human');
  assert.equal(view.pending_updates?.unresolved_count,0);
  assert.equal(canApproveAfterInboundReview(view),false);
});
test('backend pending list can be truncated while count is authoritative; never become CLEAR',()=>{
  const o=order('many-items');
  const view=enrichOrderWithCode008(pending(o,'processing',20,[{
    kind:'file',label:'Tệp tin cần đối soát',
    summary:'Chưa được xác minh trong phiên bản đơn hiện hành',received_at:'2026-10-13T04:00:00.000Z'
  }]),o);
  assert.equal(view.pending_updates?.state,'processing');
  assert.equal(view.pending_updates?.unresolved_count,20);
  assert.equal(canApproveAfterInboundReview(view),false);
});
test('pending metadata count less than supplied items and CLEAR with nonzero count stay unknown',()=>{
  const o=order('bad-count');
  for(const detail of [pending(o,'processing',0,[{kind:'file',label:'x',summary:'y',received_at:null}]),
    pending(o,'clear',1)]) {
    const parsed=parsePendingInbound(detail,o);
    assert.equal(parsed.state,'unknown');
    assert.equal(canApproveAfterInboundReview(enrichOrderWithCode008(detail,o)),false);
  }
});
test('mismatched order id for backend CLEAR is never accepted',()=>{
  const o=order('one'); const d=pending(o,'clear',0);
  d.current.pending_updates.order_id='another-order';
  assert.equal(parsePendingInbound(d,o).state,'unknown');
});
