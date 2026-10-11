import test from 'node:test';
import assert from 'node:assert/strict';
import { mapCoreOrderDetail } from '../../web/src/api.ts';
import { coreDetail } from './core-fixtures.ts';

test('verified job with partial counted paper cannot show delivered or printing complete', () => {
 const sample = coreDetail();
 sample.order.delivered_sheets = 10;
 sample.jobs = [{id:'j1', revision:3, state:'VERIFIED_DONE', printer_id:'RMP7000', mode_at_send:'controlled_test', verified_sheets:10}];
 const view = mapCoreOrderDetail(sample);
 assert.equal(view.print_state, 'VERIFIED_DONE');
 assert.equal(view.verified_sheets, 10);
 assert.equal(view.delivery_state, 'partial');
 assert.ok(view.warnings.some(w => w.includes('chưa đủ')));
});
test('verified job without paper count must not pretend full delivery', () => {
 const sample = coreDetail();
 sample.order.delivered_sheets = 180;
 sample.jobs = [{id:'j1', revision:3, state:'VERIFIED_DONE', printer_id:'RMP7000'}];
 const view = mapCoreOrderDetail(sample);
 assert.equal(view.verified_sheets, null);
 assert.notEqual(view.delivery_state, 'delivered');
});
test('simulated job cannot provide verified sheets even when untrusted response claims paper', () => {
 const sample = coreDetail();
 sample.jobs = [{id:'j1', revision:3, state:'SIMULATED_DONE', printer_id:'RMP7000', verified_sheets:180}];
 const view = mapCoreOrderDetail(sample);
 assert.equal(view.verified_sheets, null);
 assert.equal(view.print_state, 'SIMULATED_DONE');
 assert.notEqual(view.delivery_state, 'delivered');
});

test('pg BIGINT decimal text converts only when safe and integral', () => {
 const sample = coreDetail();
 sample.order.delivered_sheets = '2' as unknown as number;
 sample.quote.amount_vnd = '160000' as unknown as number;
 sample.jobs = [{id:'j1', revision:3, state:'VERIFIED_DONE', printer_id:'RMP7000', mode_at_send:'production', verified_sheets:'20'}] as typeof sample.jobs;
 const view=mapCoreOrderDetail(sample);
 assert.equal(view.delivered_sheets,2);
 assert.equal(view.amount_vnd,160000);
 assert.equal(view.verified_sheets,20);
 sample.jobs=[{id:'j2',revision:3,state:'VERIFIED_DONE',printer_id:'RMP7000',mode_at_send:'production',verified_sheets:'9007199254740993'}] as typeof sample.jobs;
 assert.equal(mapCoreOrderDetail(sample).verified_sheets,null);
});