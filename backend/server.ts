import pg from 'pg';
import { lstat, mkdir, readFile } from 'node:fs/promises';
import { buildIntegratedApp, type ServiceIdentity } from './composition/runtime.js';
import { asSqlPool, assertIsolatedSimulationDatabase } from './composition/postgres.js';
import { createCoreModule } from './core/factory.js';
import { createSyntheticZaloRuntime } from './composition/zalo-simulation.js';
import { createPilotPrivateSourcePorts } from './composition/pilot-private-source.js';
import { createPilotIngressResolvers } from './composition/pilot-ingress.js';
import { createPilotCoreBatchPort } from './composition/pilot-core-batch.js';
const serverMode = process.env.AUTO_IN_MODE ?? 'simulation';
if (serverMode !== 'simulation' && serverMode !== 'controlled_test') throw new Error('Unsupported server mode');
const controlledEnabled = process.env.AUTOIN_PILOT_CONTROLLED_TEST_ENABLED ?? '0';
if (controlledEnabled !== '0' && controlledEnabled !== '1') throw new Error('Invalid controlled pilot switch');
if ((serverMode === 'controlled_test') !== (controlledEnabled === '1'))
  throw new Error('Controlled pilot requires explicit mode and switch');
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
const controlledFile = process.env.AUTOIN_PILOT_CONTROLLED_SCOPE_FILE;
if (serverMode === 'controlled_test' && (!controlledFile || !tls))
  throw new Error('Controlled pilot requires private scope file and TLS');
if (serverMode === 'simulation' && controlledFile)
  throw new Error('Controlled pilot scope is unavailable in simulation mode');
let controlledPilot: {shop_id:string;order_id:string;printer_id:string}|undefined;
if (controlledFile) {
  const stat = await lstat(controlledFile);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.size > 1024)
    throw new Error('Controlled pilot scope file must be private');
  const input:unknown = JSON.parse(await readFile(controlledFile,'utf8'));
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).sort().join(',') !== 'order_id,printer_id,shop_id')
    throw new Error('Controlled pilot scope invalid');
  const scope=input as Record<string,unknown>;
  if (typeof scope.shop_id !== 'string' || !scope.shop_id.trim() ||
      typeof scope.order_id !== 'string' || !scope.order_id.trim() ||
      scope.printer_id !== 'RMP7000') throw new Error('Controlled pilot scope invalid');
  controlledPilot={shop_id:scope.shop_id,order_id:scope.order_id,printer_id:'RMP7000'};
  if (!identities.some(identity => identity.principal.role === 'print_agent' &&
      identity.principal.shop_id === scope.shop_id &&
      identity.principal.printer_ids?.includes('RMP7000')))
    throw new Error('Controlled pilot Agent identity missing');
}
const registry = process.env.AUTOIN_ZALO_SYNTHETIC_REGISTRY
  ? JSON.parse(await readFile(process.env.AUTOIN_ZALO_SYNTHETIC_REGISTRY, 'utf8')) as unknown : undefined;
if (controlledPilot && registry !== undefined) throw new Error('Synthetic OA unavailable in controlled pilot');
const pool = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 5000 });
const core = createCoreModule({ pool: asSqlPool(pool) });
const documentArtifactRoot = process.env.AUTOIN_DOCUMENT_ARTIFACT_ROOT;
const reviewMode = process.env.AUTOIN_SIMULATION_REVIEW_ENABLED ?? '0';
if (reviewMode !== '0' && reviewMode !== '1') throw new Error('AUTOIN_SIMULATION_REVIEW_ENABLED must be 0 or 1');
const simulationReviewEnabled = reviewMode === '1';
if (controlledPilot && simulationReviewEnabled)
  throw new Error('Simulation review unavailable in controlled pilot');
const pilotFiles=[process.env.AUTOIN_PILOT_CODE_KEY_FILE,
  process.env.AUTOIN_PILOT_PRIVATE_SOURCE_ROOT,process.env.AUTOIN_PILOT_INGRESS_TOKEN_FILE];
if(pilotFiles.some(Boolean)&&pilotFiles.some(value=>!value))
  throw new Error('Pilot requires code key, private source root, and scoped ingress token files together');
const pilotEnabled=pilotFiles.every(Boolean);
if (controlledPilot && !pilotEnabled)
  throw new Error('Controlled pilot requires private source and ingress dependencies');
const pilotKey=pilotEnabled?await readFile(process.env.AUTOIN_PILOT_CODE_KEY_FILE!):undefined;
const pilotToken=pilotEnabled?(await readFile(process.env.AUTOIN_PILOT_INGRESS_TOKEN_FILE!,'utf8')).trim():undefined;
if(pilotEnabled&&(!pilotKey||pilotKey.length<32||!pilotToken||pilotToken.length<32))
  throw new Error('Pilot private credentials invalid');
if(pilotEnabled){
  const pilotRoot=process.env.AUTOIN_PILOT_PRIVATE_SOURCE_ROOT!;
  await mkdir(pilotRoot,{recursive:true,mode:0o700});
  const rootStat=await lstat(pilotRoot);
  if(!rootStat.isDirectory()||rootStat.isSymbolicLink()||(rootStat.mode&0o077))
    throw new Error('Pilot private source root must be owner-only');
}
const pilotPorts=pilotEnabled?createPilotPrivateSourcePorts(asSqlPool(pool),
  process.env.AUTOIN_PILOT_PRIVATE_SOURCE_ROOT!):undefined;
const zaloRuntime = registry === undefined ? undefined : createSyntheticZaloRuntime(pool, registry, {
  store: core.store,
  ...(documentArtifactRoot ? { artifactRoot: documentArtifactRoot } : {}),
  ...(pilotPorts ? {pilotIntake:trusted=>createPilotCoreBatchPort({
    service:core.service,trusted,
    processor:{id:'synthetic:zalo:'+trusted.oa_id,role:'processor',
      shop_id:trusted.shop_id,verified:true},
    custody:pilotPorts.custody
  })} : {})
});
const pilotIngress=pilotPorts&&pilotToken?createPilotIngressResolvers(asSqlPool(pool),pilotToken,
  pilotPorts.binding,input=>pilotPorts.custody.read_sealed(input)):undefined;
const reviewArtifactRoot = process.env.AUTOIN_SIMULATION_REVIEW_ROOT;
const allowWordLaunchValue = process.env.AUTOIN_WORD_REVIEW_ALLOW_LAUNCH ?? '0';
if (allowWordLaunchValue !== '0' && allowWordLaunchValue !== '1')
  throw new Error('AUTOIN_WORD_REVIEW_ALLOW_LAUNCH must be 0 or 1');
const allowWordLaunch = allowWordLaunchValue === '1';
if (allowWordLaunch && !simulationReviewEnabled)
  throw new Error('Word launch requires explicitly enabled simulation review mode');
if (simulationReviewEnabled) {
  if (!zaloRuntime || !documentArtifactRoot || !reviewArtifactRoot)
    throw new Error('Simulation review requires synthetic Zalo registry and source/output artifact roots');
  await mkdir(documentArtifactRoot, { recursive: true, mode: 0o700 });
  const sourceRootStat = await lstat(documentArtifactRoot).catch(() => null);
  if (!sourceRootStat?.isDirectory() || sourceRootStat.isSymbolicLink() || (sourceRootStat.mode & 0o077))
    throw new Error('Simulation source artifact root must be an owner-only 0700 directory');
  await mkdir(reviewArtifactRoot, { recursive: true, mode: 0o700 });
  const reviewRootStat = await lstat(reviewArtifactRoot).catch(() => null);
  if (!reviewRootStat?.isDirectory() || reviewRootStat.isSymbolicLink() || (reviewRootStat.mode & 0o077))
    throw new Error('Simulation review output root must be an owner-only 0700 directory');
}
const configuredTick = process.env.AUTOIN_ZALO_SYNTHETIC_TICK_MS;
const tickMs = configuredTick === undefined ? 0 : Number(configuredTick);
if (configuredTick !== undefined && (!zaloRuntime || !Number.isInteger(tickMs) || tickMs < 1000 || tickMs > 60000))
  throw new Error('Synthetic inbound worker requires a registry and interval 1000..60000');
let ticking = false;
let timer: ReturnType<typeof setInterval> | undefined;
const app = buildIntegratedApp({ pool: asSqlPool(pool), identities,
  ...(controlledPilot ? { controlledPilot } : {}),
  ...(tls ? { tls } : {}), ...(zaloRuntime ? { zaloWebhook: zaloRuntime.webhook } : {}),
  zaloWorkerConfigured: tickMs > 0,
  ...(process.env.AUTOIN_ARTIFACT_ROOT ? {previewArtifactRoot: process.env.AUTOIN_ARTIFACT_ROOT} : {}),
  ...(zaloRuntime && documentArtifactRoot ? {
    syntheticArtifactIngest: {
      artifactRoot: documentArtifactRoot,
      scope: zaloRuntime.trustedScope
    },
    firstPageQuestionQueue: input => zaloRuntime.queue_first_page_suggested_question(input)
  } : {}),
  ...(simulationReviewEnabled||pilotEnabled ? {
    trustedPrintEvidence: {
      artifactRoot: simulationReviewEnabled?documentArtifactRoot!:process.env.AUTOIN_PILOT_PRIVATE_SOURCE_ROOT!,
      printerCapabilities: { simulation_only: true as const, printer_id: 'RMP7000' as const,
        queue_name: 'RMP7000' as const }
    }
  } : {}),
  ...(simulationReviewEnabled ? {
    pdfReviewArtifactRoot: reviewArtifactRoot!,
    wordReviewArtifactRoot: reviewArtifactRoot!,
    allowNativeWordLaunch: allowWordLaunch
  } : {}),
  ...(pilotEnabled&&pilotPorts&&pilotIngress&&pilotKey?{
    pilotWordPdf:{hmacKey:pilotKey,pdfSource:pilotPorts.pdfSource,
      wordSource:pilotPorts.wordSource,...pilotIngress}
  }: {}) });
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
  console.info(`AUTO-IN core HTTP ready in ${serverMode} mode`);
} catch {
  await app.close();
  console.error('AUTO-IN startup failed: verify test database, migrations and listener configuration');
  process.exitCode = 1;
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close(); });
