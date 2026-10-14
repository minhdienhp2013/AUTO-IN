import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createAcceptanceAdapter} from './product-adapter.mjs';
const skip=process.env.AUTOIN_RUN_PRODUCT_ACCEPTANCE==='1'?false:'CODE405 PG NOT RUN: requires --integration and real isolated PostgreSQL';
const key=()=> 'c405-'+randomUUID();
async function scenario(seed,fn){
 const a=await createAcceptanceAdapter({databaseUrl:process.env.AUTOIN_TEST_DATABASE_URL});
 try{await a.reset(seed);await fn(a)}finally{await a.dispose()}
}
function denied(r,code){assert.equal(r?.ok,false,JSON.stringify(r));if(code)assert.equal(r.error?.code,code,JSON.stringify(r))}
test('C405-PG-01: reject forged staff/outsider and stale revision without side effects',{skip},()=>scenario('stale_revision',async a=>{
 const before=await a.confirmationCounts();assert.equal(before.active_revision,2);
 denied(await a.act('confirm',{expected_revision:2},{actor:'staff'}),'CUSTOMER_VERIFICATION_REQUIRED');
 denied(await a.act('confirm',{expected_revision:2},{actor:'other-customer'}),'WRONG_CUSTOMER');
 denied(await a.act('confirm',{expected_revision:2},{actor:'foreign-customer'}));
 denied(await a.act('confirm',{expected_revision:1},{actor:'customer'}),'STALE_REVISION');
 assert.deepEqual(await a.confirmationCounts(),before);
}));
test('C405-PG-02: replayed synthetic credential confirmation cannot approve/print',{skip},()=>scenario('unapproved_order',async a=>{
 const body={expected_revision:1,kind:'request',idempotency_key:key()};
 assert.equal((await a.act('confirm',body,{actor:'customer'})).ok,true);
 assert.equal((await a.act('confirm',body,{actor:'customer'})).ok,true);
 const count=await a.confirmationCounts();
 assert.equal(count.request,1);assert.equal(count.approved,0);assert.equal(count.jobs,0);
 denied(await a.act('approve',{expected_revision:1,idempotency_key:key()},{actor:'staff'}),'PRINT_NOT_READY');
 assert.equal((await a.confirmationCounts()).jobs,0);
}));
test('C405-PG-03: >150 sheets: quote revision + customer price confirm + separate staff approval',{skip},()=>scenario('large_quote_unconfirmed',async a=>{
 const start=await a.confirmationCounts();assert.equal(start.active_revision,2);assert.equal(start.request,1);assert.equal(start.quote,0);
 denied(await a.act('approve',{expected_revision:2,idempotency_key:key()},{actor:'staff'}),'QUOTE_REQUIRED');
 denied(await a.act('approve',{expected_revision:2,quote_revision:2,idempotency_key:key()},{actor:'staff'}),'PRICE_CONFIRMATION_REQUIRED');
 denied(await a.act('confirm',{expected_revision:2,kind:'quote',quote_revision:1,idempotency_key:key()},{actor:'customer'}),'STALE_QUOTE');
 denied(await a.act('confirm',{expected_revision:2,kind:'quote',quote_revision:2,idempotency_key:key()},{actor:'other-customer'}),'WRONG_CUSTOMER');
 assert.equal((await a.confirmationCounts()).jobs,0);
 const confirmed=await a.act('confirm',{expected_revision:2,kind:'quote',quote_revision:2,idempotency_key:key()},{actor:'customer'});
 assert.equal(confirmed.ok,true,JSON.stringify(confirmed));
 let count=await a.confirmationCounts();assert.equal(count.quote,1);assert.equal(count.approved,0);assert.equal(count.jobs,0);
 const granted=await a.act('approve',{expected_revision:2,quote_revision:2,idempotency_key:key()},{actor:'staff'});
 assert.equal(granted.ok,true,JSON.stringify(granted));
 count=await a.confirmationCounts();assert.equal(count.approved,1);assert.equal(count.jobs,1);
}));
test('C405-PG-04: insufficient deposit warns before separate staff approval',{skip},()=>scenario('deposit_short',async a=>{
 denied(await a.act('approve',{expected_revision:2,acknowledge_deposit_shortage:false,idempotency_key:key()},{actor:'staff'}),'DEPOSIT_WARNING_REQUIRED');
 assert.equal((await a.confirmationCounts()).jobs,0);
 const r=await a.act('approve',{expected_revision:2,acknowledge_deposit_shortage:true,idempotency_key:key()},{actor:'staff'});
 assert.equal(r.ok,true,JSON.stringify(r));
 const count=await a.confirmationCounts();assert.equal(count.approved,1);assert.equal(count.jobs,1);
}));
test('C405-PG-05: two independent PG connections same customer idempotency yield one confirmation',{skip},()=>scenario('stale_revision',async a=>{
 const r=await a.checkConcurrentCustomerConfirmation();
 assert.notEqual(r.connection_ids[0],r.connection_ids[1]);
 assert.equal(r.receipts.length,2);
 assert.equal(r.receipts.filter(x=>x.status==='fulfilled').length,2,JSON.stringify(r.receipts));
 assert.equal(r.counts.request,1);assert.equal(r.counts.approved,0);assert.equal(r.counts.jobs,0);
}));
