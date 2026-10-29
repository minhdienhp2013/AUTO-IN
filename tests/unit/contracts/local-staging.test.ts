import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertStagingDatabaseTarget,
  assertStagingOptIn,
  readStagingRuntimeConfig,
  STAGING_ACK,
  STAGING_DATABASE_ACK,
  STAGING_SIGNATURE_ACK
} from '../../../backend/staging/config.js';
import { buildLocalStagingApp } from '../../../backend/staging/app.js';
import { createStagingZaloReceiver } from '../../../backend/staging/zalo-receiver.js';
import { assertLocalStagingSchema } from '../../../backend/staging/schema-guard.js';
import type { ZaloWebhookReceiver } from '../../../backend/composition/zalo-http.js';

const testUser = '1234567890123456';
const baseEnv: Record<string, string> = {
  AUTO_IN_MODE: 'staging_local',
  AUTOIN_STAGING_ENABLED: '1',
  AUTOIN_STAGING_ACK: STAGING_ACK,
  AUTOIN_STAGING_DB_ACK: STAGING_DATABASE_ACK,
  AUTOIN_STAGING_SIGNATURE_ACK: STAGING_SIGNATURE_ACK,
  DATABASE_URL: 'postgresql://auto_in:local-only@127.0.0.1:5432/autoin_test_staging',
  HOST: '127.0.0.1',
  PORT: '3001',
  AUTOIN_STAGING_APP_ID: 'app-test-01',
  AUTOIN_STAGING_OA_ID: 'oa-test-01',
  AUTOIN_STAGING_TEST_OA_ID: 'oa-test-01',
  AUTOIN_STAGING_OA_SECRET_KEY: 'local-test-secret-at-least-16',
  AUTOIN_STAGING_TEST_USERS_JSON: JSON.stringify({
    [testUser]: {
      customer_id: 'staging-customer-one',
      conversation_id: 'staging-conversation-one'
    }
  })
};

test('local staging refuses startup without each explicit opt-in', () => {
  for (const [name, value] of [
    ['AUTO_IN_MODE', 'simulation'],
    ['AUTOIN_STAGING_ENABLED', '0'],
    ['AUTOIN_STAGING_ACK', ''],
    ['AUTOIN_STAGING_DB_ACK', ''],
    ['AUTOIN_STAGING_SIGNATURE_ACK', '']
  ] as const) {
    const env = { ...baseEnv, [name]: value };
    assert.throws(() => readStagingRuntimeConfig(env));
  }
  assert.throws(() => assertStagingOptIn({}), /STAGING_EXPLICIT_OPT_IN_REQUIRED/);
});

test('local staging accepts only loopback isolated test PostgreSQL and bind address', () => {
  const config = readStagingRuntimeConfig(baseEnv);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 3001);
  assert.equal(config.ingress.test_users.size, 1);
  assert.equal(config.ingress.test_users.get(testUser)?.customer_id, 'staging-customer-one');

  for (const url of [
    'postgresql://user:secret@db.example:5432/autoin_test_staging',
    'postgresql://user:secret@127.0.0.1:5433/autoin_test_staging',
    'postgresql://user:secret@127.0.0.1:5432/autoin_test',
    'postgresql://user:secret@127.0.0.1:5432/auto_in',
    'postgresql://user:secret@127.0.0.1:5432/autoin_test_staging?sslmode=require'
  ]) assert.throws(() => readStagingRuntimeConfig({ ...baseEnv, DATABASE_URL: url }));

  assert.throws(() => readStagingRuntimeConfig({ ...baseEnv, HOST: '0.0.0.0' }), /STAGING_BIND_MUST_BE_LOOPBACK/);
  assert.throws(() => readStagingRuntimeConfig({ ...baseEnv, PGHOST: 'db.example' }), /STAGING_DATABASE_OVERRIDE_FORBIDDEN:PGHOST/);
});

test('staging migration guard accepts only the named numeric-loopback DB with no PG overrides', () => {
  const validUrl = 'postgresql://auto_in:local-only@127.0.0.1:5432/autoin_test_staging';
  assert.doesNotThrow(() => assertStagingDatabaseTarget(validUrl, baseEnv));
  assert.doesNotThrow(() => assertStagingDatabaseTarget(
    'postgresql://auto_in:local-only@[::1]:5432/autoin_test_staging', baseEnv
  ));
  for (const url of [
    'postgresql://auto_in:local-only@127.0.0.1:5432/autoin_test',
    'postgresql://auto_in:local-only@localhost:5432/autoin_test_staging',
    'postgresql://auto_in:local-only@127.0.0.1:5433/autoin_test_staging',
    'postgresql://auto_in:local-only@db.example:5432/autoin_test_staging',
    'postgresql://auto_in:local-only@127.0.0.1:5432/autoin_test_staging?sslmode=require'
  ]) assert.throws(() => assertStagingDatabaseTarget(url, baseEnv));
  assert.throws(() => assertStagingDatabaseTarget(validUrl, { ...baseEnv, PGHOST: 'db.example' }));
  assert.throws(() => assertStagingDatabaseTarget(validUrl, {
    ...baseEnv, AUTOIN_STAGING_DB_ACK: 'wrong-ack'
  }));
});

test('staging startup requires migration 005 exact quarantine provider-event unique partial index', () => {
  const base = {
    inbound_events: true,
    process_queue: true,
    quarantine: true,
    quarantine_scopes: true,
    provider_event_id_column: true,
    provider_event_index_definition: 'CREATE UNIQUE INDEX zalo_official_quarantine_event_id_unique ON public.zalo_official_quarantine USING btree (oa_id, provider_event_id) WHERE (provider_event_id IS NOT NULL)'
  };
  assert.doesNotThrow(() => assertLocalStagingSchema(base));
  assert.throws(() => assertLocalStagingSchema({ ...base, provider_event_id_column: false }),
    /STAGING_DATABASE_MIGRATIONS_REQUIRED/);
  assert.throws(() => assertLocalStagingSchema({ ...base, provider_event_index_definition: null }),
    /STAGING_DATABASE_MIGRATIONS_REQUIRED/);
  assert.throws(() => assertLocalStagingSchema({ ...base,
    provider_event_index_definition: base.provider_event_index_definition.replace('CREATE UNIQUE INDEX', 'CREATE INDEX')
  }), /STAGING_DATABASE_MIGRATIONS_REQUIRED/);
  assert.throws(() => assertLocalStagingSchema({ ...base,
    provider_event_index_definition: base.provider_event_index_definition.replace('(oa_id, provider_event_id)', '(provider_event_id)')
  }), /STAGING_DATABASE_MIGRATIONS_REQUIRED/);
  assert.throws(() => assertLocalStagingSchema({ ...base,
    provider_event_index_definition: base.provider_event_index_definition.replace('WHERE (provider_event_id IS NOT NULL)', 'WHERE (provider_event_id IS NULL)')
  }), /STAGING_DATABASE_MIGRATIONS_REQUIRED/);
});

test('local staging requires test OA, synthetic identities, and a valid mapping', () => {
  assert.throws(() => readStagingRuntimeConfig({ ...baseEnv, AUTOIN_STAGING_TEST_OA_ID: 'different-oa' }));
  assert.throws(() => readStagingRuntimeConfig({ ...baseEnv, AUTOIN_STAGING_TEST_USERS_JSON: '{}' }));
  assert.throws(() => readStagingRuntimeConfig({ ...baseEnv,
    AUTOIN_STAGING_TEST_USERS_JSON: JSON.stringify({ [testUser]: {
      customer_id: 'customer-real', conversation_id: 'staging-conversation-one'
    } })
  }));
  assert.throws(() => readStagingRuntimeConfig({ ...baseEnv,
    AUTOIN_STAGING_TEST_USERS_JSON: '{"not-a-zalo-id":{}}'
  }));
});

const scope = {
  app_id: 'app-test-01',
  oa_id: 'oa-test-01',
  oa_secret_key: 'local-test-secret-at-least-16',
  resolve_verified_user(userId: string) {
    return userId === testUser ? {
      customer_id: 'staging-customer-one',
      conversation_id: 'staging-conversation-one'
    } : null;
  },
  test_user_ids: new Set([testUser])
};

function makeSignedPayload(userId = testUser, oaId = 'oa-test-01'): Buffer {
  return Buffer.from(JSON.stringify({
    app_id: 'app-test-01',
    event_id: 'evt-local-1',
    event_name: 'user_send_text',
    user_id_by_app: userId,
    timestamp: String(Date.now()),
    recipient: { id: oaId },
    message: { text: 'synthetic staging fixture' }
  }));
}

test('staging fence verifies signature and rejects unknown users or OA before persistence', async () => {
  let calls = 0;
  const downstream: ZaloWebhookReceiver = {
    async receive_webhook() { calls++; return { status_code: 202, body: { accepted: true } }; }
  };
  let signatureValid = false;
  const verifier = { async verify() { return signatureValid; } };
  const fenced = createStagingZaloReceiver(scope, downstream, verifier);
  const payload = makeSignedPayload();

  assert.equal((await fenced.receive_webhook(payload, {})).status_code, 403);
  assert.equal(calls, 0);
  signatureValid = true;
  assert.equal((await fenced.receive_webhook(makeSignedPayload('9999999999999999'), {})).status_code, 403);
  assert.equal(calls, 0);
  assert.equal((await fenced.receive_webhook(makeSignedPayload(testUser, 'other-oa'), {})).status_code, 422);
  assert.equal(calls, 0);
  const missingRecipient = JSON.parse(payload.toString('utf8')) as Record<string, unknown>;
  delete missingRecipient.recipient;
  assert.equal((await fenced.receive_webhook(Buffer.from(JSON.stringify(missingRecipient)), {})).status_code, 422);
  assert.equal(calls, 0);
  assert.equal((await fenced.receive_webhook(payload, {})).status_code, 202);
  assert.equal(calls, 1);
});

test('local staging exposes only health and raw inbound webhook; outbound and print routes are absent', async t => {
  let received: Buffer | undefined;
  const receiver: ZaloWebhookReceiver = {
    async receive_webhook(raw) {
      received = Buffer.from(raw);
      return { status_code: 202, body: { accepted: true } };
    }
  };
  const app = buildLocalStagingApp(receiver);
  t.after(() => app.close());

  const health = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(health.statusCode, 200);
  assert.deepEqual(health.json(), {
    status: 'ok', mode: 'staging_local', inbound_webhook_enabled: true,
    staff_api_enabled: false, outbound_enabled: false, printing_enabled: false
  });
  for (const [method, url] of [
    ['GET', '/api/v1/orders'],
    ['POST', '/internal/v1/print-jobs/claim'],
    ['POST', '/api/v1/outbound/messages']
  ] as const) {
    assert.equal((await app.inject({ method, url, payload: {} })).statusCode, 404);
  }

  const raw = Buffer.from('{ "synthetic": "exact bytes" }');
  const webhook = await app.inject({ method: 'POST', url: '/webhooks/zalo',
    headers: { 'content-type': 'application/json' }, payload: raw });
  assert.equal(webhook.statusCode, 202);
  assert.deepEqual(received, raw);
});
