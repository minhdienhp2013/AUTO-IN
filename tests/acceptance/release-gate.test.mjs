import test from 'node:test';
import assert from 'node:assert/strict';
import {releaseGate} from './release-gate.mjs';
test('release gate fails closed on absent evidence',()=>{
 const r=releaseGate({});assert.equal(r.allowed,false);assert.ok(r.blockers.length>10);
});
test('even 210 simulated orders cannot approve a real release',()=>{
 const r=releaseGate({mode:'simulation',critical_failures:0,passing_orders:210,clean_test_days:7,
  load_orders_per_day:100,recognition_rate:1,conversation_rate:1,synthetic_dataset:true});
 assert.equal(r.allowed,false);
});
test('one critical failure blocks an otherwise complete report',()=>{
 const evidence=Object.fromEntries(['postgres_concurrency','oa_verified','ricoh_verified','iphone_verified','all_p0_rechecked','reviewed_by_owner'].map(x=>[x,true]));
 const r=releaseGate({mode:'controlled_test',critical_failures:1,passing_orders:210,clean_test_days:7,
  load_orders_per_day:100,recognition_rate:.95,conversation_rate:.90,synthetic_dataset:false,evidence});
 assert.equal(r.allowed,false);
});
