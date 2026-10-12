import type pg from 'pg';
import { createZaloComposition } from '../integrations/zalo/wiring.js';
import { SyntheticFixtureNormalizer, SyntheticTestVerifier } from '../integrations/zalo/protocol.js';
import { createAiOrderPort } from '../core/ai-order-port.js';
import { createOrderSupplementPort } from '../core/order-supplement-port.js';
import type { PgStore } from '../storage/database.js';
import type { OrderDraftPort, DocumentFactsPort } from '../conversation/processor.js';
import { createTrustedDocumentFactsPort } from './document-facts.js';
import { createZaloRawWebhook } from './zalo-http.js';
import {guardedSyntheticConversationOrders} from './conversation-order-guard.js';

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
  const supplements = createOrderSupplementPort({store: options.store,
    trusted: {shop_id: registry.shop_id, oa_id: registry.oa_id},
    // This identity exists only in the isolated synthetic transport. It is
    // never a customer credential and cannot authorize approval or printing.
    processor: {id: 'synthetic:zalo:'+registry.oa_id, role: 'processor',
      shop_id: registry.shop_id, verified: true}});
  const documents = createTrustedDocumentFactsPort(pool,
    { shop_id: registry.shop_id, oa_id: registry.oa_id },
    { ...(options.artifactRoot ? { artifactRoot: options.artifactRoot } : {}),
      ...(options.python ? { python: options.python } : {}) });
  // AI2 intentionally preserves an empty customer text for image/file-only
  // requests. AI1's trusted suggest_draft contract requires nonempty text.
  // Supply an EXPLICIT SYSTEM provenance marker, never invented customer words.
  // AI1 still verifies each event binding and generation under a PG row lock.
  const attachmentOnlyText='[AUTO-IN SYSTEM: ATTACHMENT_ONLY; NO_CUSTOMER_TEXT]';
  const safeOrders: OrderDraftPort = {
    suggest_draft: request => orders.suggest_draft({
      ...request,
      text: request.text.trim() ? request.text : attachmentOnlyText
    }),
    async apply_incoming_batch(request) {
      if (request.scope.oa_id !== registry.oa_id) return {status:'needs_human'};
      const result = await supplements.apply_incoming_batch({
        conversation_id: request.scope.conversation_id,
        customer_id: request.scope.customer_id,
        event_ids: request.event_ids,
        text: request.text.trim() ? request.text : attachmentOnlyText,
        idempotency_key: request.idempotency_key,
        expected_generation: request.expected_generation,
        intent: request.intent,
        // AI2 has completed AI3 document inspection before invoking this Port.
        // AI1 independently verifies durable ingress and artifact binding.
        materialized: true
      });
      if (result.status === 'created' || result.status === 'existing')
        return {status: result.status, order_id: result.order_id,
          active_revision: result.revision};
      if (result.status === 'appended')
        return {status:'appended',order_id:result.order_id,
          active_revision:result.revision,requires_reconfirmation:true};
      if (result.status === 'stale_generation' || result.status === 'closed' ||
          result.status === 'ambiguous') return {status:result.status};
      return {status:'needs_human'};
    },
    route_human: request => orders.route_human(request)
  };
  const guardedOrders = guardedSyntheticConversationOrders(pool,
    {shop_id:registry.shop_id,oa_id:registry.oa_id},safeOrders);
  const pipeline = compose(pool, registry,guardedOrders,documents);
  return { trustedScope: { shop_id: registry.shop_id, oa_id: registry.oa_id },
    webhook: createZaloRawWebhook(pipeline), tick_inbound: pipeline.tick_inbound,
    tick_outbound: pipeline.tick_outbound };
}
