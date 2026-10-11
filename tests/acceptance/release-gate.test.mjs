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

test('non-finite or impossible rates must never enable release',()=>{
 const evidence=Object.fromEntries(['postgres_concurrency','oa_verified','ricoh_verified','iphone_verified','all_p0_rechecked','reviewed_by_owner'].map(k=>[k,true]));
 const base={mode:'controlled_test',critical_failures:0,passing_orders:210,clean_test_days:7,load_orders_per_day:100,recognition_rate:.95,conversation_rate:.9,synthetic_dataset:false,evidence};
 assert.equal(releaseGate({...base,recognition_rate:NaN}).allowed,false);
 assert.equal(releaseGate({...base,conversation_rate:2}).allowed,false);
});

test('CODE305: 23 synthetic harness PASS cannot substitute for product integration',()=>{
 const flags=Object.fromEntries(['postgres_concurrency','oa_verified','ricoh_verified','iphone_verified','all_p0_rechecked','reviewed_by_owner'].map(k=>[k,true]));
 const pretend={mode:'controlled_test',critical_failures:0,passing_orders:210,clean_test_days:7,
  load_orders_per_day:100,recognition_rate:.95,conversation_rate:.86,synthetic_dataset:false,
  evidence:{...flags,integration_sha:'1234567890abcdef1234567890abcdef12345678',product_runs:{
   pg:{status:'PASS',pass:23,fail:0,skip:36,integration_sha:'1234567890abcdef1234567890abcdef12345678'}
  }}};
 const result=releaseGate(pretend);
 assert.equal(result.allowed,false);
 assert.ok(result.blockers.some(x=>x.includes('product evidence: pg')),'Skipped product tests must block TN037');
 assert.ok(result.blockers.some(x=>x.includes('product evidence: http')),'HTTP not run must block');
});
test('CODE305: contradictory integrated SHA must not pass release gate',()=>{
 const result=releaseGate({evidence:{integration_sha:'short',product_runs:{}}});
 assert.equal(result.allowed,false);
 assert.ok(result.blockers.some(x=>x.includes('integrated CODE-006 SHA')));
});
