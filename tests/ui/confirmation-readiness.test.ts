import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmationReadiness } from '../../web/src/domain.ts';
import { mapCoreOrderDetail } from '../../web/src/api.ts';
import { coreDetail } from './core-fixtures.ts';

function fixture() {
 const d = coreDetail();
 return {...d, current: {
  revision: 3, request_hash: 'req-hash', verified_plan: d.revisions[1].plan,
  request_confirmation: null, price_confirmation: null, preview_ref: null, approval: null
 }, print_progress: {planned_sheets: 180,verified_sheets:0,missing_sheets:180,delivered_sheets:0,fully_verified:false,requires_manual_reconciliation:false}};
}
const evidenceSha='a'.repeat(64);
function withCurrentEvidence(d:ReturnType<typeof fixture>) {
 d.current.print_evidence={schema:'ai0.print_evidence.v1',order_id:'order-ai1',
  revision:3,request_hash:'req-hash',evidence_sha256:evidenceSha} as never;
 d.current.preview_review={status:'matching',order_id:'order-ai1',
  revision:3,request_hash:'req-hash',evidence_sha256:evidenceSha} as never;
 return d;
}
test('CODE-404: no customer confirmation means waiting customer, not staff approval',()=>{
 const view=mapCoreOrderDetail(fixture());
 assert.deepEqual(confirmationReadiness(view),{request:'missing',price:'missing',staff:'waiting_customer'});
});
test('CODE-404: matching active revision/hash confirmation still needs price >150 sheets',()=>{
 const d=withCurrentEvidence(fixture());d.current.request_confirmation={revision:3,request_hash:'req-hash',kind:'request',evidence_sha256:evidenceSha} as never;
 const v=mapCoreOrderDetail(d);
 assert.deepEqual(confirmationReadiness(v),{request:'confirmed',price:'missing',staff:'waiting_price'});
 assert.equal(v.order_state,'confirmed');
});
test('CODE-404: quote confirmed but no per-file verified preview remains waiting',()=>{
 const d=withCurrentEvidence(fixture());d.current.request_confirmation={revision:3,request_hash:'req-hash',kind:'request',evidence_sha256:evidenceSha} as never;
 d.current.price_confirmation={revision:3,request_hash:'req-hash',quote_revision:2,kind:'quote'} as never;
 assert.deepEqual(confirmationReadiness(mapCoreOrderDetail(d)),{request:'confirmed',price:'confirmed',staff:'waiting_preview'});
});
test('CODE-404: stale request, stale price and already approved never invent staff action',()=>{
 const d=fixture();d.current.request_confirmation={revision:2,request_hash:'old',kind:'request'} as never;
 d.current.price_confirmation={revision:3,request_hash:'req-hash',quote_revision:2,kind:'quote'} as never;
 let view=mapCoreOrderDetail(d);
 assert.equal(confirmationReadiness(view).staff,'waiting_customer');
 d.current.request_confirmation={revision:3,request_hash:'req-hash',kind:'request'} as never;
 d.current.approval={id:'a1',revision:3,request_hash:'req-hash',quote_revision:2} as never;
 view=mapCoreOrderDetail(d);
 assert.equal(confirmationReadiness(view).staff,'already_approved');
});
test('V1 evidence binding: same-revision confirmation with stale evidence is not shown as current',()=>{
 const d=withCurrentEvidence(fixture());
 d.current.request_confirmation={revision:3,request_hash:'req-hash',kind:'request',evidence_sha256:'b'.repeat(64)} as never;
 const view=mapCoreOrderDetail(d);
 assert.equal(view.confirmed_revision,null);
 assert.equal(view.order_state,'draft');
 assert.equal(confirmationReadiness(view).request,'missing');
 assert.match(view.warnings.join(' '),/Xác nhận khách không khớp evidence hiện hành/);
 assert.match(view.warnings.join(' '),/Chưa có xác nhận yêu cầu đúng phiên bản\/hash/);
});
import { demoOrders } from '../../web/src/fixtures.ts';

test('CODE-404: staff review readiness is not a customer-confirm button or an approval',()=>{
 const base=demoOrders[0];
 const order={...base,revision:8,request_hash:'trusted-hash',confirmed_revision:8,
  total_sheets:2,large_cost_flag:false,manual_lock:false,print_state:'NOT_SENT' as const,
  order_state:'confirmed' as const,documents:[{...base.documents[0],preview_trusted:true,pages:1,physical_sheets:2}]};
 assert.equal(confirmationReadiness(order).staff,'waiting_preview');
 const reviewed={...order,
  print_evidence:{schema:'ai0.print_evidence.v1' as const,order_id:order.order_id,
    revision:8,request_hash:order.request_hash,evidence_sha256:'a'.repeat(64)},
  preview_review:{status:'matching' as const,order_id:order.order_id,revision:8,
    request_hash:order.request_hash,evidence_sha256:'a'.repeat(64)}};
 assert.equal(confirmationReadiness(reviewed).staff,'waiting_staff');
 assert.equal(order.order_state,'confirmed');
 assert.equal(order.print_state,'NOT_SENT');
 assert.equal(confirmationReadiness({...order,manual_lock:true}).staff,'blocked');
 assert.equal(confirmationReadiness({...order,print_state:'UNKNOWN'}).staff,'blocked');
});
test('CODE-404: significant cost always requires latest quote confirmation even with 1 sheet',()=>{
 const base=demoOrders[0];
 const order={...base,revision:1,request_hash:'trusted',confirmed_revision:1,total_sheets:1,
  large_cost_flag:true,order_state:'confirmed' as const,print_state:'NOT_SENT' as const,
  quote_revision:3,confirmed_quote_revision:2};
 assert.equal(confirmationReadiness(order).price,'missing');
 assert.equal(confirmationReadiness(order).staff,'waiting_price');
});
