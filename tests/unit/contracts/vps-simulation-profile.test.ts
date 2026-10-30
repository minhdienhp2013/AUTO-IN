import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = async (path: string) => readFile(new URL(`../../../${path}`, import.meta.url), 'utf8');

test('VPS service remains loopback-bound simulation and reads secrets from a private env file', async () => {
  const service = await source('deploy/vps-simulation/autoin-simulation.service');
  assert.match(service, /^User=auto-in$/m);
  assert.match(service, /^EnvironmentFile=\/etc\/auto-in\/simulation\.env$/m);
  assert.match(service, /^Environment=AUTO_IN_MODE=simulation$/m);
  assert.match(service, /^Environment=HOST=127\.0\.0\.1$/m);
  assert.match(service, /^Environment=PORT=3000$/m);
  assert.match(service, /^ExecStart=\/usr\/bin\/node \/opt\/auto-in\/current\/dist\/backend\/server\.js$/m);
  assert.match(service, /^NoNewPrivileges=true$/m);
  assert.match(service, /^ProtectSystem=strict$/m);
  assert.doesNotMatch(service, /AUTO_IN_MODE=production|HOST=0\.0\.0\.0|HOST=::/);
});

test('Caddy simulation host permits only health and authenticated print-agent methods', async () => {
  const caddy = await source('deploy/vps-simulation/Caddyfile.example');
  assert.match(caddy, /method GET\s+path \/health/);
  assert.match(caddy, /method POST\s+path \/internal\/v1\/print-jobs\/claim/);
  assert.ok(caddy.includes('path_regexp agentJob ^/internal/v1/print-jobs/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/(preflight|mark-sending|reports)$'));
  assert.ok(caddy.includes('respond "Not Found" 404'));
  for (const forbiddenPath of ['/api/v1', '/webhooks/zalo', '/internal/v1/pilot', '/source']) {
    assert.equal(caddy.includes(forbiddenPath), false, `${forbiddenPath} must stay private`);
  }
  assert.ok(caddy.includes('reverse_proxy 127.0.0.1:3000'));
});

test('sample VPS database and agent identity are explicitly synthetic', async () => {
  const env = await source('deploy/vps-simulation/simulation.env.example');
  const identities = JSON.parse(await source('deploy/vps-simulation/simulation-identities.example.json')) as Array<{
    token: string; principal: { role: string; shop_id: string; verified: boolean; printer_ids: string[] };
  }>;
  assert.match(env, /^DATABASE_URL=postgresql:\/\/[^\s@]+@127\.0\.0\.1:5432\/autoin_test_vps$/m);
  assert.match(env, /^AUTOIN_IDENTITIES_FILE=\/etc\/auto-in\/simulation-identities\.json$/m);
  assert.equal(identities.length, 1);
  assert.match(identities[0]!.token, /^REPLACE_WITH_A_RANDOM_SECRET/);
  assert.equal(identities[0]!.principal.role, 'print_agent');
  assert.equal(identities[0]!.principal.shop_id, 'simulation-shop');
  assert.equal(identities[0]!.principal.verified, true);
  assert.deepEqual(identities[0]!.principal.printer_ids, ['RMP7000']);
});
