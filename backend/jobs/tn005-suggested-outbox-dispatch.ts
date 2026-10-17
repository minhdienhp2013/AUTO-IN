import type { createTn005SealedOutbox, FakeOrApprovedSender } from '../core/tn005-sealed-outbox.js';
import type { SqlPool } from '../storage/database.js';

/** A single tick can inspect/send at most this many advisory rows. */
export const TN005_DISPATCH_BATCH_MAX = 10;

/** Deliberately synthetic-only: this task does not authorize a live provider sender. */
export type SyntheticTn005Sender = FakeOrApprovedSender & { readonly kind: 'synthetic_test' };

type CoreDispatchPort = Pick<ReturnType<typeof createTn005SealedOutbox>, 'reserve' | 'deliverReserved'>;
type PendingRow = { outbound_id: string };

export interface Tn005DispatchTickResult {
  selected: number;
  sent: number;
  blocked: number;
  unknown: number;
}

/**
 * Explicitly invoked, synthetic-only tick for isolated acceptance tests.
 * It is not registered as a production worker or HTTP route. Candidate discovery
 * reads IDs only; Core.reserve and Core.deliverReserved perform every evidence,
 * revision, generation, and sealed-source check at their transaction boundaries.
 */
export function createSyntheticTn005SuggestedOutboxTick(options: {
  readonly pool: Pick<SqlPool, 'query'>;
  readonly trusted: Readonly<{ shop_id: string; oa_id: string }>;
  readonly core: CoreDispatchPort;
  readonly sender: SyntheticTn005Sender;
}) {
  const { pool, trusted, core, sender } = options ?? {};
  if (!pool || typeof pool.query !== 'function' ||
      !trusted || typeof trusted.shop_id !== 'string' || trusted.shop_id.length < 1 || trusted.shop_id.length > 128 ||
      typeof trusted.oa_id !== 'string' || trusted.oa_id.length < 1 || trusted.oa_id.length > 256 ||
      !core || typeof core.reserve !== 'function' || typeof core.deliverReserved !== 'function' ||
      !sender || sender.kind !== 'synthetic_test' || typeof sender.send_text !== 'function') {
    throw new TypeError('TN005 synthetic tick requires trusted scope, Core CAS, and a synthetic test sender');
  }

  async function tick(): Promise<Tn005DispatchTickResult> {
    const result = await pool.query<PendingRow>(
      'SELECT outbound_id::text AS outbound_id FROM core_tn005_suggested_outbox ' +
      "WHERE shop_id=$1 AND oa_id=$2 AND status='QUEUED' " +
      'ORDER BY created_at,outbound_id LIMIT $3',
      [trusted.shop_id, trusted.oa_id, TN005_DISPATCH_BATCH_MAX]
    );
    // LIMIT is enforced by PostgreSQL; slice again so an unexpected/mocked reader
    // cannot make one tick exceed the hard in-process batch bound.
    const candidates = result.rows.slice(0, TN005_DISPATCH_BATCH_MAX);
    const summary: Tn005DispatchTickResult = { selected: candidates.length, sent: 0, blocked: 0, unknown: 0 };

    // Serial dispatch bounds simultaneous synthetic calls to one and preserves
    // the Core lock/lease ordering. There is no implicit retry or polling loop.
    for (const candidate of candidates) {
      const lease = await core.reserve(candidate.outbound_id);
      if (!lease) {
        summary.blocked += 1;
        continue;
      }
      const outcome = await core.deliverReserved(lease, sender);
      if (outcome === 'sent') summary.sent += 1;
      else if (outcome === 'unknown') summary.unknown += 1;
      else summary.blocked += 1;
    }
    return summary;
  }

  return Object.freeze({ tick });
}
