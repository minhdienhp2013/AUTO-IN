import Fastify, { type FastifyInstance, type FastifyPluginAsync } from 'fastify';
import { routes } from '../contracts/routes.js';
import { valid, validJob } from '../contracts/validation.js';
import type { AuthPort, Handlers } from '../contracts/ports.js';
import { ContractError } from '../contracts/ports.js';
import type { AuthPrincipal, RuntimeMode } from '../contracts/schemas.js';
export interface AppDependencies {
  mode?: RuntimeMode; auth?: AuthPort; handlers?: Handlers;
  /** AI2 owns route and raw-body verification when integrated. */
  zaloWebhook?: FastifyPluginAsync;
}
function validPrincipal(p: unknown): p is AuthPrincipal {
  return valid('Principal', p) && (p.role !== 'customer' || !!(p.customer_id && p.verified_channel_id)) &&
    (p.role !== 'agent' || !!(p.agent_id && p.printer_ids?.length));
}
export function buildApp(dependencies: AppDependencies = {}): FastifyInstance {
  const mode = dependencies.mode ?? 'simulation';
  if (!valid('Mode', mode)) throw new Error('Invalid AUTO_IN_MODE');
  // CODE-000 has no verified live integration or owner activation service.
  if (mode === 'production' || mode === 'controlled_test') throw new Error('Live mode unavailable until CODE-006 and authorized verification');
  const handlers = dependencies.handlers ?? {};
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ContractError) return reply.code(error.status).send({ error: {
      code: error.code, message: error.message, retryable: error.retryable,
      ...(error.current_revision === undefined ? {} : { current_revision: error.current_revision })
    } });
    const status = typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : undefined;
    if (status && status >= 400 && status < 500) return reply.code(status).send({ error: { code: 'INVALID_HTTP_REQUEST', message: 'Invalid HTTP request', retryable: false } });
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Internal error', retryable: false } });
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found', retryable: false } }));
  app.get('/health', async () => ({ status: 'ok', contract_version: '0.1.0', mode, live_enabled: false,
    auth_configured: !!dependencies.auth, configured_operations: Object.keys(handlers).filter(k => routes.some(r => r.operation === k)).sort(),
    zalo_webhook_configured: !!dependencies.zaloWebhook }));
  for (const route of routes) {
    app.route({ method: route.method, url: route.path.replace(/\{([^}]+)\}/g, ':$1'), handler: async (request, reply) => {
      let principal: AuthPrincipal | null = null;
      if (route.roles.length) {
        const authenticated = await dependencies.auth?.authenticate(request);
        if (!authenticated || !validPrincipal(authenticated)) throw new ContractError(401, 'UNAUTHENTICATED', 'Authentication required');
        principal = authenticated;
        if (!route.roles.includes(principal.role) || (route.permission && !principal.permissions.includes(route.permission))) {
          throw new ContractError(403, 'FORBIDDEN', 'Permission denied');
        }
      }
      const params = request.params as Record<string, string>;
      if (Object.values(params).some(p => !valid('Id', p))) throw new ContractError(422, 'INVALID_INPUT', 'Invalid identifier');
      const query = { ...(request.query as Record<string, unknown>) };
      if (typeof query.limit === 'string' && /^[1-9]\d*$/.test(query.limit)) query.limit = Number(query.limit);
      const input: unknown = route.method === 'GET' ? query : request.body;
      if (route.input && !valid(route.input, input)) throw new ContractError(422, 'INVALID_INPUT', 'Payload does not match contract');
      if (route.operation === 'claimJob' && valid('ClaimRequest', input) && !principal?.printer_ids?.includes(input.printer_id)) {
        throw new ContractError(403, 'PRINTER_SCOPE_DENIED', 'Printer outside agent scope');
      }
      if (mode === 'safe' && ['claimJob', 'preflightJob', 'markSending'].includes(route.operation)) throw new ContractError(409, 'SAFE_MODE', 'Sending is paused');
      // Report mode belongs to the immutable send-time job snapshot, not current runtime mode.
      // AI1 compares it with the job under transaction; safe mode must still accept reconciliation.
      const handler = handlers[route.operation];
      if (!handler) throw new ContractError(503, 'FEATURE_UNAVAILABLE', 'Module not integrated', true);
      const output = await handler({ principal, mode, params, input, ...(['login', 'logout'].includes(route.operation) ? { setSessionCookie: (cookie: string) => { reply.header('set-cookie', cookie); } } : {}) });
      if (!valid(route.output, output) || (route.output === 'PrintJob' && !validJob(output)) ||
          (route.output === 'ClaimResponse' && valid('ClaimResponse', output) && output.job !== null && !validJob(output.job))) {
        throw new Error('Handler response violates contract');
      }
      return reply.code(200).send(output);
    } });
  }
  if (dependencies.zaloWebhook) app.register(dependencies.zaloWebhook);
  else app.post('/webhooks/zalo', async () => { throw new ContractError(503, 'FEATURE_UNAVAILABLE', 'Verified Zalo adapter not integrated', true); });
  return app;
}
