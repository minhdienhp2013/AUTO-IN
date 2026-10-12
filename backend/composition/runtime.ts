import Fastify, { type FastifyPluginAsync } from 'fastify';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createCoreModule } from '../core/factory.js';
import { DomainError, type Principal } from '../core/model.js';
import type { SqlPool } from '../storage/database.js';
import type { RouteRegistrar } from '../api/routes.js';

export interface ServiceIdentity { token: string; principal: Principal }
export interface RuntimeOptions {
  pool: SqlPool;
  identities?: readonly ServiceIdentity[];
  tls?: { key: Buffer; cert: Buffer };
  /** Only AI2's verifier/pipeline may be injected; absent means explicit 503. */
  zaloWebhook?: FastifyPluginAsync;
  zaloWorkerConfigured?: boolean;
}
export function identityResolver(identities: readonly ServiceIdentity[]) {
  for (const identity of identities) {
    if (typeof identity?.token !== 'string' || identity.token.length < 32 || !identity.principal?.verified ||
        !identity.principal.id || !identity.principal.shop_id ||
        !['customer', 'print_agent'].includes(identity.principal.role)) {
      throw new Error('Invalid server-owned service identity');
    }
  }
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return async (request: { headers: Record<string, string | undefined> }) => {
    const token = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : '';
    const match = identities.find(identity => timingSafeEqual(digest(token), digest(identity.token)));
    if (!match) throw new DomainError('UNAUTHENTICATED', 'Credential required', 401);
    return match.principal;
  };
}

/** Simulation-only composition. Uses AI1 routes exactly once, not CODE-000 routes. */
export function buildIntegratedApp(options: RuntimeOptions) {
  const core = createCoreModule({ pool: options.pool });
  const resolve = identityResolver(options.identities ?? []);
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024,
    ...(options.tls ? { https: options.tls } : {}) });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof DomainError) return reply.code(error.status).send({ error: {
      code: error.code, message: error.message, retryable: error.retryable } });
    const status = (error as { statusCode?: number }).statusCode;
    return reply.code(status && status >= 400 && status < 500 ? status : 500)
      .send({ error: { code: status === 400 ? 'INVALID_HTTP_REQUEST' : 'INTERNAL_ERROR',
        message: 'Request failed', retryable: false } });
  });
  const registered: string[] = [];
  const register = (method: 'GET' | 'POST', path: string,
    handler: Parameters<RouteRegistrar['post']>[1]) => {
    registered.push(`${method} ${path}`);
    app.route({ method, url: path, handler: async (request, reply) => {
      // Refuse any real-mode shop at the send boundary, even if DB was changed externally.
      if (path.startsWith('/internal/v1/print-jobs') && !path.endsWith('/reports')) {
        const principal = await resolve({ headers: { authorization: request.headers.authorization } });
        const settings = await options.pool.query<{ mode: string }>(
          'SELECT mode FROM core_shop_settings WHERE shop_id=$1', [principal.shop_id]);
        if (settings.rows[0]?.mode !== 'simulation')
          throw new DomainError('SIMULATION_REQUIRED', 'Simulation shop required', 409);
      }
      if (method === 'POST' && (request.body === null || typeof request.body !== 'object' || Array.isArray(request.body)))
        throw new DomainError('INVALID_INPUT', 'JSON object required', 422);
      const headers = Object.fromEntries(Object.entries(request.headers)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
      return handler({ headers, body: request.body,
        params: request.params as Record<string, string>, query: request.query as Record<string, string> }, reply);
    } });
  };
  core.registerRoutes({ get: (p, h) => register('GET', p, h), post: (p, h) => register('POST', p, h) }, {
    resolveVerifiedCustomer: resolve, resolvePrintAgent: resolve
  });
  app.get('/health', async () => ({ status: 'ok', mode: 'simulation', live_enabled: false,
    auth_configured: true, configured_operations: ['me', 'listOrders', 'approveOrder', 'claimJob', 'markSending', 'reportJob'],
    registered_routes: registered, zalo_webhook_configured: !!options.zaloWebhook,
    zalo_worker_configured: options.zaloWorkerConfigured === true,
    processor_configured: false, integration_stage: 'core-http' }));
  if (options.zaloWebhook) app.register(options.zaloWebhook);
  else app.post('/webhooks/zalo', async (_request, reply) => reply.code(503).send({ error: {
    code: 'FEATURE_UNAVAILABLE', message: 'Verified pipeline wiring pending', retryable: false } }));
  return app;
}
