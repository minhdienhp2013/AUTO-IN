import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { classifySessionFailure, sameRequestScope, sameSessionGeneration, type SessionRequestScope } from '../../web/src/session-request.ts';

const shopA: SessionRequestScope = {
  epoch: 10, sessionVersion: 4, actorId: 'staff-A', role: 'staff', shopId: 'shop-A',
};

test('current 401 is handled after the API clears its shop identity', () => {
  const afterCredentialClear = { ...shopA, shopId: null };
  assert.equal(sameRequestScope(shopA, afterCredentialClear), false);
  assert.equal(sameSessionGeneration(shopA, afterCredentialClear), true);
  assert.equal(classifySessionFailure(401, shopA, afterCredentialClear), 'unauthorized');
});

test('late 401 from shop A after login to shop B is stale and ignored', () => {
  const shopB: SessionRequestScope = {
    epoch: 13, sessionVersion: 6, actorId: 'staff-B', role: 'staff', shopId: 'shop-B',
  };
  assert.equal(classifySessionFailure(401, shopA, shopB), 'stale');
});

test('App clears current unauthorized session but discards stale request failures', async () => {
  const app = await readFile(new URL('../../web/src/App.tsx', import.meta.url), 'utf8');
  assert.match(app, /classifySessionFailure\(fault\.status, expectedScope, current\)/);
  assert.match(app, /if \(disposition === 'stale'\) return false;[\s\S]*?if \(disposition === 'unauthorized'\)[\s\S]*?clearStaffSession\(\);[\s\S]*?setError\(fault\.message/);
  assert.match(app, /setSession\(null\);setOrders\(\[\]\);setSelected\(null\)/);
});
