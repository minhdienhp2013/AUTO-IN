import pg from 'pg';
import { createHash } from 'node:crypto';
import { createCoreModule } from '../backend/core/factory.js';
import { asSqlPool } from '../backend/composition/postgres.js';
import { inspectDocumentRequest } from '../backend/composition/processor.js';

const [shopId, orderId] = process.argv.slice(2);
if (!shopId || !/^[a-f0-9-]{36}$/i.test(orderId ?? '') || !process.env.DATABASE_URL ||
    !process.env.AUTOIN_INPUT_ROOT || !process.env.AUTOIN_ARTIFACT_ROOT ||
    !process.env.AUTOIN_PROCESSOR_ID)
  throw new Error('Expected shop ID, UUID order, test DB and processor configuration');
const verifiedShopId = shopId!;
const verifiedOrderId = orderId!;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  const result = await pool.query<{ active_revision: number; request_data: unknown; request_hash: string }>(`
    SELECT o.active_revision, r.request_data, r.request_hash FROM core_orders o
    JOIN core_revisions r ON r.order_id=o.id AND r.revision=o.active_revision
    JOIN core_shop_settings s ON s.shop_id=o.shop_id
    WHERE o.id=$1 AND o.shop_id=$2 AND s.mode='simulation' AND NOT o.manual_lock AND NOT o.print_closed`,
    [verifiedOrderId, verifiedShopId]);
  const row = result.rows[0];
  if (!row) throw new Error('Simulation order not available');
  const { plan, evidenceHash } = await inspectDocumentRequest(row.request_data,
    row.request_hash, { inputRoot: process.env.AUTOIN_INPUT_ROOT,
      artifactRoot: process.env.AUTOIN_ARTIFACT_ROOT,
      ...(process.env.AUTOIN_PYTHON ? { python: process.env.AUTOIN_PYTHON } : {}) });
  const module = createCoreModule({ pool: asSqlPool(pool) });
  const processorId = process.env.AUTOIN_PROCESSOR_ID!;
  const stableKey = createHash('sha256').update(`${verifiedOrderId}:${row.active_revision}:${evidenceHash}`).digest('hex');
  const next = await module.service.publishVerifiedPlan({ id: processorId,
    shop_id: verifiedShopId, role: 'processor', verified: true }, verifiedOrderId, {
      expected_revision: row.active_revision, plan, idempotency_key: `processor:${stableKey}` });
  console.info(JSON.stringify({ order_id: verifiedOrderId, revision: next.revision,
    requires_reconfirmation: true, evidence_sha256: evidenceHash }));
} finally { await pool.end(); }
