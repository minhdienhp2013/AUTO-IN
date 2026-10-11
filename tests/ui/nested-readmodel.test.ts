import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiFault, mapCoreOrderDetail } from '../../web/src/api.ts';
import { hasValidApprovalInputs, depositShortfall } from '../../web/src/domain.ts';
import { coreDetail } from './core-fixtures.ts';

const detail = () => {
 const data = coreDetail();
 const rev = data.revisions[1];
 const current = {
  revision:3, request_hash:'req-hash', verified_plan:{...rev.plan,preview_ref:'internal:preview',preview_verified:true},
  preview_ref:'internal:preview',
  request_confirmation:{id:'c1',revision:3,request_hash:'req-hash',kind:'request'},
  price_confirmation:{id:'c2',revision:3,request_hash:'req-hash',kind:'quote',quote_revision:2},
  requires_price_confirmation:true,
  approval:null, request_confirmed:true, price_confirmed:true, staff_approved:false,
 };
 return {...data,current,print_progress:{planned_sheets:180,verified_sheets:0,missing_sheets:180,delivered_sheets:0,fully_verified:false,requires_manual_reconciliation:false},
  conversation_control:{status:'AI',generation:5,claimed_by:null}};
};

test('AI1 nested: exact confirmation/hash/quote and server generation are mapped',()=>{
 const d=detail();const view=mapCoreOrderDetail(d);
 assert.equal(view.order_state,'confirmed');assert.equal(view.confirmed_revision,3);assert.equal(view.confirmed_quote_revision,2);
 assert.equal(view.conversation_state,'ai');assert.equal(view.conversation_generation,5);
 assert.equal(view.total_sheets,180);assert.equal(view.verified_sheets,null);
 assert.equal(view.documents.length,0);assert.equal(hasValidApprovalInputs(view),false);
 assert.ok(view.warnings.some(w=>w.includes('preview')));
 assert.equal(depositShortfall(view),55000);
});
test('stale confirmation and stale quote revision never unlock approval',()=>{
 const d=detail();d.current.request_confirmation.request_hash='previous';
 let v=mapCoreOrderDetail(d);assert.equal(v.confirmed_revision,null);assert.equal(v.order_state,'draft');
 d.current.request_confirmation.request_hash='req-hash';d.current.price_confirmation.quote_revision=1;
 v=mapCoreOrderDetail(d);assert.equal(v.confirmed_quote_revision,null);assert.equal(v.order_state,'confirmed');
 assert.equal(hasValidApprovalInputs(v),false);
});
test('nested read model current revision/hash mismatch is rejected, not silently mapped',()=>{
 const d=detail();d.current.request_hash='tampered';
 assert.throws(()=>mapCoreOrderDetail(d),(e:unknown)=>e instanceof ApiFault&&e.code==='INVALID_CURRENT_REVISION');
});
test('approved nested order keeps approval state but missing file preview prevents another approval',()=>{
 const d=detail();d.current.approval={id:'a1',revision:3,request_hash:'req-hash',quote_revision:2};
 const v=mapCoreOrderDetail(d);assert.equal(v.order_state,'approved');assert.equal(hasValidApprovalInputs(v),false);
});
test('verified paper partial/UNKNOWN remains reconciled separately from delivery',()=>{
 const d=detail();d.order.delivered_sheets=20;
 d.jobs=[{id:'job-1',order_id:'order-ai1',revision:3,request_hash:'req-hash',approval_id:'a1',state:'UNKNOWN',
   mode_at_send:'controlled_test',evidence_kind:'staff_inspected',verified_sheets:30,printer_id:'RMP7000'}] as typeof d.jobs;
 d.print_progress={planned_sheets:180,verified_sheets:30,missing_sheets:150,delivered_sheets:20,fully_verified:false,requires_manual_reconciliation:true};
 const v=mapCoreOrderDetail(d);assert.equal(v.print_state,'UNKNOWN');assert.equal(v.verified_sheets,30);
 assert.equal(v.delivery_state,'partial');assert.equal(v.job_id,'job-1');
});
test('simulation-only progress cannot be interpreted as real paper',()=>{
 const d=detail();
 d.jobs=[{id:'job-1',order_id:'order-ai1',revision:3,request_hash:'req-hash',approval_id:'a1',state:'SIMULATED_DONE',
   mode_at_send:'simulation',evidence_kind:'simulated',verified_sheets:180,printer_id:'RMP7000'}] as typeof d.jobs;
 d.print_progress={planned_sheets:180,verified_sheets:180,missing_sheets:0,delivered_sheets:0,fully_verified:true,requires_manual_reconciliation:false};
 const v=mapCoreOrderDetail(d);assert.equal(v.print_state,'SIMULATED_DONE');assert.equal(v.verified_sheets,null);
 assert.notEqual(v.delivery_state,'delivered');
});
test('full real paper can be delivered; conflicting progress does not count',()=>{
 const d=detail();d.order.delivered_sheets=180;
 d.jobs=[{id:'job-1',order_id:'order-ai1',revision:3,request_hash:'req-hash',approval_id:'a1',state:'VERIFIED_DONE',
   mode_at_send:'controlled_test',evidence_kind:'staff_inspected',verified_sheets:180,printer_id:'RMP7000'}] as typeof d.jobs;
 d.print_progress={planned_sheets:180,verified_sheets:180,missing_sheets:0,delivered_sheets:180,fully_verified:true,requires_manual_reconciliation:false};
 assert.equal(mapCoreOrderDetail(d).delivery_state,'delivered');
 d.print_progress.planned_sheets=200;
 assert.equal(mapCoreOrderDetail(d).verified_sheets,null);
 assert.notEqual(mapCoreOrderDetail(d).delivery_state,'delivered');
});
test('generation and status are never guessed from missing or malformed conversation control',()=>{
 const d=detail();d.conversation_control={status:'HUMAN',generation:8,claimed_by:'employee-1'};
 let v=mapCoreOrderDetail(d);assert.equal(v.conversation_state,'staff');assert.equal(v.conversation_generation,8);
 assert.equal(v.conversation_claimed_by,'employee-1');
 d.conversation_control={status:'AI',generation:NaN,claimed_by:null};
 v=mapCoreOrderDetail(d);assert.equal(v.conversation_generation,null);
});
test('unknown send mode cannot be counted as verified physical paper',()=>{
 const d=detail();
 d.jobs=[{id:'job-old',order_id:'order-ai1',revision:3,request_hash:'req-hash',approval_id:'a1',state:'VERIFIED_DONE',
   mode_at_send:null,evidence_kind:'staff_inspected',verified_sheets:180,printer_id:'RMP7000'}] as typeof d.jobs;
 d.print_progress={planned_sheets:180,verified_sheets:180,missing_sheets:0,delivered_sheets:0,fully_verified:true,requires_manual_reconciliation:false};
 assert.equal(mapCoreOrderDetail(d).verified_sheets,null);
});

test('nested progress cannot exceed independently evidenced real sheets',()=>{
 const d=detail();d.order.delivered_sheets=180;
 d.jobs=[{id:'job-1',order_id:'order-ai1',revision:3,request_hash:'req-hash',approval_id:'a1',state:'VERIFIED_DONE',
   mode_at_send:'production',evidence_kind:'staff_inspected',verified_sheets:10,printer_id:'RMP7000'}] as typeof d.jobs;
 d.print_progress={planned_sheets:180,verified_sheets:180,missing_sheets:0,delivered_sheets:180,fully_verified:true,requires_manual_reconciliation:false};
 const view=mapCoreOrderDetail(d);
 assert.equal(view.verified_sheets,null);
 assert.notEqual(view.delivery_state,'delivered');
});


test('AI1 complete job without counted verified paper is not presented as printed',()=>{
 const d=detail();d.jobs=[{id:'j1',order_id:'order-ai1',revision:3,request_hash:'req-hash',state:'VERIFIED_DONE',
   mode_at_send:'controlled_test',verified_sheets:0,evidence_kind:null,printer_id:'RMP7000'}] as typeof d.jobs;
 d.print_progress={planned_sheets:180,verified_sheets:0,missing_sheets:180,delivered_sheets:0,
   fully_verified:false,requires_manual_reconciliation:true};
 const v=mapCoreOrderDetail(d);
 assert.equal(v.print_state,'UNKNOWN');assert.equal(v.verified_sheets,null);
 assert.notEqual(v.delivery_state,'delivered');
 assert.ok(v.warnings.some(w=>w.includes('không khớp')));
});

test('historical real job must not count as paper for current revision',()=>{
 const d=detail();d.order.delivered_sheets=180;
 d.jobs=[{id:'j-old',order_id:'order-ai1',revision:1,request_hash:'old-hash',state:'VERIFIED_DONE',
   mode_at_send:'production',evidence_kind:'staff_inspected',verified_sheets:180,printer_id:'RMP7000'}] as typeof d.jobs;
 d.print_progress={planned_sheets:180,verified_sheets:180,missing_sheets:0,delivered_sheets:180,
   fully_verified:true,requires_manual_reconciliation:false};
 const v=mapCoreOrderDetail(d);
 assert.equal(v.print_state,'NOT_SENT');assert.equal(v.verified_sheets,null);
 assert.notEqual(v.delivery_state,'delivered');
});

test('job status VERIFIED_DONE with spooler evidence is not proof of real paper',()=>{
 const d=detail();d.jobs=[{id:'j1',order_id:'order-ai1',revision:3,request_hash:'req-hash',state:'VERIFIED_DONE',
   mode_at_send:'production',evidence_kind:'spooler',verified_sheets:180,printer_id:'RMP7000'}] as typeof d.jobs;
 d.print_progress={planned_sheets:180,verified_sheets:180,missing_sheets:0,delivered_sheets:0,
   fully_verified:true,requires_manual_reconciliation:false};
 const v=mapCoreOrderDetail(d);
 assert.equal(v.print_state,'UNKNOWN');assert.equal(v.verified_sheets,null);
 assert.notEqual(v.delivery_state,'delivered');
});