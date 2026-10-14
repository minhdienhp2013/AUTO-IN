import Fastify, { type FastifyPluginAsync } from 'fastify';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createCoreModule } from '../core/factory.js';
import { assertStaff, DomainError, type Principal } from '../core/model.js';
import type { SqlPool } from '../storage/database.js';
import { createOfficialZaloSimulationWebhook } from './official-zalo-simulation.js';
import type { OfficialZaloWebhookConfig } from '../integrations/zalo/official-webhook.js';
import type { RouteRegistrar } from '../api/routes.js';
import { ingestSyntheticArtifact, type SyntheticArtifactScope } from './synthetic-ingest.js';
import { loadVerifiedOrderPreview, loadVerifiedOrderPreviewCatalog } from './preview.js';
import { createSyntheticInboundDraft } from './inbound-draft.js';
import { reconcileSyntheticInboundDraft } from './inbound-reconcile.js';
import { createSyntheticVerifiedButtonPlugin, type SyntheticButtonScope } from './synthetic-verified-button.js';
import { pendingReviewSqlPool } from './pending-review-errors.js';
import { assertApprovedPrintJobEvidence, type ApprovedDocumentEvidenceOptions } from './approved-document-evidence.js';

export interface ServiceIdentity { token: string; principal: Principal }
export interface RuntimeOptions {
  pool: SqlPool;
  identities?: readonly ServiceIdentity[];
  tls?: { key: Buffer; cert: Buffer };
  /** Only AI2's verifier/pipeline may be injected; absent means explicit 503. */
  zaloWebhook?: FastifyPluginAsync;
  /** Synthetic-signature contract only. buildIntegratedApp is simulation-only;
   * backend/server.ts deliberately never reads or supplies this option.
   * This does not verify Zalo provider compatibility or enable a live OA.
   */
  officialZaloSimulation?: OfficialZaloWebhookConfig;
  zaloWorkerConfigured?: boolean;
  syntheticArtifactIngest?: { artifactRoot: string; scope: SyntheticArtifactScope };
  previewArtifactRoot?: string;
  /** Opt-in HMAC signed fixture endpoint; NEVER configured for live OA. */
  syntheticVerifiedButton?: SyntheticButtonScope;
  /** Required before an approved job can enter SENDING; reads only server-bound artifacts. */
  approvedDocumentEvidence?: ApprovedDocumentEvidenceOptions;
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
  if (options.zaloWebhook && options.officialZaloSimulation)
    throw new Error('CONFLICTING_ZALO_WEBHOOK_CONFIGURATION');
  const core = createCoreModule({ pool: pendingReviewSqlPool(options.pool) });
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
      const agentRoute = path.startsWith('/internal/v1/print-jobs') && !path.endsWith('/reports');
      const printAgent = agentRoute
        ? await resolve({ headers: { authorization: request.headers.authorization } })
        : undefined;
      if (printAgent) {
        const settings = await options.pool.query<{ mode: string }>(
          'SELECT mode FROM core_shop_settings WHERE shop_id=$1', [printAgent.shop_id]);
        if (settings.rows[0]?.mode !== 'simulation')
          throw new DomainError('SIMULATION_REQUIRED', 'Simulation shop required', 409);
      }
      if (method === 'POST' && (request.body === null || typeof request.body !== 'object' || Array.isArray(request.body)))
        throw new DomainError('INVALID_INPUT', 'JSON object required', 422);
      const headers = Object.fromEntries(Object.entries(request.headers)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
      const routedRequest = { headers, body: request.body,
        params: request.params as Record<string, string>, query: request.query as Record<string, string> };
      const params = request.params as { job_id?: string };
      const body = request.body as { expected_revision?: number; lease_token?: string };
      if (printAgent && method === 'POST' && path === '/internal/v1/print-jobs/:job_id/mark-sending') {
        const current = await options.pool.query<{ state: string }>(
          'SELECT j.state FROM core_print_jobs j JOIN core_orders o ON o.id=j.order_id ' +
          'WHERE j.id=$1 AND o.shop_id=$2 AND j.claimed_by=$3',
          [params.job_id, printAgent.shop_id, printAgent.id]);
        // Preserve Core's idempotent replay after SENDING; only a fresh side-effect
        // boundary needs the document evidence gate.
        if (current.rows[0]?.state === 'NOT_SENT') {
          await core.service.preflight(printAgent, params.job_id ?? '', {
            expected_revision: body.expected_revision as number,
            lease_token: body.lease_token as string
          });
          await assertApprovedPrintJobEvidence(options.pool, printAgent, {
            jobId: params.job_id ?? '',
            expectedRevision: body.expected_revision as number,
            leaseToken: body.lease_token as string
          }, options.approvedDocumentEvidence);
        }
      }
      const result = await handler(routedRequest, reply);
      if (printAgent && method === 'POST' && path === '/internal/v1/print-jobs/:job_id/preflight' &&
          result !== null && typeof result === 'object' &&
          (result as { allowed?: unknown }).allowed === true) {
        await assertApprovedPrintJobEvidence(options.pool, printAgent, {
          jobId: params.job_id ?? '',
          expectedRevision: body.expected_revision as number,
          leaseToken: body.lease_token as string
        }, options.approvedDocumentEvidence);
        return { ...(result as Record<string, unknown>), document_evidence_verified: true };
      }
      return result;
    } });
  };
  core.registerRoutes({ get: (p, h) => register('GET', p, h), post: (p, h) => register('POST', p, h) }, {
    resolveVerifiedCustomer: resolve, resolvePrintAgent: resolve
  });
  app.get('/health', async () => ({ status: 'ok', mode: 'simulation', live_enabled: false,
    auth_configured: true, configured_operations: ['me', 'listOrders', 'approveOrder', 'claimJob', 'markSending', 'reportJob'],
    registered_routes: registered, zalo_webhook_configured: !!options.zaloWebhook || !!options.officialZaloSimulation,
    official_zalo_simulation_configured: !!options.officialZaloSimulation,
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
  if (options.syntheticVerifiedButton)
    app.register(createSyntheticVerifiedButtonPlugin(options.pool,options.syntheticVerifiedButton));
  if (options.officialZaloSimulation)
    app.register(createOfficialZaloSimulationWebhook(options.pool, options.officialZaloSimulation));
  else if (options.zaloWebhook) app.register(options.zaloWebhook);
  else app.post('/webhooks/zalo', async (_request, reply) => reply.code(503).send({ error: {
    code: 'FEATURE_UNAVAILABLE', message: 'Verified pipeline wiring pending', retryable: false } }));
  return app;
}
