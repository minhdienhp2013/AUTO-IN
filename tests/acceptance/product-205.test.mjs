import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createAcceptanceAdapter} from './product-adapter.mjs';
const skip=process.env.AUTOIN_RUN_PRODUCT_ACCEPTANCE==='1'?false:'PRODUCT NOT RUN: requires --integration and real isolated PG/AI1/AI3';
const claim=()=>({printer_id:'RMP7000',idempotency_key:'a205-'+randomUUID()});
const send=job=>({job_id:job.job_id,lease_token:job.lease_token,expected_revision:job.revision,idempotency_key:'a205-'+randomUUID()});
function error(r,code){assert.equal(r?.ok,false,JSON.stringify(r));assert.equal(r.error?.code,code,JSON.stringify(r))}
async function run(seed,fn){
 const a=await createAcceptanceAdapter({databaseUrl:process.env.AUTOIN_TEST_DATABASE_URL});
 try{await a.reset(seed);await fn(a)}finally{await a.dispose()}
}
test('PG-01 unapproved = empty queue, no false request error',{skip},()=>run('unapproved_order',async a=>{
 const r=await a.act('claim',claim(),{actor:'agent'});assert.equal(r.ok,true);assert.equal(r.job,null);assert.equal((await a.snapshot()).driver_calls,0);
}));
test('PG-02 stale revision rejected',{skip},()=>run('stale_revision',async a=>{
 error(await a.act('approve',{expected_revision:1,acknowledge_deposit_shortage:true,idempotency_key:'stale-205'}),'STALE_REVISION');
}));
test('PG-03 two independent PostgreSQL agents cannot claim same job',{skip},()=>run('approved_unsent',async a=>{
 const [p,q]=await Promise.all([a.newAgent('agent-1'),a.newAgent('agent-2')]);assert.notEqual(p.connection_id,q.connection_id);
 const r=await Promise.all([p.act('claim',claim()),q.act('claim',claim())]);
 assert.equal(r.filter(x=>x.ok&&x.job).length,1,JSON.stringify(r));
 assert.equal(r.filter(x=>x.ok&&x.job===null).length,1,JSON.stringify(r));
 assert.equal((await a.snapshot()).driver_calls,0);
}));
test('PG-04 competing mark-sending and revision lock is atomic',{skip},()=>run('approved_unsent',async a=>{
 const [p,s]=await Promise.all([a.newAgent('agent-1'),a.newAgent('staff')]);assert.notEqual(p.connection_id,s.connection_id);
 const c=await p.act('claim',claim());assert.ok(c.job);
 const r=await Promise.all([p.act('mark_sending',send(c.job)),s.act('revise',{expected_revision:3,request_data:{synthetic:true,copies:4},idempotency_key:'race-205'})]);
 assert.equal(r.filter(x=>x.ok).length,1,JSON.stringify(r));assert.equal((await a.snapshot()).driver_calls,0);
}));
test('PG-05 UNKNOWN never reclaims automatically',{skip},()=>run('unknown_after_crash',async a=>{
 const r=await a.act('claim',claim(),{actor:'agent'});assert.equal(r.ok,true);assert.equal(r.job,null);
 assert.equal((await a.snapshot()).print_state,'UNKNOWN');
}));
test('PG-06 holiday and manual lock prevent print',{skip},async()=>{
 for(const seed of ['holiday','manual_lock'])await run(seed,async a=>{
  const r=await a.act('claim',claim(),{actor:'agent'});
  assert.ok(r.ok&&r.job===null||!r.ok&&['PRINT_CLOSED','MANUAL_LOCK'].includes(r.error?.code),JSON.stringify(r));
 });
});
test('PG-07 large quote missing customer confirmation',{skip},()=>run('large_quote_unconfirmed',async a=>{
 error(await a.act('approve',{expected_revision:2,quote_revision:2,acknowledge_deposit_shortage:true,idempotency_key:'quote-205'}),'PRICE_CONFIRMATION_REQUIRED');
}));
test('PG-08 missing deposit may be acknowledged but debt remains',{skip},()=>run('deposit_short',async a=>{
 error(await a.act('approve',{expected_revision:2,acknowledge_deposit_shortage:false,idempotency_key:'ack-no-205'}),'DEPOSIT_WARNING_REQUIRED');
 const r=await a.act('approve',{expected_revision:2,acknowledge_deposit_shortage:true,idempotency_key:'ack-yes-205'});
 assert.equal(r.ok,true,JSON.stringify(r));assert.equal((await a.snapshot()).remaining_deposit_vnd,100000);
}));
test('PG-09 owner-only exception retains receivable and undelivered sheets',{skip},()=>run('partial_delivery_exception',async a=>{
 error(await a.act('close_exception',{expected_revision:2,reason:'synthetic uncollected',idempotency_key:'close-staff-205'},{actor:'staff'}),'OWNER_REQUIRED');
 const r=await a.act('close_exception',{expected_revision:2,reason:'synthetic uncollected',idempotency_key:'close-owner-205'},{actor:'owner'});
 assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.receivable_vnd,70000);assert.equal(r.undelivered_sheets,40);
}));
test('PG-10 idempotency changes produce real 409',{skip},()=>run('idempotency_conflict',async a=>{
 const r=await a.act('revise',{expected_revision:1,request_data:{synthetic:true,copies:2},idempotency_key:'same-205'});
 assert.equal(r.ok,true,JSON.stringify(r));
 error(await a.act('revise',{expected_revision:1,request_data:{synthetic:true,copies:3},idempotency_key:'same-205'}),'IDEMPOTENCY_CONFLICT');
}));
test('PG-11 simulation cannot fabricate verified paper or delivery',{skip},()=>run('unknown_after_crash',async a=>{
 const s=await a.snapshot();
 error(await a.act('verify_paper',{job_id:s.job_id,evidence_kind:'staff_inspected',physical_sheets:2,note:'synthetic',idempotency_key:'paper-205'}),'SIMULATION_NOT_PAPER');
 error(await a.act('deliver',{physical_sheets:2,idempotency_key:'delivery-205'}),'PAPER_NOT_VERIFIED');
}));
test('DRYRUN-12 actual AI3 Journal/DryRunDriver used after actual AI1 mark-sending',{skip},()=>run('approved_unsent',async a=>{
 const r=await a.dryrunOnce();assert.equal(r.status,'SIMULATED_DONE');assert.equal(r.evidence_kind,'simulated');
 const s=await a.snapshot();assert.equal(s.print_state,'SIMULATED_DONE');assert.equal(s.driver_calls,1);
 assert.equal((await a.dryrunOnce()).status,'NO_JOB');assert.equal((await a.snapshot()).driver_calls,1);
}));

test('PG-13 confirmed A before B, approved B before A: claim A first',{skip},()=>run('unapproved_order',async a=>{
 const q=await a.checkConfirmedQueue();
 assert.ok(q.claimed_order_id,'No approved job claimed');
 assert.equal(q.claimed_order_id,q.first_order_id,'TN-007 FIFO must follow customer confirmation, not staff approval');
 assert.notEqual(q.claimed_order_id,q.second_order_id);
}));
test('PG-14 printer scope is enforced by real AI1 agent service',{skip},()=>run('approved_unsent',async a=>{
 error(await a.act('claim',{printer_id:'WRONG_PRINTER',idempotency_key:'scope-205'},{actor:'agent'}),'PRINTER_SCOPE_DENIED');
}));
test('PG-15 owner-only refund approval and over-refund guard',{skip},()=>run('partial_delivery_exception',async a=>{
 error(await a.act('payment',{direction:'refund_approved',amount_vnd:30000,idempotency_key:'refund-staff-205'},{actor:'staff'}),'OWNER_REQUIRED');
 error(await a.act('payment',{direction:'refund_approved',amount_vnd:30001,idempotency_key:'refund-large-205'},{actor:'owner'}),'REFUND_EXCEEDS_RECEIPTS');
 const r=await a.act('payment',{direction:'refund_approved',amount_vnd:30000,idempotency_key:'refund-ok-205'},{actor:'owner'});
 assert.equal(r.ok,true,JSON.stringify(r));
 const paid=await a.act('payment',{direction:'refunded',amount_vnd:30000,idempotency_key:'refund-paid-205'},{actor:'owner'});
 assert.equal(paid.ok,true,JSON.stringify(paid));
}));

test('PG-16 two PostgreSQL connections cannot approve same revision twice',{skip},()=>run('deposit_short',async a=>{
 const [staff,owner]=await Promise.all([a.newAgent('staff'),a.newAgent('owner')]);
 assert.notEqual(staff.connection_id,owner.connection_id);
 const body={expected_revision:2,acknowledge_deposit_shortage:true};
 const rs=await Promise.all([
  staff.act('approve',{...body,idempotency_key:'double-approve-staff-205'}),
  owner.act('approve',{...body,idempotency_key:'double-approve-owner-205'})
 ]);
 assert.equal(rs.filter(r=>r.ok).length,1,JSON.stringify(rs));
 assert.equal(rs.filter(r=>!r.ok&&r.error?.code==='ALREADY_APPROVED').length,1,JSON.stringify(rs));
}));
test('PG-17 same job has at most one successful mark-sending',{skip},()=>run('approved_unsent',async a=>{
 const [p,q]=await Promise.all([a.newAgent('agent-1'),a.newAgent('agent-1')]);
 assert.notEqual(p.connection_id,q.connection_id);
 const c=await p.act('claim',claim());assert.ok(c.job);
 const body=send(c.job);
 const rs=await Promise.all([
  p.act('mark_sending',{...body,idempotency_key:'double-mark-1-205'}),
  q.act('mark_sending',{...body,idempotency_key:'double-mark-2-205'})
 ]);
 assert.equal(rs.filter(r=>r.ok&&r.state==='SENDING').length,1,JSON.stringify(rs));
 assert.equal(rs.filter(r=>!r.ok&&r.error?.code==='NOT_SENDABLE').length,1,JSON.stringify(rs));
 assert.equal((await a.snapshot()).driver_calls,0);
}));

test('DRYRUN-18 crash AFTER mark-sending journals UNKNOWN, never resends',{skip},()=>run('approved_unsent',async a=>{
 const recovered=await a.dryrunCrashAfterMark();
 assert.equal(recovered.state,'UNKNOWN');
 assert.equal(recovered.driver_calls,0);
 assert.equal(recovered.server_reclaimed,false);
 const s=await a.snapshot();
 assert.equal(s.print_state,'UNKNOWN');
 assert.equal(s.driver_calls,0,'DryRunDriver must not be invoked on ambiguous crash');
 const after=await a.act('claim',claim(),{actor:'agent'});
 assert.equal(after.ok,true,JSON.stringify(after));
 assert.equal(after.job,null,'UNKNOWN must not be eligible for auto-retry');
}));
