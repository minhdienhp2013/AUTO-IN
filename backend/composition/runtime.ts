import Fastify, { type FastifyPluginAsync } from 'fastify';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createCoreModule } from '../core/factory.js';
import { assertOwner, assertStaff, canAccessShop, DomainError, type Principal } from '../core/model.js';
import type { SqlPool } from '../storage/database.js';
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
  /** Explicitly injected verified webhook plugin; the server default stays 503/off. */
  zaloWebhook?: FastifyPluginAsync;
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
  register('POST', '/api/v1/official-zalo/quarantine/:receipt_id/reconcile', async request => {
    const auth = request.headers.authorization?.startsWith('Bearer ')
      ? request.headers.authorization.slice(7) : '';
    const actor = await core.auth.principal(auth);
    assertOwner(actor);
    const receiptId = request.params?.receipt_id ?? '';
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(receiptId))
      throw new DomainError('INVALID_INPUT', 'Receipt id không hợp lệ', 422);
    const body = request.body as {
      disposition?: unknown; note?: unknown; idempotency_key?: unknown
    };
    if ((body.disposition !== 'NO_ORDER_CHANGE' && body.disposition !== 'NEEDS_FOLLOW_UP') ||
        typeof body.note !== 'string' || !body.note.trim() || body.note.length > 500 ||
        typeof body.idempotency_key !== 'string' ||
        !/^[A-Za-z0-9._:-]{1,128}$/.test(body.idempotency_key))
      throw new DomainError('INVALID_INPUT', 'Disposition, note và idempotency_key hợp lệ là bắt buộc', 422);
    const disposition = body.disposition;
    const note = body.note;
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ receipt_id: receiptId, disposition, note })).digest('hex');
    const available = await options.pool.query<{ quarantine: string | null; reviews: string | null }>(
      "SELECT to_regclass('public.zalo_official_quarantine')::text AS quarantine," +
      "to_regclass('public.ai0_official_quarantine_reviews')::text AS reviews");
    if (!available.rows[0]?.quarantine || !available.rows[0]?.reviews)
      throw new DomainError('FEATURE_UNAVAILABLE', 'Đối soát OA chưa được cấu hình', 503);
    const initial = await options.pool.query<{ oa_id: string; shop_id: string }>(
      'SELECT q.oa_id,r.shop_id FROM zalo_official_quarantine q ' +
      'JOIN ai0_official_zalo_oa_registry r ON r.oa_id=q.oa_id WHERE q.id=$1',
      [receiptId]);
    if (initial.rows.length !== 1)
      throw new DomainError('NOT_FOUND', 'Không tìm thấy receipt quarantine', 404);
    const shopId = initial.rows[0]!.shop_id;
    canAccessShop(actor, shopId);

    const connection = await options.pool.connect();
    let inTransaction = false;
    try {
      await connection.query('BEGIN');
      inTransaction = true;
      await connection.query(
        'INSERT INTO zalo_official_quarantine_scopes(oa_id) VALUES($1) ' +
        'ON CONFLICT (oa_id) DO NOTHING', [initial.rows[0]!.oa_id]);
      const scope = await connection.query<{ oa_id: string }>(
        'SELECT oa_id FROM zalo_official_quarantine_scopes WHERE oa_id=$1 FOR UPDATE',
        [initial.rows[0]!.oa_id]);
      if (scope.rows.length !== 1)
        throw new DomainError('PENDING_INBOUND_REVIEW', 'Không khóa được phạm vi OA để đối soát', 409);

      const duplicate = await connection.query<{
        request_hash: string; response_json: unknown
      }>(
        'SELECT request_hash,response_json FROM ai0_official_quarantine_reviews ' +
        'WHERE shop_id=$1 AND actor_id=$2 AND idempotency_key=$3 FOR UPDATE',
        [shopId, actor.id, body.idempotency_key]);
      if (duplicate.rows.length === 1) {
        if (duplicate.rows[0]!.request_hash.trim() !== requestHash)
          throw new DomainError('IDEMPOTENCY_CONFLICT', 'Idempotency key đã dùng với nội dung khác', 409);
        await connection.query('COMMIT');
        inTransaction = false;
        const saved = duplicate.rows[0]!.response_json;
        return saved && typeof saved === 'object' && !Array.isArray(saved)
          ? { ...(saved as Record<string, unknown>), replayed: true } : saved;
      }

      const receipt = await connection.query<{ status: string; oa_id: string; shop_id: string }>(
        'SELECT q.status,q.oa_id,r.shop_id FROM zalo_official_quarantine q ' +
        'JOIN ai0_official_zalo_oa_registry r ON r.oa_id=q.oa_id ' +
        'WHERE q.id=$1 FOR UPDATE OF q',
        [receiptId]);
      if (receipt.rows.length !== 1 || receipt.rows[0]!.shop_id !== shopId)
        throw new DomainError('NOT_FOUND', 'Receipt không còn thuộc OA cửa hàng này', 404);
      if (receipt.rows[0]!.status !== 'NEEDS_HUMAN')
        throw new DomainError('QUARANTINE_ALREADY_REVIEWED', 'Receipt đã được đối soát', 409);

      const reviewId = randomUUID();
      const status = disposition === 'NO_ORDER_CHANGE' ? 'reviewed' : 'pending';
      const response = {
        receipt_id: receiptId, review_id: reviewId, status,
        pending: disposition !== 'NO_ORDER_CHANGE', disposition,
        replayed: false
      };
      await connection.query(
        'INSERT INTO ai0_official_quarantine_reviews ' +
        '(id,receipt_id,oa_id,shop_id,actor_id,idempotency_key,request_hash,disposition,note,response_json) ' +
        'VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)',
        [reviewId, receiptId, receipt.rows[0]!.oa_id, shopId, actor.id,
          body.idempotency_key, requestHash, disposition, note, JSON.stringify(response)]);
      if (disposition === 'NO_ORDER_CHANGE') {
        const updated = await connection.query(
          "UPDATE zalo_official_quarantine SET status='REVIEWED',reviewed_at=clock_timestamp(),reviewed_by=$2 " +
          "WHERE id=$1 AND status='NEEDS_HUMAN' RETURNING id",
          [receiptId, actor.id]);
        if (updated.rowCount !== 1)
          throw new DomainError('QUARANTINE_REVIEW_CONFLICT', 'Receipt đổi trạng thái trong lúc đối soát', 409);
      }
      await connection.query('COMMIT');
      inTransaction = false;
      return response;
    } catch (error) {
      if (inTransaction) {
        try { await connection.query('ROLLBACK'); } catch { /* preserve original error */ }
      }
      throw error;
    } finally {
      connection.release();
    }
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
  if (options.syntheticVerifiedButton)
    app.register(createSyntheticVerifiedButtonPlugin(options.pool,options.syntheticVerifiedButton));
  if (options.zaloWebhook) app.register(options.zaloWebhook);
  else app.post('/webhooks/zalo', async (_request, reply) => reply.code(503).send({ error: {
    code: 'FEATURE_UNAVAILABLE', message: 'Verified pipeline wiring pending', retryable: false } }));
  return app;
}
