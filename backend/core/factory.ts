import { AuthService } from './auth.js';
import { OrderService } from './service.js';
import { DomainError, type Principal } from './model.js';
import { PgStore, type SqlPool } from '../storage/database.js';
import { registerCoreRoutes, type RouteRegistrar, type CoreRouteDependencies } from '../api/routes.js';

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
  registerRoutes: (app: RouteRegistrar, identities: VerifiedIdentityPorts) => void;
}

/** These resolvers are server-owned and never read role/actor/shop from body or bare headers. */
export interface VerifiedIdentityPorts {
  resolveVerifiedCustomer: CoreRouteDependencies['resolveVerifiedCustomer'];
  resolvePrintAgent: CoreRouteDependencies['resolvePrintAgent'];
}

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
export function createCoreModule(options: {pool: SqlPool; now?: () => Date}): CoreModule {
  if (!options?.pool || typeof options.pool.connect !== 'function' || typeof options.pool.query !== 'function')
    throw new DomainError('POSTGRES_REQUIRED', 'Cần kết nối PostgreSQL đã cấu hình', 503);
  const store = new PgStore(options.pool);
  const auth = new AuthService(store);
  const service = new OrderService(store, options.now ?? (() => new Date()));
  return {
    store, auth, service,
    registerRoutes(app, identities) {
      if (typeof identities?.resolveVerifiedCustomer !== 'function' ||
          typeof identities?.resolvePrintAgent !== 'function')
        throw new DomainError('VERIFIED_IDENTITY_PORTS_REQUIRED','Thiếu adapter xác thực kênh khách/agent',503);
      // The staff resolver uses bearer sessions in AuthService; never fabricate roles.
      registerCoreRoutes(app, {
        auth, service,
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
        }
      });
    }
  };
}
