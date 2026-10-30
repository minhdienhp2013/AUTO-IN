import { assertIsolatedSimulationDatabase } from '../composition/postgres.js';

export const STAGING_ACK = 'OWNER_APPROVED_LOCAL_TEST_ONLY';
export const STAGING_DATABASE_ACK = 'OWNER_APPROVED_LOCAL_ISOLATED_TEST_DB';
export const STAGING_SIGNATURE_ACK = 'OWNER_ACCEPTS_SUPPORT_FORMULA_PENDING_SIGNED_VECTOR';
export const STAGING_DISCOVERY_ACK = 'OWNER_APPROVED_ONE_LOCAL_TEST_ID_DISCOVERY';
const STAGING_DISCOVERY_CHALLENGE_PATTERN = /^AUTO-IN-TEST-USER-[a-f0-9]{32}$/;

export interface StagingIdentity {
  readonly customer_id: string;
  readonly conversation_id: string;
}

export interface StagingIngressConfig {
  readonly app_id: string;
  readonly oa_id: string;
  readonly oa_secret_key: string;
  readonly test_users: ReadonlyMap<string, StagingIdentity>;
  readonly discover_test_user_once: boolean;
  readonly discovery_challenge: string | null;
}

export interface StagingRuntimeConfig {
  readonly database_url: string;
  readonly host: '127.0.0.1';
  readonly port: number;
  readonly ingress: StagingIngressConfig;
}

export type StagingEnvironment = Readonly<Record<string, string | undefined>>;

function required(env: StagingEnvironment, name: string): string {
  const value = env[name];
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value)
    throw new Error(`STAGING_CONFIG_REQUIRED:${name}`);
  return value;
}

function validIdentifier(value: string, max = 128): boolean {
  return value.length > 0 && value.length <= max && /^[A-Za-z0-9._:-]+$/.test(value);
}

export function assertStagingOptIn(env: StagingEnvironment): void {
  if (env.AUTO_IN_MODE !== 'staging_local' || env.AUTOIN_STAGING_ENABLED !== '1' ||
      env.AUTOIN_STAGING_ACK !== STAGING_ACK)
    throw new Error('STAGING_EXPLICIT_OPT_IN_REQUIRED');
}

export function assertNoPostgresEnvironmentOverrides(env: StagingEnvironment): void {
  // pg's connectionString path can consult these process-level settings.
  // Require one explicit URL to be the sole database target.
  for (const name of ['PGHOST', 'PGHOSTADDR', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD',
    'PGSSLMODE', 'PGSSLCERT', 'PGSSLKEY', 'PGSSLROOTCERT', 'PGSERVICE',
    'PGSERVICEFILE', 'PGOPTIONS', 'PGAPPNAME', 'PGCHANNELBINDING', 'PGCONNECT_TIMEOUT']) {
    if (env[name] !== undefined && env[name] !== '')
      throw new Error(`STAGING_DATABASE_OVERRIDE_FORBIDDEN:${name}`);
  }
}

function readIngressConfig(env: StagingEnvironment, discoverTestUserOnce: boolean): StagingIngressConfig {
  if (required(env, 'AUTOIN_STAGING_SIGNATURE_ACK') !== STAGING_SIGNATURE_ACK)
    throw new Error('STAGING_SIGNATURE_ACK_REQUIRED');

  const appId = required(env, 'AUTOIN_STAGING_APP_ID');
  const oaId = required(env, 'AUTOIN_STAGING_OA_ID');
  const testOaId = required(env, 'AUTOIN_STAGING_TEST_OA_ID');
  const secret = required(env, 'AUTOIN_STAGING_OA_SECRET_KEY');
  if (!validIdentifier(appId) || !validIdentifier(oaId) || oaId !== testOaId ||
      !validIdentifier(testOaId) || secret.length < 16 || secret.length > 512 ||
      /[\r\n\0]/.test(secret))
    throw new Error('STAGING_TEST_OA_CONFIG_INVALID');

  let decoded: unknown;
  try {
    const rawMapping = discoverTestUserOnce
      ? (env.AUTOIN_STAGING_TEST_USERS_JSON ?? '{}')
      : required(env, 'AUTOIN_STAGING_TEST_USERS_JSON');
    decoded = JSON.parse(rawMapping);
  }
  catch { throw new Error('STAGING_TEST_USER_MAPPING_INVALID'); }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded))
    throw new Error('STAGING_TEST_USER_MAPPING_INVALID');
  const entries = Object.entries(decoded as Record<string, unknown>);
  if ((discoverTestUserOnce ? entries.length !== 0 : entries.length < 1) || entries.length > 10)
    throw new Error('STAGING_TEST_USER_MAPPING_INVALID');

  const testUsers = new Map<string, StagingIdentity>();
  for (const [userId, identity] of entries) {
    if (!/^\d{6,32}$/.test(userId) || !identity || typeof identity !== 'object' ||
        Array.isArray(identity)) throw new Error('STAGING_TEST_USER_MAPPING_INVALID');
    const mapping = identity as Record<string, unknown>;
    const customerId = mapping.customer_id;
    const conversationId = mapping.conversation_id;
    if (Object.keys(mapping).length !== 2 || typeof customerId !== 'string' ||
        typeof conversationId !== 'string' ||
        !/^staging-customer-[a-z0-9-]{1,48}$/.test(customerId) ||
        !/^staging-conversation-[a-z0-9-]{1,48}$/.test(conversationId) ||
        !validIdentifier(customerId) || !validIdentifier(conversationId, 256))
      throw new Error('STAGING_TEST_USER_MAPPING_INVALID');
    testUsers.set(userId, { customer_id: customerId, conversation_id: conversationId });
  }
  const discoveryChallenge = discoverTestUserOnce
    ? required(env, 'AUTOIN_STAGING_DISCOVERY_CHALLENGE')
    : null;
  if (discoveryChallenge !== null && !STAGING_DISCOVERY_CHALLENGE_PATTERN.test(discoveryChallenge))
    throw new Error('STAGING_DISCOVERY_CHALLENGE_INVALID');

  return {
    app_id: appId,
    oa_id: oaId,
    oa_secret_key: secret,
    test_users: testUsers,
    discover_test_user_once: discoverTestUserOnce,
    discovery_challenge: discoveryChallenge
  };
}

/**
 * Dedicated guard for the staging database migration and runtime. Unlike the
 * generic isolated-test DB guard, this accepts exactly one numeric-loopback
 * target and no URL or inherited PostgreSQL connection overrides.
 */
export function assertStagingDatabaseTarget(
  databaseUrl: string,
  env: StagingEnvironment = process.env
): void {
  if (required(env, 'AUTOIN_STAGING_DB_ACK') !== STAGING_DATABASE_ACK)
    throw new Error('STAGING_DATABASE_EXPLICIT_ACK_REQUIRED');
  assertNoPostgresEnvironmentOverrides(env);

  try { assertIsolatedSimulationDatabase(databaseUrl); }
  catch { throw new Error('STAGING_DATABASE_MUST_BE_LOCAL_ISOLATED_TEST_DB'); }
  const parsed = new URL(databaseUrl);
  const databaseHost = parsed.hostname.replace(/^\[(.+)\]$/, '$1').toLowerCase();
  if (!['127.0.0.1', '::1'].includes(databaseHost) || parsed.port !== '5432' ||
      decodeURIComponent(parsed.pathname.slice(1)) !== 'autoin_test_staging')
    throw new Error('STAGING_DATABASE_MUST_BE_LOCAL_ISOLATED_TEST_DB');
}

export function readStagingRuntimeConfig(env: StagingEnvironment = process.env): StagingRuntimeConfig {
  assertStagingOptIn(env);
  const databaseUrl = required(env, 'DATABASE_URL');
  assertStagingDatabaseTarget(databaseUrl, env);
  const discoverTestUserOnce = env.AUTOIN_STAGING_DISCOVER_USER_ONCE === '1';
  if (discoverTestUserOnce) {
    if (env.AUTOIN_STAGING_DISCOVERY_ACK !== STAGING_DISCOVERY_ACK)
      throw new Error('STAGING_DISCOVERY_ACK_REQUIRED');
  } else if (env.AUTOIN_STAGING_DISCOVERY_ACK !== undefined) {
    throw new Error('STAGING_DISCOVERY_MODE_INVALID');
  }

  const rawPort = env.PORT ?? '3001';
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('STAGING_PORT_INVALID');
  const host = env.HOST ?? '127.0.0.1';
  if (host !== '127.0.0.1') throw new Error('STAGING_BIND_MUST_BE_LOOPBACK');

  return {
    database_url: databaseUrl,
    host: '127.0.0.1',
    port,
    ingress: readIngressConfig(env, discoverTestUserOnce)
  };
}
