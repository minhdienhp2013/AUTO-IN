import pg from 'pg';
import { createHash } from 'node:crypto';
import { createCoreModule } from '../backend/core/factory.js';
import { asSqlPool, assertIsolatedSimulationDatabase } from '../backend/composition/postgres.js';
import { inspectDocumentRequest } from '../backend/composition/processor.js';
import { verifyBoundSourceForPlan } from '../backend/composition/source-binding.js';

const [shopId, orderId] = process.argv.slice(2);
if (!shopId || !/^[a-f0-9-]{36}$/i.test(orderId ?? '') || !process.env.DATABASE_URL ||
    !process.env.AUTOIN_INPUT_ROOT || !process.env.AUTOIN_ARTIFACT_ROOT ||
    !process.env.AUTOIN_PROCESSOR_ID)
  throw new Error('Expected shop ID, UUID order, test DB and processor configuration');
assertIsolatedSimulationDatabase(process.env.DATABASE_URL);
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
  const snapshotFiles=(row.request_data as {documents?:{artifact_name?:unknown}[]}|null)?.documents;
  if (Array.isArray(snapshotFiles) && snapshotFiles.some(file =>
    typeof file?.artifact_name==='string' && file.artifact_name.startsWith('doc-'))) {
    await verifyBoundSourceForPlan(asSqlPool(pool),
      {shop_id:verifiedShopId,order_id:verifiedOrderId},row.request_data,
      process.env.AUTOIN_INPUT_ROOT,process.env.AUTOIN_ARTIFACT_ROOT,
      plan.artifact_ref,evidenceHash);
  }
  const module = createCoreModule({ pool: asSqlPool(pool) });
  const processorId = process.env.AUTOIN_PROCESSOR_ID!;
  const stableKey = createHash('sha256').update(`${verifiedOrderId}:${row.active_revision}:${evidenceHash}`).digest('hex');
  const next = await module.service.publishVerifiedPlan({ id: processorId,
    shop_id: verifiedShopId, role: 'processor', verified: true }, verifiedOrderId, {
      expected_revision: row.active_revision, plan, idempotency_key: `processor:${stableKey}` });
  // Persist the independent manifest hash for staff preview access. Never expose
  // an unanchored or stale renderer output, even on an idempotent rerun.
  await pool.query(
    'INSERT INTO ai0_verified_plan_manifests ' +
    '(shop_id,order_id,revision,request_hash,artifact_ref,manifest_sha256) ' +
    'SELECT $1,r.order_id,r.revision,r.request_hash,$4,$5 ' +
    'FROM core_revisions r JOIN core_orders o ON o.id=r.order_id ' +
    'WHERE o.shop_id=$1 AND o.id=$2 AND r.revision=$3 ' +
    'AND r.plan->>\'artifact_ref\'=$4 AND r.request_hash=$6 ' +
    'ON CONFLICT (shop_id,order_id,revision) DO NOTHING',
    [verifiedShopId,verifiedOrderId,next.revision,plan.artifact_ref,evidenceHash,row.request_hash]);
  const anchored=await pool.query<{artifact_ref:string;manifest_sha256:string}>(
    'SELECT artifact_ref,manifest_sha256 FROM ai0_verified_plan_manifests ' +
    'WHERE shop_id=$1 AND order_id=$2 AND revision=$3',
    [verifiedShopId,verifiedOrderId,next.revision]);
  if (anchored.rows[0]?.artifact_ref !== plan.artifact_ref ||
      anchored.rows[0]?.manifest_sha256 !== evidenceHash)
    throw new Error('Verified preview evidence not bound to active order revision');
  console.info(JSON.stringify({ order_id: verifiedOrderId, revision: next.revision,
    requires_reconfirmation: true, evidence_sha256: evidenceHash }));
} finally { await pool.end(); }
