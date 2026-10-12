import test from 'node:test';
import assert from 'node:assert/strict';
import {mapVerifiedSupplementResult as map} from '../../../backend/integrations/zalo/order-supplement-result.ts';
const hash='a'.repeat(64);
const expected={order_id:'verified-order-1',expected_revision:3};
const response=(status='appended',revision=4,other={})=>({
 status,order_id:expected.order_id,revision,request_hash:hash,
 requires_reconfirmation:true,...other
});
test('exact AI1 append result maps to revision-bearing AI2 outcome, never customer confirmation',()=>{
 assert.deepEqual(map(response(),expected),{
  status:'appended',order_id:expected.order_id,
  active_revision:4,requires_reconfirmation:true
 });
});
test('same event replay existing after newer revision is not appended again',()=>{
 assert.deepEqual(map(response('existing',4),{...expected,expected_revision:7}),{
  status:'existing',order_id:expected.order_id,active_revision:4
 });
});
test('AI1 stale revision is held for authoritative re-resolution, never retried as append',()=>{
 assert.deepEqual(map({status:'stale_revision',current_revision:4},expected),{
  status:'needs_human'
 });
});
test('forged or malformed Core supplement results cannot ACK event batches',()=>{
 for(const raw of [
  undefined,null,{},response('appended',7),response('appended',4,{order_id:'other'}),
  response('appended',4,{requires_reconfirmation:false}),
  response('appended',4,{request_hash:'wrong'}),
  response('existing',0),{status:'stale_revision',current_revision:'4'},
  {status:'created',order_id:expected.order_id}
 ])assert.throws(()=>map(raw,expected),/AI1_SUPPLEMENT_RESULT_INVALID/);
 assert.throws(()=>map(response(),{order_id:expected.order_id,expected_revision:-1}),
   /AI1_SUPPLEMENT_EXPECTATION_INVALID/);
});
