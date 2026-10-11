import type { SchemaName } from './schemas.js';
export interface RouteContract {
  operation: string; method: 'GET' | 'POST'; path: string; owner: 'AI1' | 'AI2';
  input?: SchemaName; output: SchemaName; roles: readonly string[]; permission?: string;
}
const staff = ['owner', 'staff'];
const employee = (operation: string, path: string, input: SchemaName, permission: string): RouteContract =>
  ({ operation, method: 'POST', path, owner: 'AI1', input, output: 'Order', roles: staff, permission });
export const routes: readonly RouteContract[] = [
  { operation: 'login', method: 'POST', path: '/api/v1/auth/login', owner: 'AI1', input: 'LoginRequest', output: 'LoginResponse', roles: [] },
  { operation: 'logout', method: 'POST', path: '/api/v1/auth/logout', owner: 'AI1', input: 'EmptyRequest', output: 'Ack', roles: staff },
  { operation: 'me', method: 'GET', path: '/api/v1/auth/me', owner: 'AI1', output: 'Principal', roles: staff },
  { operation: 'listOrders', method: 'GET', path: '/api/v1/orders', owner: 'AI1', input: 'OrderQuery', output: 'OrderList', roles: staff, permission: 'orders:read' },
  { operation: 'createOrder', method: 'POST', path: '/api/v1/orders', owner: 'AI1', input: 'CreateOrderRequest', output: 'Order', roles: staff, permission: 'orders:write' },
  { operation: 'getOrder', method: 'GET', path: '/api/v1/orders/{order_id}', owner: 'AI1', output: 'Order', roles: staff, permission: 'orders:read' },
  employee('reviseOrder', '/api/v1/orders/{order_id}/revisions', 'ReviseOrderRequest', 'orders:write'),
  { operation: 'confirmOrder', method: 'POST', path: '/api/v1/orders/{order_id}/confirmations', owner: 'AI1', input: 'ConfirmRequest', output: 'Order', roles: ['customer'], permission: 'orders:confirm' },
  employee('approveOrder', '/api/v1/orders/{order_id}/approvals', 'ApproveRequest', 'orders:approve'),
  employee('quoteOrder', '/api/v1/orders/{order_id}/quote', 'QuoteRequest', 'orders:quote'),
  employee('recordPayment', '/api/v1/orders/{order_id}/payments', 'PaymentRequest', 'orders:money'),
  employee('recordDelivery', '/api/v1/orders/{order_id}/deliveries', 'DeliveryRequest', 'orders:deliver'),
  employee('manualOrder', '/api/v1/orders/{order_id}/manual', 'ManualRequest', 'orders:manual'),
  { operation: 'claimJob', method: 'POST', path: '/internal/v1/print-jobs/claim', owner: 'AI1', input: 'ClaimRequest', output: 'ClaimResponse', roles: ['agent'], permission: 'jobs:send' },
  ...(['preflight', 'mark-sending', 'reports'] as const).map((action): RouteContract => ({
    operation: ({ preflight: 'preflightJob', 'mark-sending': 'markSending', reports: 'reportJob' })[action], method: 'POST',
    path: `/internal/v1/print-jobs/{job_id}/${action}`, owner: 'AI1',
    input: action === 'reports' ? 'ReportRequest' : 'JobActionRequest', output: action === 'mark-sending' ? 'SendingResponse' : 'PrintJob',
    roles: ['agent'], permission: 'jobs:send'
  })),
  ...(['handover', 'return-to-ai'] as const).map((action): RouteContract => ({
    operation: action === 'handover' ? 'handoverConversation' : 'returnConversationToAi', method: 'POST',
    path: `/api/v1/conversations/{conversation_id}/${action}`, owner: 'AI1', input: 'ConversationRequest', output: 'ConversationResponse',
    roles: staff, permission: 'conversations:manage'
  }))
];
