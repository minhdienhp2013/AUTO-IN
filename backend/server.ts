import pg from 'pg';
import type { FastifyPluginAsync } from 'fastify';
import { readFile } from 'node:fs/promises';
import { buildIntegratedApp, type ServiceIdentity } from './composition/runtime.js';
import { asSqlPool, assertIsolatedSimulationDatabase } from './composition/postgres.js';
import { createCoreModule } from './core/factory.js';
import { createSyntheticZaloRuntime } from './composition/zalo-simulation.js';
import { createOfficialZaloWebhookPlugin } from './composition/official-zalo-webhook.js';
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
const core = createCoreModule({ pool: asSqlPool(pool) });
const zaloRuntime = registry === undefined ? undefined : createSyntheticZaloRuntime(pool, registry, {
  store: core.store,
  ...(process.env.AUTOIN_DOCUMENT_ARTIFACT_ROOT
    ? { artifactRoot: process.env.AUTOIN_DOCUMENT_ARTIFACT_ROOT } : {})
});
const officialConfigFile = process.env.AUTOIN_ZALO_OFFICIAL_SIMULATION_CONFIG_FILE;
const syntheticOfficialEnabled = process.env.AUTOIN_ENABLE_SYNTHETIC_ZALO_WEBHOOK === 'YES_TEST_ONLY';
let officialZaloWebhook: FastifyPluginAsync | undefined;
if (syntheticOfficialEnabled) {
  if (!officialConfigFile || zaloRuntime)
    throw new Error('Synthetic official webhook requires a private config file and no other Zalo runtime');
  const raw = JSON.parse(await readFile(officialConfigFile, 'utf8')) as Record<string, unknown>;
  if (typeof raw.app_id !== 'string' || typeof raw.oa_id !== 'string' ||
      typeof raw.oa_secret_key !== 'string' || !raw.oa_secret_key.startsWith('synthetic-only-'))
    throw new Error('Only synthetic-only Zalo credentials are allowed in this localhost runtime');
  officialZaloWebhook = await createOfficialZaloWebhookPlugin(asSqlPool(pool), {
    app_id: raw.app_id, oa_id: raw.oa_id, oa_secret_key: raw.oa_secret_key
  });
} else if (officialConfigFile) {
  throw new Error('Set AUTOIN_ENABLE_SYNTHETIC_ZALO_WEBHOOK=YES_TEST_ONLY for the local synthetic route');
}
const configuredTick = process.env.AUTOIN_ZALO_SYNTHETIC_TICK_MS;
const tickMs = configuredTick === undefined ? 0 : Number(configuredTick);
if (configuredTick !== undefined && (!zaloRuntime || !Number.isInteger(tickMs) || tickMs < 1000 || tickMs > 60000))
  throw new Error('Synthetic inbound worker requires a registry and interval 1000..60000');
let ticking = false;
let timer: ReturnType<typeof setInterval> | undefined;
const app = buildIntegratedApp({ pool: asSqlPool(pool), identities,
  ...(tls ? { tls } : {}), ...(officialZaloWebhook ? { zaloWebhook: officialZaloWebhook } :
    zaloRuntime ? { zaloWebhook: zaloRuntime.webhook } : {}),
  zaloWorkerConfigured: tickMs > 0,
  ...(process.env.AUTOIN_ARTIFACT_ROOT ? {previewArtifactRoot: process.env.AUTOIN_ARTIFACT_ROOT} : {}),
  ...(zaloRuntime && process.env.AUTOIN_DOCUMENT_ARTIFACT_ROOT ? {
    syntheticArtifactIngest: {
      artifactRoot: process.env.AUTOIN_DOCUMENT_ARTIFACT_ROOT,
      scope: zaloRuntime.trustedScope
    }
  } : {}) });
app.addHook('onClose', async () => { if (timer) clearInterval(timer); await pool.end(); });
try {
  await pool.query('SELECT 1 FROM core_shop_settings LIMIT 1');
  if (tickMs) {
    await pool.query('SELECT 1 FROM core_ai_draft_proposals LIMIT 1');
    await pool.query('SELECT 1 FROM ai0_inbound_document_artifacts LIMIT 1');
  }
  await app.listen({ host, port });
  if (tickMs && zaloRuntime) timer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    void zaloRuntime.tick_inbound().catch(() => {
      console.error('Synthetic inbound worker failed; batch remains durable');
    }).finally(() => { ticking = false; });
  }, tickMs);
  console.info('AUTO-IN core HTTP ready in simulation mode');
} catch {
  await app.close();
  console.error('AUTO-IN startup failed: verify test database, migrations and listener configuration');
  process.exitCode = 1;
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close(); });
