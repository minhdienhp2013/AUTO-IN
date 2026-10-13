# AI5 — CODE-402 official OA runtime / durable pending quarantine acceptance (14/10/2026)

## Evidence boundary

- Tested target: AI0 PR #31 product SHA `84cef429293eb4b6f49dac31e0078357d51cf1bc`, Draft. AI2 source PR #53 `7e3f66668896aa89b8a5fc37447697140ed0f9fe` (official TEXT-only adapter), not a live-enabled OA runtime. AI5 PR #18 retains its historical branch and may be overlaid as tests-only on exact AI0 SHA to run independent GitHub Actions.
- Only AI5 owns the new `tests/acceptance/code402-official-quarantine-pg.test.mjs` and its registration in `tests/acceptance/run.mjs`. No edits to `backend/**`, runtime, Zalo adapter, migrations, workflows, authorization, printers, or any live service.
- The test generates synthetic *cryptographic MAC* vectors using the publicly documented X-ZEvent-Signature construction and test-only random config. These are **NOT captured signed events from Zalo OA**, and image/file/click payload envelopes in these tests are controlled placeholders, **NOT assertions of the official JSON schema**. No real OA keys, app or person are used.
- A standalone AI2 factory test does NOT prove production Fastify has connected that adapter. Existing AI0 `buildIntegratedApp` takes an optional `zaloWebhook`; production wiring from server-owned official app/OA/verified-user registry to runtime and scheduler is still **BLOCKED / NOT RUN**. Never report the factory-only successful test as a live integration result.

## Mandatory independent test matrix

| Case | Must be verified by AI5 on isolated real PostgreSQL | Current expected product owner |
|---|---|---|
| C402-OA-01 | MAC from original raw bytes; signed TEXT normalizes to configured internal customer/chat, exactly one `zalo_inbound_events` row and one `zalo_process_queue` row across two independent PG pools, failed MAC has no extra write; stays candidate-unprivileged | AI2 component |
| C402-OA-02 | Signed unsupported image event retained durably as `kind='unsupported'` with trusted `received_at`, event, OA/customer/chat binding and pending processing marker, never auto-accepted as a verified document | **AI2 CODE-402** missing official non-text quarantine |
| C402-OA-03 | Signed unsupported file event retained with the same durable and non-authorization properties | **AI2 CODE-402** missing official non-text quarantine |
| C402-OA-04 | Signed unsupported click/button retained as UNTRUSTED, with no `confirmation_postback`, no customer credential/print permission; same event replay does not create duplicate quarantine | **AI2 CODE-402**, plus AI0/AI1 challenge resolver later |
| C402-OA-RUNTIME | REAL AI0 composition must explicitly configure official verified adapter from server-owned OA/shop and user→customer/chat scope, route exact signed bytes to durable storage without using synthetic verifier | **AI0 composition**, NOT RUN until controlled fixture wiring exists |
| C402-OA-PILOT | Real Zalo Developers app webhook signature, actual event schema, HTTP delivery retries, official click/postback challenge send, live customer identity | **NOT RUN** pending authorized account and explicit owner permission |

**Quarantine stage 1 contract:** before attempting interpretation, retain a verified but unsupported provider event with a durable queue marker in isolated PostgreSQL so it is never silently dropped or treated as consent. A separate human-review/status presentation beyond this first event-level custody gate remains an integration requirement; success on C402-OA-02/03/04 alone will not prove complete staff triage.

## Test execution, failure handling

- Exact checkout: use a clean GitHub Actions overlay with AI0 SHA above as **direct parent**, changing only AI5 acceptance test, runner and this documentation. The branch PR #18 by itself is an older AI5 history, not an executable proof of new product integration.
- Test by `node tests/acceptance/run.mjs --integration` with isolated PostgreSQL 18.3 and `AUTOIN_INTEGRATION_SHA` pointing to exactly the checked-out overlay commit. HTTP and Chromium should run in their respective modes and may label PG-only cases SKIP (not PASS).
- Current official adapter explicitly handles only `user_send_text`. Therefore C402-OA-02/03/04 must report **FAIL / BLOCKED** until AI2 implements the quarantining contract, rather than weakening/removing/asserting that rejecting every unsupported event is sufficient. A FAIL is a release blocker, not permission to enable live OA.
- On any FAIL, record the actual test name, exact code SHA, CI run/job IDs, PASS/FAIL/SKIP and required owner. Keep PR #31 Draft, no merge main/deploy/real OA/print.
