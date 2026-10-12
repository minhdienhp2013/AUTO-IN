import test from 'node:test';
import assert from 'node:assert/strict';
import { pendingReviewSqlPool } from '../../../backend/composition/pending-review-errors.js';
import { PgStore, type SqlPool } from '../../../backend/storage/database.js';
import { DomainError } from '../../../backend/core/model.js';
import { buildIntegratedApp } from '../../../backend/composition/runtime.js';

const triggerError = () => Object.assign(new Error('AI0_PENDING_INBOUND_REVIEW'),
  { code: 'P0001', detail: 'PRIVATE CUSTOMER DATA MUST NOT BE RETURNED' });

test('AI0 known pending trigger maps to 409 and preserves rollback/release', async () => {
  const calls: string[] = [];
  const pool: SqlPool = {
    async query() { throw triggerError(); },
    async connect() { return {
      async query<T>(sql: string) {
        calls.push(sql);
        if (sql === 'INSERT approval') throw triggerError();
        return { rows: [] as T[], rowCount: 0 };
      },
      release() { calls.push('release'); }
    }; }
  };
  const wrapped = pendingReviewSqlPool(pool);
  const check = (error: unknown) => error instanceof DomainError &&
    error.code === 'PENDING_INBOUND_REVIEW' && error.status === 409 && !error.retryable;
  await assert.rejects(wrapped.query('query'), check);
  await assert.rejects(new PgStore(wrapped).tx(db => db.query('INSERT approval')), check);
  assert.deepEqual(calls, ['BEGIN', 'INSERT approval', 'ROLLBACK', 'release']);
});

test('AI0 does not relabel unrelated DB errors or substring lookalikes', async () => {
  for (const error of [
    Object.assign(new Error('other trigger'), { code: 'P0001' }),
    Object.assign(new Error('AI0_PENDING_INBOUND_REVIEW extra'), { code: 'P0001' }),
    Object.assign(new Error('AI0_PENDING_INBOUND_REVIEW'), { code: '23505' }),
    new DomainError('STALE_REVISION', 'stale', 409), new Error('connection lost')
  ]) {
    const pool: SqlPool = { async query() { throw error; }, async connect() { throw error; } };
    await assert.rejects(pendingReviewSqlPool(pool).query('query'), actual => actual === error);
  }
});

test('composition maps known PG error before AI1 route catch, without leaking DB detail (synthetic fault)', async () => {
  // Fault injection, not PostgreSQL acceptance: /me reaches AI1 auth's DB query.
  for (const known of [true, false]) {
    const error = known ? triggerError() : Object.assign(new Error('private DB failure'), { code: 'P0001' });
    const pool: SqlPool = { async query() { throw error; }, async connect() { throw error; } };
    const app = buildIntegratedApp({ pool });
    try {
      const response = await app.inject({url:'/api/v1/auth/me',headers:{authorization:'Bearer fixture-token'}});
      assert.equal(response.statusCode, known ? 409 : 500);
      assert.equal(response.json().error.code, known ? 'PENDING_INBOUND_REVIEW' : 'INTERNAL_ERROR');
      assert.doesNotMatch(response.body, /PRIVATE|detail|private DB/);
    } finally { await app.close(); }
  }
});
