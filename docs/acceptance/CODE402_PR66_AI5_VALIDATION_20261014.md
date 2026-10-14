# AI5 — PR66 CODE-402 independent acceptance overlay

Product HEAD (unmodified): `c942c4e13333764972c5ff550306a8059e68d5ca` (PR #66 Draft), AI1 parent `f64e09cea76e52f0a4a1c1ad96fac3f3f6611b34`, AI2 parent `bd6e21243a8b2e7b6af2d162af4d724ea0507aa5`.

## Scope and precise execution

`tests/acceptance/code402-pr66-pg.test.mjs` is an AI5-owned **independent test**, reusing only the well-understood public test setup of AI0's composition fixture but asserting additional constraints (DB migration ordering, valid-signed replay, valid-signed wrong OA, true owner+staff authentication, NEEDS_FOLLOW_UP idempotency/audit and persistent HTTP409, 0 job, both pools/lock race). It does not modify production source.

The product branch **has no `tests/acceptance/` directory, no web app and no Chromium workflow**. Existing CI workflows run only `tests/integration/composition/**`, unit Core/AI2 and typecheck/build. Merely adding AI5 files and getting these product workflows green **DOES NOT execute the AI5 acceptance**. The result must be marked **NOT RUN** until a fresh isolated DB runner actually executes:

```bash
# Clean checkout of exact validation overlay commit, parent == product SHA above
npm ci
export DATABASE_URL='postgresql://<local-test-only>:<password>@127.0.0.1:5432/autoin_test_pr66'
export TEST_DATABASE_URL="$DATABASE_URL"
export AUTOIN_TEST_DATABASE_URL="$DATABASE_URL"
export AUTOIN_ALLOW_PG_ACCEPTANCE=YES_ISOLATED_TEST_DB
export AUTOIN_OPERATION_MODE=simulation
npm run db:migrate
npm run check
node --import tsx --test tests/acceptance/code402-pr66-pg.test.mjs
# Independent reverse direction and two PG pool Core gate from product:
# AI1 tests are part of npm run check / Core test suite.
```

This requires PostgreSQL 18.3 isolated test DB on localhost, no real OA credentials. Code checks SUCCESS on AI0 source is historical evidence only; no fresh AI5 counts without execution.

## Explicit acceptance gates

1. Root migration `scripts/database.ts` installs AI2 `004_official_quarantine.sql` before AI0 `005_official_zalo_quarantine.sql`, and both registry/review/scope/quarantine tables exist after real migration on clean DB.
2. Verified synthetic raw-body webhook persists one quarantine `NEEDS_HUMAN`, replay/lost ACK returns same receipt, bad signature 403 and valid signed wrong OA 422, zero additional writes.
3. Anonymous 401, staff 403; owner review `NEEDS_FOLLOW_UP` creates audited record, remains `NEEDS_HUMAN`; exact replay audit/idempotency stable; only owner `NO_ORDER_CHANGE` changes status to `REVIEWED`.
4. Manual verified order during pending receipt receives HTTP 409 `PENDING_INBOUND_REVIEW` and creates 0 approval/job. AI1 product test must prove BOTH directions of two-pool OA-row-lock race.
5. Signed text `OK` / untrusted click never creates CODE401 customer confirmation from synthetic candidate, staff approval, print job or outbound. Legitimate explicit customer confirmation in test is **separate** and is not AI2 consent.

**NOT RUN / BLOCKED:** Real Zalo OA signature, schema, callback, identity, real Ricoh/Windows, physical iPhone, V1 TN-037, and Chromium (this PR66 has no `web/`). The official live OA route remains default OFF. No merge/deploy or real messages/printing.
