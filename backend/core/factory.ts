import { AuthService } from './auth.js';
import { OrderService, type PilotClaimScope } from './service.js';
import { ShopScheduleService } from './shop-schedule.js';
import { createInboundReviewReader } from './inbound-review-items.js';
import { DomainError, type Principal } from './model.js';
import { PgStore, type SqlPool } from '../storage/database.js';
import { registerCoreRoutes, type RouteRegistrar, type CoreRouteDependencies } from '../api/routes.js';
import type { TrustedPrintEvidencePort } from './print-evidence.js';
import type { TrustedWordReviewSourceReader } from './word-review-source.js';
import type { TrustedPdfReviewSourceReader } from './pdf-review-source.js';

/**
 * AI1 composition port, for AI0 to wire into ONE Fastify application.
 * The caller owns the pg.Pool lifecycle, DB connection settings, TLS, secrets,
 * and migration runner. Neither a test principal nor a live print adapter is
 * created here. Do not register alongside AI0's duplicate scaffold routes.
 */
export interface CoreModule {
  store: PgStore;
  auth: AuthService;
  service: OrderService;
  schedule: ShopScheduleService;
  inboundReviewReader: ReturnType<typeof createInboundReviewReader>;
  registerRoutes: (app: RouteRegistrar, identities: VerifiedIdentityPorts,
    pilotClaimScope?:PilotClaimScope) => void;
}

/** These resolvers are server-owned and never read role/actor/shop from body or bare headers. */
export interface VerifiedIdentityPorts {
  resolveVerifiedCustomer: CoreRouteDependencies['resolveVerifiedCustomer'];
  resolvePrintAgent: CoreRouteDependencies['resolvePrintAgent'];
  resolvePilotCandidate?:CoreRouteDependencies['resolvePilotCandidate'];
  resolvePilotCodeSubmission?:CoreRouteDependencies['resolvePilotCodeSubmission'];
}

/**
 * Legacy mode is kept for isolated legacy tests and existing non-V1 tools.
 * Product V1 callers must opt in explicitly and provide the server-owned
 * verifier; an incomplete V1 configuration is rejected at construction.
 */
export type CoreModuleOptions =
  | {pool: SqlPool; now?: () => Date; mode?: 'legacy'; evidence?: never; wordSource?: never; pdfSource?: never;pilotCodeHmacKey?:never}
  | {pool: SqlPool; now?: () => Date; mode: 'v1'; evidence: TrustedPrintEvidencePort;
      wordSource?: TrustedWordReviewSourceReader;pdfSource?:TrustedPdfReviewSourceReader;pilotCodeHmacKey?:Uint8Array};

function validCustomer(p: Principal | null | undefined): p is Principal {
  return !!p?.verified && p.role === 'customer' &&
    typeof p.shop_id === 'string' && p.shop_id.length > 0 &&
    typeof p.customer_id === 'string' && p.customer_id.length > 0;
}
function validAgent(p: Principal | null | undefined): p is Principal {
  return !!p?.verified && p.role === 'print_agent' &&
    typeof p.id === 'string' && p.id.length > 0 &&
    typeof p.shop_id === 'string' && p.shop_id.length > 0 &&
    Array.isArray(p.printer_ids) && p.printer_ids.length > 0 &&
    p.printer_ids.every(id => typeof id === 'string' && id.length > 0);
}
export function createCoreModule(options: CoreModuleOptions): CoreModule {
  if (!options?.pool || typeof options.pool.connect !== 'function' || typeof options.pool.query !== 'function')
    throw new DomainError('POSTGRES_REQUIRED', 'Cần kết nối PostgreSQL đã cấu hình', 503);
  if (options.mode === 'v1' &&
      (!options.evidence || typeof options.evidence.read_verified !== 'function'))
    throw new DomainError('PRINT_EVIDENCE_NOT_CONFIGURED', 'V1 cần verifier byte nguồn do máy chủ quản lý', 503);
  if (options.mode !== 'v1' && options.evidence !== undefined)
    throw new DomainError('V1_MODE_REQUIRED', 'Không được bỏ qua verifier bằng chứng in đã cấu hình', 503);
  const store = new PgStore(options.pool);
  const auth = new AuthService(store);
  const service = new OrderService(store, options.now ?? (() => new Date()),
    options.mode === 'v1' ? options.evidence : undefined,
    options.mode === 'v1' ? options.wordSource : undefined,
    options.mode === 'v1' ? options.pdfSource : undefined,
    options.mode === 'v1' ? options.pilotCodeHmacKey : undefined);
  const schedule = new ShopScheduleService(store);
  const inboundReviewReader = createInboundReviewReader({store});
  return {
    store, auth, service, schedule, inboundReviewReader,
    registerRoutes(app, identities, pilotClaimScope) {
      if (typeof identities?.resolveVerifiedCustomer !== 'function' ||
          typeof identities?.resolvePrintAgent !== 'function')
        throw new DomainError('VERIFIED_IDENTITY_PORTS_REQUIRED','Thiếu adapter xác thực kênh khách/agent',503);
      // The staff resolver uses bearer sessions in AuthService; never fabricate roles.
      registerCoreRoutes(app, {
        auth, service, schedule, inboundReviewReader,
        async resolveVerifiedCustomer(request) {
          const principal = await identities.resolveVerifiedCustomer(request);
          if (!validCustomer(principal))
            throw new DomainError('CUSTOMER_VERIFICATION_REQUIRED','Chưa xác minh danh tính khách',403);
          return principal;
        },
        async resolvePrintAgent(request) {
          const principal = await identities.resolvePrintAgent(request);
          if (!validAgent(principal))
            throw new DomainError('AGENT_VERIFICATION_REQUIRED','Thiếu scope máy in đã xác minh',403);
          return principal;
        },
        ...(pilotClaimScope?{pilotClaimScope}:{}),
        ...(typeof identities.resolvePilotCandidate==='function'?{resolvePilotCandidate:identities.resolvePilotCandidate}:{}),
        ...(typeof identities.resolvePilotCodeSubmission==='function'?{resolvePilotCodeSubmission:identities.resolvePilotCodeSubmission}:{})
      });
    }
  };
}
