import test from 'node:test';
import assert from 'node:assert/strict';
import {assertLocalSimulationUrl} from './local-http-guard.mjs';
test('HTTP GUARD refuses production / remote endpoints', () => {
  for (const url of ['https://quan-ly-ban-hang-web.pages.dev/', 'http://192.168.1.195:9100/', 'http://example.com:3000/', 'http://localhost:3000/a', 'http://admin:pass@localhost:3000/', 'not-an-url']) {
    assert.throws(() => assertLocalSimulationUrl(url), url);
  }
});
test('HTTP GUARD requires explicit simulation opt-in', () => {
  const before = process.env.AUTOIN_ACCEPTANCE_HTTP_SCOPE;
  delete process.env.AUTOIN_ACCEPTANCE_HTTP_SCOPE;
  try { assert.throws(() => assertLocalSimulationUrl('http://127.0.0.1:3000/')); }
  finally { if (before === undefined) delete process.env.AUTOIN_ACCEPTANCE_HTTP_SCOPE; else process.env.AUTOIN_ACCEPTANCE_HTTP_SCOPE = before; }
});
test('HTTP GUARD accepts only local simulation origin', () => {
  const before = process.env.AUTOIN_ACCEPTANCE_HTTP_SCOPE;
  process.env.AUTOIN_ACCEPTANCE_HTTP_SCOPE = 'local-simulation';
  try { assert.equal(assertLocalSimulationUrl('http://127.0.0.1:3000/'), 'http://127.0.0.1:3000'); }
  finally { if (before === undefined) delete process.env.AUTOIN_ACCEPTANCE_HTTP_SCOPE; else process.env.AUTOIN_ACCEPTANCE_HTTP_SCOPE = before; }
});
