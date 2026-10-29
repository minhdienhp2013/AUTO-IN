import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { createCoreModule } from '../backend/core/factory.js';
import { CORE_MIGRATIONS } from '../backend/storage/migrations.js';
import { asSqlPool, assertIsolatedSimulationDatabase } from '../backend/composition/postgres.js';
import {
  assertNoPostgresEnvironmentOverrides,
  assertStagingDatabaseTarget
} from '../backend/staging/config.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL required');
const mode = process.argv[2];
if (mode === 'migrate-staging') {
  assertStagingDatabaseTarget(url, process.env);
} else {
  assertNoPostgresEnvironmentOverrides(process.env);
  try { assertIsolatedSimulationDatabase(url); }
  catch {
    throw new Error('Explicit isolated numeric-loopback PostgreSQL test database required');
  }
  if (process.env.AUTOIN_ALLOW_PG_ACCEPTANCE !== 'YES_ISOLATED_TEST_DB')
    throw new Error('Explicit isolated localhost test database required');
}
if (!['migrate', 'migrate-staging', 'bootstrap'].includes(mode ?? ''))
  throw new Error('Expected migrate, migrate-staging, or bootstrap');
const pool = new pg.Pool({ connectionString: url });
try {
  if (mode === 'migrate' || mode === 'migrate-staging') {
    const connection = await pool.connect();
    try {
      await connection.query('BEGIN');
      await connection.query('SELECT pg_advisory_xact_lock(630006)');
      for (const file of CORE_MIGRATIONS.filter(file => file !== '005_ai_order_port.sql'))
        await connection.query(await readFile(new URL(`../backend/storage/migrations/${file}`, import.meta.url), 'utf8'));
      for (const file of ['001_zalo_durable.sql', '002_zalo_oa_scope.sql', '003_confirmation_candidates.sql', '004_official_quarantine.sql', '005_official_event_idempotency.sql'])
        await connection.query(await readFile(new URL(`../backend/integrations/zalo/migrations/${file}`, import.meta.url), 'utf8'));
      // AI1's draft Port verifies events in AI2's durable inbound table.
      // CODE-401 challenge migration (006) is in CORE_MIGRATIONS; CODE-402
      // candidate table (AI2 003) is pending review only, never confirmation.
      await connection.query(await readFile(new URL('../backend/storage/migrations/005_ai_order_port.sql', import.meta.url), 'utf8'));
      await connection.query(await readFile(new URL('../backend/composition/migrations/001_document_artifacts.sql', import.meta.url), 'utf8'));
      await connection.query(await readFile(new URL('../backend/composition/migrations/002_plan_previews.sql', import.meta.url), 'utf8'));
      await connection.query(await readFile(new URL('../backend/composition/migrations/003_inbound_drafts.sql', import.meta.url), 'utf8'));
      await connection.query(await readFile(new URL('../backend/composition/migrations/004_pending_approval_gate.sql', import.meta.url), 'utf8'));
      await connection.query(await readFile(new URL('../backend/composition/migrations/005_official_zalo_shop_registry.sql', import.meta.url), 'utf8'));
      await connection.query(await readFile(new URL('../backend/composition/migrations/006_source_adoption_receipts.sql', import.meta.url), 'utf8'));
      await connection.query(await readFile(new URL('../backend/composition/migrations/007_first_page_suggestions.sql', import.meta.url), 'utf8'));
      await connection.query(await readFile(new URL('../backend/composition/migrations/008_pilot_private_sources.sql', import.meta.url), 'utf8'));
      await connection.query('COMMIT');
    } catch (error) { await connection.query('ROLLBACK'); throw error; }
    finally { connection.release(); }
    console.info('Test database migrations applied');
  } else if (process.argv[2] === 'bootstrap') {
    const { AUTOIN_SHOP_ID: shop, AUTOIN_OWNER_USERNAME: username, AUTOIN_OWNER_PASSWORD: password } = process.env;
    if (!shop || !username || !password) throw new Error('Explicit owner credentials required');
    await createCoreModule({ pool: asSqlPool(pool) }).auth.bootstrapOwner({ shop_id: shop, username, password, bootstrap_enabled: true });
    console.info('Test owner created');
  } else throw new Error('Expected migrate or bootstrap');
} finally { await pool.end(); }
