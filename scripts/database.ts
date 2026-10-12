import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { createCoreModule } from '../backend/core/factory.js';
import { CORE_MIGRATIONS } from '../backend/storage/migrations.js';
import { asSqlPool } from '../backend/composition/postgres.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL required');
const parsed = new URL(url);
if (!['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) || parsed.search || parsed.hash ||
    !/^\/(?:auto_in_test|autoin_test)[a-zA-Z0-9_-]*$/.test(parsed.pathname) ||
    process.env.AUTOIN_ALLOW_PG_ACCEPTANCE !== 'YES_ISOLATED_TEST_DB')
  throw new Error('Explicit isolated localhost test database required');
const pool = new pg.Pool({ connectionString: url });
try {
  if (process.argv[2] === 'migrate') {
    const connection = await pool.connect();
    try {
      await connection.query('BEGIN');
      await connection.query('SELECT pg_advisory_xact_lock(630006)');
      for (const file of CORE_MIGRATIONS.filter(file => file !== '005_ai_order_port.sql'))
        await connection.query(await readFile(new URL(`../backend/storage/migrations/${file}`, import.meta.url), 'utf8'));
      for (const file of ['001_zalo_durable.sql', '002_zalo_oa_scope.sql'])
        await connection.query(await readFile(new URL(`../backend/integrations/zalo/migrations/${file}`, import.meta.url), 'utf8'));
      // AI1's draft Port verifies events in AI2's durable inbound table.
      await connection.query(await readFile(new URL('../backend/storage/migrations/005_ai_order_port.sql', import.meta.url), 'utf8'));
      await connection.query(await readFile(new URL('../backend/composition/migrations/001_document_artifacts.sql', import.meta.url), 'utf8'));
      await connection.query(await readFile(new URL('../backend/composition/migrations/002_plan_previews.sql', import.meta.url), 'utf8'));
      await connection.query(await readFile(new URL('../backend/composition/migrations/003_inbound_drafts.sql', import.meta.url), 'utf8'));
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
