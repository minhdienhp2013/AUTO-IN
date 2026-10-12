import Fastify, { type FastifyPluginAsync } from 'fastify';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createCoreModule } from '../core/factory.js';
import { assertStaff, DomainError, type Principal } from '../core/model.js';
import type { SqlPool } from '../storage/database.js';
import type { RouteRegistrar } from '../api/routes.js';
import { ingestSyntheticArtifact, type SyntheticArtifactScope } from './synthetic-ingest.js';
import { loadVerifiedOrderPreview, loadVerifiedOrderPreviewCatalog } from './preview.js';
import { createSyntheticInboundDraft } from './inbound-draft.js';
import { reconcileSyntheticInboundDraft } from './inbound-reconcile.js';

export interface ServiceIdentity { token: string; principal: Principal }
export interface RuntimeOptions {
  pool: SqlPool;
  identities?: readonly ServiceIdentity[];
  tls?: { key: Buffer; cert: Buffer };
  /** Only AI2's verifier/pipeline may be injected; absent means explicit 503. */
  zaloWebhook?: FastifyPluginAsync;
  zaloWorkerConfigured?: boolean;
  syntheticArtifactIngest?: { artifactRoot: string; scope: SyntheticArtifactScope };
  previewArtifactRoot?: string;
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
    processor_configured: false, preview_configured: !!options.previewArtifactRoot,
    synthetic_artifact_ingest_configured: !!options.syntheticArtifactIngest,
    integration_stage: 'core-http' }));
  // Authenticated server-owned operation truth for the AI4 product adapter.
  // Never infer this from the browser environment or anonymous /health.
  app.get('/api/v1/runtime-status', async (request, reply) => {
    const token = request.headers.authorization?.startsWith('Bearer ')
      ? request.headers.authorization.slice(7) : '';
    const actor = await core.auth.principal(token);
    assertStaff(actor);
    const settings = await options.pool.query<{mode:string;manual_lock:boolean}>(
      'SELECT mode,manual_lock FROM core_shop_settings WHERE shop_id=$1',
      [actor.shop_id]);
    if (settings.rows.length!==1 || settings.rows[0]?.mode!=='simulation')
      throw new DomainError('SIMULATION_REQUIRED','Only isolated simulation is configured',409);
    return reply.header('Cache-Control','no-store')
      .header('X-Content-Type-Options','nosniff')
      .send({
        server_verified: true,
        mode: 'simulation',
        live_enabled: false,
        physical_print_enabled: false,
        manual_lock: settings.rows[0].manual_lock,
        preview_configured: !!options.previewArtifactRoot,
        synthetic_artifact_ingest_configured: !!options.syntheticArtifactIngest
      });
  });
  app.post('/internal/simulation/inbound-artifacts', async (request, reply) => {
    if (!options.syntheticArtifactIngest) throw new DomainError('FEATURE_UNAVAILABLE', 'Synthetic import unavailable', 503);
    const token = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : '';
    const actor = await core.auth.principal(token);
    const outcome = await ingestSyntheticArtifact(options.pool, options.syntheticArtifactIngest.artifactRoot,
      options.syntheticArtifactIngest.scope, actor, request.body);
    return reply.code(outcome.status === 'registered' ? 201 : 200).send(outcome);
  });
  app.post('/internal/simulation/inbound-artifacts/:event_id/draft', async (request, reply) => {
    if (!options.syntheticArtifactIngest) throw new DomainError('FEATURE_UNAVAILABLE', 'Synthetic draft unavailable', 503);
    const token = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : '';
    const actor = await core.auth.principal(token);
    const eventId = (request.params as {event_id:string}).event_id;
    const body = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new DomainError('INVALID_INPUT', 'JSON object required', 422);
    const result = await createSyntheticInboundDraft(options.pool,core.service,
      options.syntheticArtifactIngest.artifactRoot,options.syntheticArtifactIngest.scope,
      actor,{...body,event_id:eventId});
    return reply.code(result.status==='created'?201:200).send(result);
  });
  app.post('/internal/simulation/inbound-artifacts/:event_id/reconcile', async (request, reply) => {
    if (!options.syntheticArtifactIngest) throw new DomainError('FEATURE_UNAVAILABLE', 'Synthetic reconciliation unavailable', 503);
    const token = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : '';
    const actor = await core.auth.principal(token);
    const eventId = (request.params as {event_id:string}).event_id;
    const body = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new DomainError('INVALID_INPUT', 'JSON object required', 422);
    const outcome = await reconcileSyntheticInboundDraft(options.pool,
      options.syntheticArtifactIngest.artifactRoot,options.syntheticArtifactIngest.scope,
      actor,{...body,event_id:eventId});
    return reply.code(200).send(outcome);
  });
  app.get('/api/v1/orders/:order_id/revisions/:revision/previews', async (request, reply) => {
    if (!options.previewArtifactRoot) throw new DomainError('FEATURE_UNAVAILABLE', 'Verified preview unavailable', 503);
    const token = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : '';
    const actor = await core.auth.principal(token);
    const params = request.params as {order_id:string;revision:string};
    const catalog = await loadVerifiedOrderPreviewCatalog(options.pool,
      options.previewArtifactRoot,actor,params.order_id,Number(params.revision));
    return reply.header('Cache-Control','no-store')
      .header('X-Content-Type-Options','nosniff')
      .header('Content-Security-Policy',"default-src 'none'")
      .send(catalog);
  });
  app.get('/api/v1/orders/:order_id/revisions/:revision/previews/:index', async (request, reply) => {
    if (!options.previewArtifactRoot) throw new DomainError('FEATURE_UNAVAILABLE', 'Verified preview unavailable', 503);
    const token = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : '';
    const actor = await core.auth.principal(token);
    const params = request.params as { order_id: string; revision: string; index: string };
    const preview = await loadVerifiedOrderPreview(options.pool, options.previewArtifactRoot,
      actor, params.order_id, Number(params.revision), Number(params.index));
    return reply.header('Content-Type', 'image/png')
      .header('Cache-Control', 'no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'")
      .send(preview);
  });
  if (options.zaloWebhook) app.register(options.zaloWebhook);
  else app.post('/webhooks/zalo', async (_request, reply) => reply.code(503).send({ error: {
    code: 'FEATURE_UNAVAILABLE', message: 'Verified pipeline wiring pending', retryable: false } }));
  return app;
}
