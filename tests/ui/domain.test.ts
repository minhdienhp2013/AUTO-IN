import test from 'node:test';
import assert from 'node:assert/strict';
import { demoOrders } from '../../web/src/fixtures.ts';
import { actionPath, depositShortfall, hasValidApprovalInputs, isPrintUncertain, receivable } from '../../web/src/domain.ts';

test('only customer-confirmed current revision with trustworthy preview may be approved', () => {
  const confirmed = structuredClone(demoOrders[0]);
  assert.equal(hasValidApprovalInputs(confirmed), true);
  confirmed.revision++;
  assert.equal(hasValidApprovalInputs(confirmed), false);
  confirmed.revision--;
  confirmed.documents[0].preview_trusted = false;
  assert.equal(hasValidApprovalInputs(confirmed), false);
  assert.equal(hasValidApprovalInputs(demoOrders[1]), false);
});
test('over 150 sheets must have price confirmation at current quote revision', () => {
  const order = structuredClone(demoOrders[0]);
  order.total_sheets = 151;
  assert.equal(hasValidApprovalInputs(order), true);
  order.confirmed_quote_revision = null;
  assert.equal(hasValidApprovalInputs(order), false);
  order.confirmed_quote_revision = order.quote_revision;
  order.large_cost_flag = true;
  assert.equal(hasValidApprovalInputs(order), true);
});
test('never equate uncertain print state with not sent', () => {
  for (const state of ['SENDING','SENT_UNVERIFIED','UNKNOWN'] as const) assert.equal(isPrintUncertain(state), true);
  assert.equal(isPrintUncertain('NOT_SENT'), false);
  const order = structuredClone(demoOrders[0]); order.print_state = 'UNKNOWN';
  assert.equal(hasValidApprovalInputs(order), false);
});
test('deposit shortfall is warning, not automatic approval veto', () => {
  assert.equal(depositShortfall(demoOrders[0]), 20000);
  assert.equal(hasValidApprovalInputs(demoOrders[0]), true);
  assert.equal(receivable(demoOrders[0]), 58000);
});
test('action paths follow wire v0.1; no invented reprint or exception route', () => {
  const o = demoOrders[0];
  assert.equal(actionPath(o,'approve'),'/api/v1/orders/MD-260001/approvals');
  assert.equal(actionPath(o,'handover'),'/api/v1/conversations/conv-demo-01/handover');
  assert.equal(actionPath(o,'return_to_ai'),'/api/v1/conversations/conv-demo-01/return-to-ai');
});