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

## Independent execution evidence — actual RED gate (14/10/2026)

- **Exact product parent:** PR #31 `84cef429293eb4b6f49dac31e0078357d51cf1bc` (Draft); clean isolated test-only overlay [PR #57](https://github.com/minhdienhp2013/AUTO-IN/pull/57) **SHA `3ae9aec659e3b40e8a827f16f2660581bf6d76eb`**. Overlay diff only the new AI5 PG test, AI5 runner and this acceptance document, not AI0/AI1/AI2 product.
- [CODE checks #38454107898](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38454107898) **SUCCESS**, strict TypeScript, build/web and Chromium demo. [Simulation integration #38454107754](https://github.com/minhdienhp2013/AUTO-IN/actions/runs/38454107754): **postgres job #115492255216 FAILED** on product capability with **105 PASS / 3 FAIL / 19 SKIP**. **C402-OA-01 PASS**, C402-OA-02 `user_send_image` FAIL, C402-OA-03 `user_send_file` FAIL, C402-OA-04 `user_click_button` FAIL. Each exits `INVALID_OFFICIAL_EVENT` before durable quarantine. **No assertions removed/weakened or test waived.**
- Existing exact-checkout suites still passed on this RED integration run: contracts **18/18**, AI1 Core **37/37**, AI2 **85/85**, AI0 composition **25/25**. HTTP mode **62 PASS / 0 FAIL / 72 SKIP** (new PG-only cases deliberately labeled NOT RUN here). Chromium product-browser job #115492255609 **SUCCESS** with AI5 browser-only **58 PASS / 0 FAIL / 71 SKIP**, status×viewport **14/14 PASS**; real Fastify/PostgreSQL desktop and mobile browser smoke PASS.
- **These RED results do not falsify synthetic CODE-402 79/79 or official text-only unit results.** They prove the additional REQUIRED non-text custody contract is missing. The current official adapter is still factory-only, and runtime integration is **NOT RUN / BLOCKED**, not PASS. The fixture provider signatures are controlled test MACs; provider-side Zalo validation is NOT RUN.
- **Owner routing:** [AI2 / CODE-402] inside `backend/integrations/zalo/**`: persist verified-but-unrecognized image/file/button as safely scoped `unsupported` with trustworthy server receipt and a durable pending/human-review marker, no download/auto confirmation/print; on replay prevent duplication; do not infer official click payload. [AI0 / CODE-006] wire vetted official verifier, trusted OA/app/customer/chat registry and real PG queue to runtime under isolated controlled test, and ensure staff can see unresolved quarantine. Then [AI5] reruns exactly these required cases + replay/2 workers/HTTP/Chromium on NEW product SHA.
- **No release claim:** No authorized official OA credential/event schemas, real webhook delivery, official challenge button, Ricoh/Windows/iPhone real tests or TN-037 210 orders/7 days. Keep PR #31 Draft, PR #57 validation-only, no main merge/deploy/live OA/real printer.
