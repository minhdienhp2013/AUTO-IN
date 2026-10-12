import type pg from 'pg';
import { createZaloComposition } from '../integrations/zalo/wiring.js';
import { SyntheticFixtureNormalizer, SyntheticTestVerifier } from '../integrations/zalo/protocol.js';
import { createAiOrderPort } from '../core/ai-order-port.js';
import type { PgStore } from '../storage/database.js';
import type { OrderDraftPort, DocumentFactsPort } from '../conversation/processor.js';
import { createTrustedDocumentFactsPort } from './document-facts.js';
import { createZaloRawWebhook } from './zalo-http.js';

/** Local test registry. Never populate these values from webhook bytes or headers. */
export interface SyntheticZaloRegistry {
  kind: 'synthetic_fixture';
  shop_id: string;
  oa_id: string;
  fixture_key: string;
}

function required(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function parseRegistry(input: unknown): SyntheticZaloRegistry {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Invalid synthetic Zalo registry');
  const registry = input as Partial<SyntheticZaloRegistry>;
  if (registry.kind !== 'synthetic_fixture' ||
      !required(registry.shop_id, 128) || !required(registry.oa_id, 128) ||
      !required(registry.fixture_key, 256) || registry.fixture_key.length < 32)
    throw new Error('Invalid synthetic Zalo registry');
  return registry as SyntheticZaloRegistry;
}

function compose(pool: pg.Pool, registry: SyntheticZaloRegistry,
  orders: OrderDraftPort, documents: DocumentFactsPort) {
  const pipeline = createZaloComposition({
    pool,
    trusted_shop_id: registry.shop_id,
    trusted_oa_id: registry.oa_id,
    mode: 'simulation',
    orders, documents,
    schedule: { allowed() { return false; } },
    clock: { now: () => new Date() },
    synthetic_provider: {
      kind: 'synthetic_fixture',
      verifier: new SyntheticTestVerifier(registry.fixture_key),
      normalizer: new SyntheticFixtureNormalizer()
    }
  });
  return pipeline;
}

/** Kept for ingress-only fixtures that intentionally do not schedule a worker. */
export function createSyntheticZaloIngress(pool: pg.Pool, input: unknown) {
  const registry = parseRegistry(input);
  const pipeline = compose(pool, registry, {
    async suggest_draft() { throw new Error('AI1_DRAFT_PORT_NOT_CONFIGURED'); },
    async route_human() { throw new Error('AI1_HANDOVER_PORT_NOT_CONFIGURED'); }
  }, { async inspect() { throw new Error('AI3_DOCUMENT_PORT_NOT_CONFIGURED'); } });
  return createZaloRawWebhook(pipeline);
}

/** The only scheduled composition: server-owned scope, real AI1/AI3 Ports, synthetic transport. */
export function createSyntheticZaloRuntime(pool: pg.Pool, input: unknown, options: {
  store: PgStore; artifactRoot?: string; python?: string
}) {
  const registry = parseRegistry(input);
  const orders = createAiOrderPort({ store: options.store,
    trusted: { shop_id: registry.shop_id, oa_id: registry.oa_id } });
  const documents = createTrustedDocumentFactsPort(pool,
    { shop_id: registry.shop_id, oa_id: registry.oa_id },
    { ...(options.artifactRoot ? { artifactRoot: options.artifactRoot } : {}),
      ...(options.python ? { python: options.python } : {}) });
  const pipeline = compose(pool, registry, orders, documents);
  return { trustedScope: { shop_id: registry.shop_id, oa_id: registry.oa_id },
    webhook: createZaloRawWebhook(pipeline), tick_inbound: pipeline.tick_inbound,
    tick_outbound: pipeline.tick_outbound };
}
