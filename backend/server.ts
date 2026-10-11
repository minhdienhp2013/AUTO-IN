import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { buildIntegratedApp, type ServiceIdentity } from './composition/runtime.js';
import { asSqlPool, assertIsolatedSimulationDatabase } from './composition/postgres.js';
import { createSyntheticZaloIngress } from './composition/zalo-simulation.js';
if ((process.env.AUTO_IN_MODE ?? 'simulation') !== 'simulation') throw new Error('Only simulation is available');
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL required; run db:migrate and db:bootstrap first');
assertIsolatedSimulationDatabase(url);
const port = Number(process.env.PORT ?? '3000');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
const host = process.env.HOST ?? '127.0.0.1';
if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('Simulation server is localhost only');
const identities: ServiceIdentity[] = process.env.AUTOIN_IDENTITIES_FILE
  ? JSON.parse(await readFile(process.env.AUTOIN_IDENTITIES_FILE, 'utf8')) as ServiceIdentity[] : [];
if (!Array.isArray(identities)) throw new Error('Expected service identity array');
const keyFile = process.env.AUTOIN_TLS_KEY;
const certFile = process.env.AUTOIN_TLS_CERT;
if (!!keyFile !== !!certFile) throw new Error('TLS key and certificate required together');
const tls = keyFile && certFile ? { key: await readFile(keyFile), cert: await readFile(certFile) } : undefined;
const registry = process.env.AUTOIN_ZALO_SYNTHETIC_REGISTRY
  ? JSON.parse(await readFile(process.env.AUTOIN_ZALO_SYNTHETIC_REGISTRY, 'utf8')) as unknown : undefined;
const pool = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 5000 });
const zaloWebhook = registry === undefined ? undefined : createSyntheticZaloIngress(pool, registry);
const app = buildIntegratedApp({ pool: asSqlPool(pool), identities,
  ...(tls ? { tls } : {}), ...(zaloWebhook ? { zaloWebhook } : {}) });
app.addHook('onClose', async () => { await pool.end(); });
try {
  await pool.query('SELECT 1 FROM core_shop_settings LIMIT 1');
  await app.listen({ host, port });
  console.info('AUTO-IN core HTTP ready in simulation mode');
} catch {
  await app.close();
  console.error('AUTO-IN startup failed: verify test database, migrations and listener configuration');
  process.exitCode = 1;
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close(); });
