import Fastify, { type FastifyPluginAsync } from 'fastify';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createCoreModule } from '../core/factory.js';
import { assertStaff, DomainError, type Principal } from '../core/model.js';
import type { SqlPool } from '../storage/database.js';
import { createOfficialZaloSimulationWebhook } from './official-zalo-simulation.js';
import type { OfficialZaloWebhookConfig } from '../integrations/zalo/official-webhook.js';
import type { CoreRouteDependencies, RouteRegistrar } from '../api/routes.js';
import type { TrustedPdfReviewSourceReader } from '../core/pdf-review-source.js';
import type { TrustedWordReviewSourceReader } from '../core/word-review-source.js';
import { ingestSyntheticArtifact, type SyntheticArtifactScope } from './synthetic-ingest.js';
import { loadVerifiedOrderPreview, loadVerifiedOrderPreviewCatalog } from './preview.js';
import { createSyntheticInboundDraft } from './inbound-draft.js';
import { reconcileSyntheticInboundDraft } from './inbound-reconcile.js';
import { adoptSyntheticSourceHttp } from './source-adoption-http.js';
import {classifyBoundFirstPage} from './first-page-suggestion.js';
import {previewBoundFirstPageQuestion,resolveBoundFirstPageQuestionScope} from './first-page-question-port.js';
import type {FirstPageQuestionScope} from '../conversation/first-page-question.js';
import { createSyntheticVerifiedButtonPlugin, type SyntheticButtonScope } from './synthetic-verified-button.js';
import { pendingReviewSqlPool } from './pending-review-errors.js';
import { assertApprovedPrintJobEvidence, type ApprovedDocumentEvidenceOptions } from './approved-document-evidence.js';
import { createTrustedPrintEvidencePort, type TrustedPrintEvidenceOptions } from './trusted-print-evidence.js';
import { createSyntheticPdfReviewSourceReader } from './pdf-review-source.js';
import { createPdfReviewPreviewService } from './pdf-review-preview.js';
import { createSyntheticWordReviewSourceReader } from './word-review-source.js';
import { createWordReviewPreviewService } from './word-review-preview.js';
import { admitAgentRoute, type ControlledPilotScope } from './controlled-pilot-admission.js';

export interface ServiceIdentity { token: string; principal: Principal }
/** Server-owned pilot dependencies. This runtime remains simulation-only. */
export interface PilotWordPdfSimulationOptions {
  hmacKey: Uint8Array;
  pdfSource?: TrustedPdfReviewSourceReader;
  wordSource?: TrustedWordReviewSourceReader;
  resolveCandidate: NonNullable<CoreRouteDependencies['resolvePilotCandidate']>;
  resolveCodeSubmission: NonNullable<CoreRouteDependencies['resolvePilotCodeSubmission']>;
}
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
  officialZaloSimulation?: { shop_id: string; webhook: OfficialZaloWebhookConfig };
  zaloWorkerConfigured?: boolean;
  syntheticArtifactIngest?: { artifactRoot: string; scope: SyntheticArtifactScope };
  /** AI2's simulation-only advisory enqueue hook. This never sends a provider message. */
  firstPageQuestionQueue?: (input:{outbound_id:string;
    scope:Readonly<FirstPageQuestionScope>})=>Promise<unknown>;
  previewArtifactRoot?: string;
  /** Opt-in HMAC signed fixture endpoint; NEVER configured for live OA. */
  syntheticVerifiedButton?: SyntheticButtonScope;
  /** Required before an approved job can enter SENDING; reads only server-bound artifacts. */
  approvedDocumentEvidence?: ApprovedDocumentEvidenceOptions;
  /** Private simulation-only root for generated PDF review bundles/pages. Must be owner-only (0700). */
  pdfReviewArtifactRoot?: string;
  /** Optional interpreter override for the bounded native PDF review CLI. */
  nativePdfReviewPython?: string;
  /** Private simulation-only root for native Word review bundles/pages. Must be owner-only (0700). */
  wordReviewArtifactRoot?: string;
  /** Optional interpreter override for the bounded native Word review CLI. */
  nativeWordReviewPython?: string;
  /** Explicit operator opt-in to launch Word for review only; never authorizes print. */
  allowNativeWordLaunch?: boolean;
  /** Opt-in V1 Core gate. This simulation runtime accepts synthetic capability
   * snapshots only; it cannot authorize a real Windows/Ricoh print operation.
   */
  trustedPrintEvidence?: TrustedPrintEvidenceOptions;
  /** Explicit simulation-only wiring for the V1 Word/PDF pilot. */
  pilotWordPdf?: PilotWordPdfSimulationOptions;
  /** Server-owned, one-order Windows trial admission. Core still checks the
   * expiring owner grant at claim/preflight/mark-sending. Absent by default. */
  controlledPilot?: ControlledPilotScope;
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

/** Stable across HTTP retries; a new revision or changed source gets a new ID. */
function firstPageQuestionOutboundId(input:{shop_id:string;order_id:string;revision:number;
  request_hash:string;source_sha256:string}):string {
  const bytes=createHash('sha256').update([
    'AUTO-IN:TN005:first-page-question:v1',input.shop_id,input.order_id,
    String(input.revision),input.request_hash,input.source_sha256
  ].join('\0')).digest().subarray(0,16);
  bytes[6]=(bytes[6]!&0x0f)|0x50;
  bytes[8]=(bytes[8]!&0x3f)|0x80;
  const hex=bytes.toString('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-`+
    `${hex.slice(16,20)}-${hex.slice(20)}`;
}

function queuedQuestionId(value:unknown,outboundId:string):boolean {
  return !!value&&typeof value==='object'&&!Array.isArray(value)&&
    (value as {status?:unknown}).status==='queued'&&
    (value as {outbound_id?:unknown}).outbound_id===outboundId;
}

function staleWordPreview(): DomainError {
  return new DomainError('STALE_WORD_PREVIEW', 'Đơn hoặc file Word đã đổi; cần tạo preview mới', 409);
}

/** Simulation-only composition. Uses AI1 routes exactly once, not CODE-000 routes. */
export function buildIntegratedApp(options: RuntimeOptions) {
  const controlled = options.controlledPilot;
  if (controlled && (!options.tls || !options.pilotWordPdf || options.zaloWebhook ||
      options.officialZaloSimulation || options.syntheticArtifactIngest ||
      !controlled.shop_id?.trim() || !controlled.order_id?.trim() ||
      controlled.printer_id !== 'RMP7000'))
    throw new Error('CONTROLLED_PILOT_CONFIGURATION_REQUIRED');
  if (options.zaloWebhook && options.officialZaloSimulation)
    throw new Error('CONFLICTING_ZALO_WEBHOOK_CONFIGURATION');
  if (options.pilotWordPdf && (!options.trustedPrintEvidence ||
      options.pilotWordPdf.hmacKey.byteLength < 32 ||
      typeof options.pilotWordPdf.resolveCandidate !== 'function' ||
      typeof options.pilotWordPdf.resolveCodeSubmission !== 'function'))
    throw new Error('PILOT_WORD_PDF_SIMULATION_CONFIGURATION_REQUIRED');
  const corePool = pendingReviewSqlPool(options.pool);
  const trustedPrintEvidence = options.trustedPrintEvidence
    ? createTrustedPrintEvidencePort(options.trustedPrintEvidence) : undefined;
  const pdfSource = trustedPrintEvidence && options.syntheticArtifactIngest
    ? createSyntheticPdfReviewSourceReader(options.syntheticArtifactIngest.artifactRoot,
      options.syntheticArtifactIngest.scope) : undefined;
  const wordSource = trustedPrintEvidence && options.syntheticArtifactIngest
    ? createSyntheticWordReviewSourceReader(options.syntheticArtifactIngest.artifactRoot,
      options.syntheticArtifactIngest.scope) : undefined;
  const pilotPdfSource = options.pilotWordPdf?.pdfSource ?? pdfSource;
  const pilotWordSource = options.pilotWordPdf?.wordSource ?? wordSource;
  const core = trustedPrintEvidence
    ? createCoreModule({ pool: corePool, mode: 'v1', evidence: trustedPrintEvidence,
      ...(pilotPdfSource ? { pdfSource: pilotPdfSource } : {}),
      ...(pilotWordSource ? { wordSource: pilotWordSource } : {}),
      ...(options.pilotWordPdf ? { pilotCodeHmacKey: options.pilotWordPdf.hmacKey } : {}) })
    : createCoreModule({ pool: corePool });
  const pdfReviewPreview = pdfSource && options.pdfReviewArtifactRoot
    ? createPdfReviewPreviewService({ artifactRoot: options.pdfReviewArtifactRoot,
      ...(options.nativePdfReviewPython ? { pythonExecutable: options.nativePdfReviewPython } : {}) }) : undefined;
  const wordReviewPreview = wordSource && options.wordReviewArtifactRoot
    ? createWordReviewPreviewService({ artifactRoot: options.wordReviewArtifactRoot,
      ...(options.nativeWordReviewPython ? { pythonExecutable: options.nativeWordReviewPython } : {}),
      allowWordLaunch: options.allowNativeWordLaunch === true }) : undefined;
  const activeWordPreviewRequests = new Set<string>();
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
  app.addHook('onSend', async (request, reply, payload) => {
    const path = request.url.split('?')[0] ?? '';
    if (path.endsWith('/pdf-review-previews') || path.endsWith('/word-review-previews') ||
        /\/previews\/[^/]+$/.test(path) || /\/word-preview\/pages\/[^/]+$/.test(path))
      reply.header('Cache-Control', 'no-store');
    return payload;
  });
  const register = (method: 'GET' | 'POST' | 'PATCH', path: string,
    handler: Parameters<RouteRegistrar['post']>[1]) => {
    registered.push(`${method} ${path}`);
    app.route({ method, url: path, handler: async (request, reply) => {
      // Refuse any real-mode shop at the send boundary, even if DB was changed externally.
      const pilotAgentRoute = path.startsWith('/internal/v1/pilot/print-jobs');
      const agentRoute = pilotAgentRoute ||
        (path.startsWith('/internal/v1/print-jobs') && !path.endsWith('/reports'));
      const printAgent = agentRoute
        ? await resolve({ headers: { authorization: request.headers.authorization } })
        : undefined;
      if (printAgent) {
        await admitAgentRoute({pool:options.pool,agent:printAgent,pilotRoute:pilotAgentRoute,
          ...(controlled ? {scope:controlled} : {}),
          ...((request.params as {job_id?:string}).job_id ?
            {jobId:(request.params as {job_id:string}).job_id} : {}),
          requestedPrinterId:(request.body as {printer_id?:unknown}|null)?.printer_id});
      }
      if ((method === 'POST' || method === 'PATCH') &&
          (request.body === null || typeof request.body !== 'object' || Array.isArray(request.body)))
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
  core.registerRoutes({ get: (p, h) => register('GET', p, h), post: (p, h) => register('POST', p, h),
    patch: (p, h) => register('PATCH', p, h) }, {
    resolveVerifiedCustomer: resolve,
    resolvePrintAgent: resolve,
    ...(options.pilotWordPdf ? {
      resolvePilotCandidate: options.pilotWordPdf.resolveCandidate,
      resolvePilotCodeSubmission: options.pilotWordPdf.resolveCodeSubmission
    } : {})
  });
  app.get('/health', async () => ({ status: 'ok', mode: controlled ? 'controlled_test' : 'simulation', live_enabled: false,
    auth_configured: true, configured_operations: ['me', 'listOrders', 'approveOrder', 'claimJob', 'markSending', 'reportJob'],
    registered_routes: registered, zalo_webhook_configured: !!options.zaloWebhook || !!options.officialZaloSimulation,
    official_zalo_simulation_configured: !!options.officialZaloSimulation,
    zalo_worker_configured: options.zaloWorkerConfigured === true,
    processor_configured: false, preview_configured: !!options.previewArtifactRoot,
    pdf_review_preview_configured: !!pdfReviewPreview,
    word_review_preview_configured: !!wordReviewPreview,
    word_review_source_configured: !!wordSource,
    synthetic_artifact_ingest_configured: !!options.syntheticArtifactIngest,
    trusted_print_evidence_v1_configured: !!trustedPrintEvidence,
    pilot_word_pdf_simulation_configured: !!options.pilotWordPdf && !controlled,
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
        pdf_review_preview_configured: !!pdfReviewPreview,
        word_review_preview_configured: !!wordReviewPreview,
        word_review_source_configured: !!wordSource,
        synthetic_artifact_ingest_configured: !!options.syntheticArtifactIngest,
        trusted_print_evidence_v1_configured: !!trustedPrintEvidence
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
  app.post('/internal/simulation/inbound-artifacts/:event_id/adopt', async (request, reply) => {
    if (!options.syntheticArtifactIngest) throw new DomainError('FEATURE_UNAVAILABLE', 'Synthetic adoption unavailable', 503);
    const token=request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : '';
    const actor=await core.auth.principal(token);
    const eventId=(request.params as {event_id:string}).event_id;
    const result=await adoptSyntheticSourceHttp(options.pool,core.service,
      options.syntheticArtifactIngest.artifactRoot,options.syntheticArtifactIngest.scope,
      actor,eventId,request.body);
    return reply.header('Cache-Control','no-store').code(200).send(result);
  });
  app.post('/internal/simulation/orders/:order_id/revisions/:revision/first-page-suggestion',
    async (request, reply) => {
      if(!options.syntheticArtifactIngest)
        throw new DomainError('FEATURE_UNAVAILABLE','First-page suggestion unavailable',503);
      const token=request.headers.authorization?.startsWith('Bearer ')
        ? request.headers.authorization.slice(7) : '';
      const actor=await core.auth.principal(token);
      const params=request.params as {order_id:string;revision:string};
      const result=await classifyBoundFirstPage(options.pool,
        options.syntheticArtifactIngest.artifactRoot,options.syntheticArtifactIngest.scope,
        actor,params.order_id,Number(params.revision));
      let questionOutbox:{status:'skipped'|'not_configured'|'blocked'|'queued';outbound_id?:string}=
        {status:'skipped'};
      if(result.metadata.status==='SUGGESTED'){
        if(!options.firstPageQuestionQueue)questionOutbox={status:'not_configured'};
        else{
          try{
            const scope=await resolveBoundFirstPageQuestionScope(options.pool,
              options.syntheticArtifactIngest.scope,actor,params.order_id,Number(params.revision));
            if(!scope)questionOutbox={status:'blocked'};
            else{
              const outbound_id=firstPageQuestionOutboundId({shop_id:scope.shop_id,
                order_id:scope.order_id,revision:scope.revision,
                request_hash:result.request_hash,source_sha256:result.artifact_sha256});
              const queued=await options.firstPageQuestionQueue({outbound_id,scope});
              questionOutbox=queuedQuestionId(queued,outbound_id)
                ?{status:'queued',outbound_id}:{status:'blocked'};
            }
          }catch{
            // Classification remains a stored advisory; queue errors do not
            // alter authority or expose database/source details to the caller.
            questionOutbox={status:'blocked'};
          }
        }
      }
      return reply.header('Cache-Control','no-store')
        .header('X-Content-Type-Options','nosniff')
        .send({...result,suggested_question_outbox:questionOutbox});
    });
  app.get('/internal/simulation/orders/:order_id/revisions/:revision/first-page-question',
    async (request,reply)=>{
      if(!options.syntheticArtifactIngest)
        throw new DomainError('FEATURE_UNAVAILABLE','First-page question unavailable',503);
      const token=request.headers.authorization?.startsWith('Bearer ')
        ? request.headers.authorization.slice(7) : '';
      const actor=await core.auth.principal(token);
      const params=request.params as {order_id:string;revision:string};
      const result=await previewBoundFirstPageQuestion(options.pool,
        options.syntheticArtifactIngest.artifactRoot,options.syntheticArtifactIngest.scope,
        actor,params.order_id,Number(params.revision));
      return reply.header('Cache-Control','no-store')
        .header('X-Content-Type-Options','nosniff').send(result);
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
    const token = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : '';
    const actor = await core.auth.principal(token);
    const params = request.params as { order_id: string; revision: string; index: string };
    const revision = Number(params.revision), index = Number(params.index);
    if (pdfReviewPreview && Number.isSafeInteger(revision) && revision > 0 &&
        Number.isSafeInteger(index) && index >= 0) {
      const cached = await pdfReviewPreview.find(actor.shop_id, params.order_id, revision);
      if (cached) {
        try {
          const current = await core.service.readPdfReviewSource(actor, params.order_id);
          if (current.active_revision !== cached.revision || current.request_hash !== cached.request_hash ||
              current.source.sha256 !== cached.projection.source_sha256 ||
              current.manifest.sha256 !== cached.projection.manifest_sha256)
            throw new DomainError('STALE_PDF_PREVIEW', 'Đơn hoặc file PDF đã đổi; cần tạo preview mới', 409);
          const preview = await pdfReviewPreview.readPage(cached, index);
          const after = await core.service.readPdfReviewSource(actor, params.order_id);
          if (after.active_revision !== cached.revision || after.request_hash !== cached.request_hash ||
              after.source.sha256 !== cached.projection.source_sha256 ||
              after.manifest.sha256 !== cached.projection.manifest_sha256)
            throw new DomainError('STALE_PDF_PREVIEW', 'Đơn hoặc file PDF đã đổi; cần tạo preview mới', 409);
          return reply.header('Content-Type', 'image/png')
            .header('X-Content-Type-Options', 'nosniff')
            .header('Content-Security-Policy', "default-src 'none'")
            .send(preview);
        } catch (error) {
          await pdfReviewPreview.clearOrder(actor.shop_id, params.order_id);
          throw error;
        }
      }
    }
    if (!options.previewArtifactRoot) throw new DomainError('FEATURE_UNAVAILABLE', 'Verified preview unavailable', 503);
    const preview = await loadVerifiedOrderPreview(options.pool, options.previewArtifactRoot,
      actor, params.order_id, revision, index);
    return reply.header('Content-Type', 'image/png')
      .header('Cache-Control', 'no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'")
      .send(preview);
  });
  app.post('/api/v1/orders/:order_id/revisions/:revision/word-review-previews', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'");
    const token = request.headers.authorization?.startsWith('Bearer ')
      ? request.headers.authorization.slice(7) : '';
    const actor = await core.auth.principal(token);
    assertStaff(actor);
    if (!wordReviewPreview) throw new DomainError('FEATURE_UNAVAILABLE',
      'Word review preview chưa được cấu hình ở runtime mô phỏng', 503);
    const params = request.params as { order_id: string; revision: string };
    if (!/^[1-9]\d*$/.test(params.revision) || !Number.isSafeInteger(Number(params.revision)))
      throw new DomainError('INVALID_REVISION', 'Revision không hợp lệ', 422);
    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body) ||
        Object.keys(request.body as object).length !== 0)
      throw new DomainError('INVALID_INPUT', 'Word review chỉ nhận JSON object rỗng', 422);
    const requestKey = `${actor.shop_id}\0${params.order_id}`;
    if (activeWordPreviewRequests.has(requestKey))
      throw new DomainError('WORD_PREVIEW_IN_PROGRESS', 'Preview Word đã được yêu cầu; chờ phản hồi hiện tại', 409, true);
    activeWordPreviewRequests.add(requestKey);
    try {
      await wordReviewPreview.clearOrder(actor.shop_id, params.order_id);
      const snapshot = await core.service.readWordReviewSource(actor, params.order_id);
      if (snapshot.active_revision !== Number(params.revision)) throw staleWordPreview();
      const prepared = await wordReviewPreview.prepare(snapshot);
      try {
        const current = await core.service.readWordReviewSource(actor, params.order_id);
        if (current.active_revision !== snapshot.active_revision || current.request_hash !== snapshot.request_hash ||
            current.source.sha256 !== snapshot.source.sha256 || current.source.artifact_ref !== snapshot.source.artifact_ref ||
            current.manifest.sha256 !== snapshot.manifest.sha256) throw staleWordPreview();
        if (prepared.projection.status === 'REVIEW_REQUIRED') await wordReviewPreview.remember(prepared);
        return reply.code(200).send(prepared.projection);
      } catch (error) {
        await wordReviewPreview.discard(prepared);
        throw error;
      }
    } finally { activeWordPreviewRequests.delete(requestKey); }
  });
  app.get('/api/v1/orders/:order_id/word-preview/pages/:index', async (request, reply) => {
    const token = request.headers.authorization?.startsWith('Bearer ')
      ? request.headers.authorization.slice(7) : '';
    const actor = await core.auth.principal(token);
    assertStaff(actor);
    if (!wordReviewPreview) throw new DomainError('FEATURE_UNAVAILABLE',
      'Word review preview chưa được cấu hình ở runtime mô phỏng', 503);
    const params = request.params as { order_id: string; index: string };
    if (!/^[1-9]\d*$/.test(params.index) || !Number.isSafeInteger(Number(params.index)))
      throw new DomainError('INVALID_PREVIEW_INDEX', 'Trang preview không hợp lệ', 422);
    const current = await core.service.readWordReviewSource(actor, params.order_id);
    const cached = await wordReviewPreview.find(actor.shop_id, params.order_id, current.active_revision);
    if (!cached) throw new DomainError('NOT_FOUND', 'Preview Word hiện hành chưa được tạo', 404);
    try {
      if (cached.revision !== current.active_revision || cached.request_hash !== current.request_hash ||
          cached.source_sha256 !== current.source.sha256 || cached.source_manifest_sha256 !== current.manifest.sha256)
        throw staleWordPreview();
      const bytes = await wordReviewPreview.readPage(cached, Number(params.index));
      const after = await core.service.readWordReviewSource(actor, params.order_id);
      if (after.active_revision !== cached.revision || after.request_hash !== cached.request_hash ||
          after.source.sha256 !== cached.source_sha256 || after.manifest.sha256 !== cached.source_manifest_sha256)
        throw staleWordPreview();
      return reply.header('Content-Type', 'image/png')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Security-Policy', "default-src 'none'")
        .send(bytes);
    } catch (error) {
      await wordReviewPreview.discard(cached);
      throw error;
    }
  });
  app.post('/api/v1/orders/:order_id/revisions/:revision/pdf-review-previews', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'");
    const token = request.headers.authorization?.startsWith('Bearer ')
      ? request.headers.authorization.slice(7) : '';
    const actor = await core.auth.principal(token);
    if (!pdfReviewPreview) throw new DomainError('FEATURE_UNAVAILABLE',
      'PDF review preview chưa được cấu hình ở runtime mô phỏng', 503);
    const params = request.params as { order_id: string; revision: string };
    if (!/^[1-9]\d*$/.test(params.revision) || !Number.isSafeInteger(Number(params.revision)))
      throw new DomainError('INVALID_REVISION', 'Revision không hợp lệ', 422);
    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body) ||
        Object.keys(request.body as object).length !== 0)
      throw new DomainError('INVALID_INPUT', 'PDF review chỉ nhận JSON object rỗng', 422);
    await pdfReviewPreview.clearOrder(actor.shop_id, params.order_id);
    const snapshot = await core.service.readPdfReviewSource(actor, params.order_id);
    if (snapshot.active_revision !== Number(params.revision))
      throw new DomainError('STALE_PDF_PREVIEW', 'Revision không còn hiện hành; cần tải lại đơn', 409);
    const prepared = await pdfReviewPreview.prepare(snapshot);
    try {
      const current = await core.service.readPdfReviewSource(actor, params.order_id);
      if (current.active_revision !== snapshot.active_revision ||
          current.request_hash !== snapshot.request_hash || current.source.sha256 !== snapshot.source.sha256 ||
          current.source.artifact_ref !== snapshot.source.artifact_ref ||
          current.manifest.sha256 !== snapshot.manifest.sha256)
        throw new DomainError('STALE_PDF_PREVIEW', 'Đơn hoặc file PDF đã đổi trong lúc tạo preview', 409);
      await pdfReviewPreview.remember(prepared);
      return reply.code(200).send(prepared.projection);
    } catch (error) {
      await pdfReviewPreview.discard(prepared);
      throw error;
    }
  });
  if (options.syntheticVerifiedButton)
    app.register(createSyntheticVerifiedButtonPlugin(
      options.pool,options.syntheticVerifiedButton,trustedPrintEvidence));
  if (options.officialZaloSimulation)
    app.register(createOfficialZaloSimulationWebhook(options.pool, options.officialZaloSimulation, core.store));
  else if (options.zaloWebhook) app.register(options.zaloWebhook);
  else app.post('/webhooks/zalo', async (_request, reply) => reply.code(503).send({ error: {
    code: 'FEATURE_UNAVAILABLE', message: 'Verified pipeline wiring pending', retryable: false } }));
  return app;
}
