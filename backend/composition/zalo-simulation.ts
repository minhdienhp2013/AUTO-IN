import type pg from 'pg';
import { createZaloComposition } from '../integrations/zalo/wiring.js';
import { SyntheticFixtureNormalizer, SyntheticTestVerifier } from '../integrations/zalo/protocol.js';
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

/** Inbound-only until AI1 supplies a trusted draft Port and AI3 supplies document inspection. */
export function createSyntheticZaloIngress(pool: pg.Pool, input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Invalid synthetic Zalo registry');
  const registry = input as Partial<SyntheticZaloRegistry>;
  if (registry.kind !== 'synthetic_fixture' ||
      !required(registry.shop_id, 128) || !required(registry.oa_id, 128) ||
      !required(registry.fixture_key, 256) || registry.fixture_key.length < 32)
    throw new Error('Invalid synthetic Zalo registry');

  const pipeline = createZaloComposition({
    pool,
    trusted_shop_id: registry.shop_id,
    trusted_oa_id: registry.oa_id,
    mode: 'simulation',
    orders: {
      async suggest_draft() { throw new Error('AI1_DRAFT_PORT_NOT_CONFIGURED'); },
      async route_human() { throw new Error('AI1_HANDOVER_PORT_NOT_CONFIGURED'); }
    },
    documents: { async inspect() { throw new Error('AI3_DOCUMENT_PORT_NOT_CONFIGURED'); } },
    schedule: { allowed() { return false; } },
    clock: { now: () => new Date() },
    synthetic_provider: {
      kind: 'synthetic_fixture',
      verifier: new SyntheticTestVerifier(registry.fixture_key),
      normalizer: new SyntheticFixtureNormalizer()
    }
  });
  return createZaloRawWebhook(pipeline);
}
