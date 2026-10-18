# AUTO-IN — V1-ACCEPTANCE-01 | Word/PDF-first acceptance gate

**Status: MATRIX/HARNESS UPDATED (27 synthetic fixtures + 31 acceptance overlays); all 58 product results NOT RUN.** This is a test-first AI5 plan and
independent verification harness, **not V1 release authorization**.

**AI5 V1-ACCEPTANCE-04 base reviewed:** `9dbaea9919d36a6fddae07cc972dfec1897ff3b5`.
**AI5 V1-ACCEPTANCE-05 base:** `e7d85b8797344cc69e9b35cd694356f1f8d31502`;
Word review overlays are acceptance-only and do not claim Windows Word success.
**AI5 V1-ACCEPTANCE-07 base:** `92d39adc8f76a0e7e52e60356e2f18155496d5bc`;
contract-aligned Word source cases V1-044–058 remain acceptance-only and NOT RUN.
This acceptance-only update does not claim that the API/UI or database cases
passed on that product SHA; inbound-queue product rows remain NOT RUN.

## Immutable source and ownership

- Branch: \`ai5/v1-word-pdf-acceptance-20261017\`, created from **PR144** candidate
  \`0673460af71205986b901a21fc7724dbea23c991\`; main at task start
  \`cb2be7a7b84d689dbe6c2c773192f111897c4063\`.
- Owner's Word/PDF-first criteria are recorded in AI0 **Draft PR150**,
  \`docs/architecture/V1_WORD_PDF_SCOPE_20261017.md\` and
  \`docs/architecture/V1_CORE_AGENT_EVIDENCE_CONTRACT_20261017.md\`, HEAD
  \`05cf967be45d084a0e288efbdbaa3e2a308afc4f\`.
  **This source document is not present on PR144's original SHA**; read from
  PR150 only. AI5 does not overwrite or amend that contract.
- PR149 OCR benchmark remains **Draft/Phase 2**. Neither image OCR nor automatic
  color/CCCD/TEMhoa is a blocker for the code-candidate Word/PDF-first goal.
  Existing TN005/TN037 still apply unless the owner explicitly updates policy.
- AI5 changes only this document,
  \`tests/acceptance/v1-word-pdf/**\` and
  \`tests/fixtures/public/v1-word-pdf/**\`. No product, schema, root
  scripts/lock, workflow, web source, printer agent, Zalo sender, merge or deploy.

## 1. Locked V1 scenario matrix

\`tests/fixtures/public/v1-word-pdf/matrix.json\` remains the machine-readable
27-case source/document manifest. \`tests/acceptance/v1-word-pdf/ticket_gate_matrix.json\`
adds four ticket-gate cases, the matrix \`additional_cases\` adds five staff
inbound-queue cases, and \`word_review_matrix.json\` adds twenty-two Word review
cases; together the exact-candidate product report must contain 58 unique case
IDs. All rows start with \`observed=NOT_RUN\` deliberately.
Acceptance overlays do not increase the synthetic file fixture count.

The Word source chain is pinned to the exact names in architecture contract
section 8: Core emits `ai0.word_review_source.v1`, including server-only
`private_bytes`; the exact bytes parse as `ai0.word_review_manifest.v1` with
duplicate JSON keys rejected. AI3 returns `ai3.native_word_preview.v1`; only
AI0 may project an authenticated, app-relative-page-URL-only
`ai0.word_review_preview.v1` to the UI. The browser projection carries no
source bytes or private storage references. These are acceptance anchors and
do not add or alter product endpoints.

| Case IDs | Gate | Mandatory observation for final integrated candidate |
| --- | --- | --- |
| V1-001 | PDF happy path | Original PDF byte SHA, verified preflight, pages/faces/sheets, preview hash, request/settings binding, real signed *test* confirmation, verified staff approval, one bounded send, reconciliation |
| V1-002 | Word native | Original DOCX opened via installed Word on trusted Windows host, native page count/render, font/layout check, **original DOCX sent to Word-native print API** (not PDF replacement). Not emulated by Linux conversions |
| V1-003–004 | PDF/DOCX changed source | New source SHA/revision invalidates old confirmation/approval; old request rejected, no print job |
| V1-005–007 | Copies/duplex/flip/paper/orientation/tray changed | Settings digest changes even when source SHA does not; same stale confirmation + approval denial |
| V1-008 | Quote changed | Old quote confirmation no longer valid; price must be reconfirmed |
| V1-009–011 | Role/shop | Authorized staff/owner only on current revision; unverified/customer or cross-shop user must be denied without mutation |
| V1-012–013 | Duplicate/idempotency | Same key/payload produces exactly one order/job and stable receipt; conflicting key/payload denied |
| V1-014 | Ambiguous ACK | SENDING then UNKNOWN, no automatic resend on restart/tick, only owner-authorized reprint after reconciliation |
| V1-015–016 | AI / network fail | File bytes/order persisted independently of DeepSeek and connectivity; failed fetch/worker holds for staff; reconnect must not create another send |
| V1-017–018 | PNG/JPEG/CCCD | Intake stores source then staff queue with reason "Đã nhận, chuyển nhân viên, chưa tự xử lý"; **0 print jobs** and no OCR/photo processing |
| V1-019–021 | Color/Excel/ZIP>5 | No silent black/white conversion or unsupported auto-print; six real ZIP document members trigger manual review |
| V1-022–023 | Unverified Word/PDF | Missing Word COM/font/layout, untrusted preview/capability, or unverifiable page/sheet plan => NEEDS_HUMAN/manual hold, no optimistic approval/print |
| V1-024 | Pending inbound/approval race | New inbound/revision/source during approval must produce 409/rebind and 0 jobs for old tuple |
| V1-025 | Manifest hash changed at **same manifest_ref** | Keep source byte/path, order, revision and settings fixed; change manifest bytes at same path → new manifest_sha256 and evidence_sha256. Reject previous consent/approval/claim/preflight/send; 0 new print/driver calls |
| V1-026 | Preview hash changed at **same preview path** | Keep native DOCX byte/path and preview index/path/byte length fixed; change preview bytes/hash → new evidence_sha256. Reject old consent/approval/ticket with 0 print |
| V1-027 | Renderer hash changed at **same executable path** | Same source, manifest/preview paths, settings, revision; trusted renderer identity/version digest changes → new evidence_sha256, force stale/NEEDS_HUMAN and no resend |
| V1-028 | Missing/invalid top-level Core ticket fields | Exercise missing and invalid values for all nine fields (`allowed`, `job_id`, `revision`, `mode`, `approval_id`, `document_evidence_verified`, `review_receipt`, `trusted_evidence`, `trusted_job`); each returns NEEDS_HUMAN with no journal row, mark-sending or driver call |
| V1-029 | Missing/invalid trusted receipt/evidence | Missing or corrupt receipt fields and trusted document evidence/digests/previews fail closed; preserve the order and prove no journal/mark/driver side effect |
| V1-030 | Cached ticket belongs to another lease | Change each claimed identity field (`job_id`, `order_id`, `revision`, `request_hash`, `approval_id`, `printer_id`, `lease_token`) after preflight; cached Core ticket cannot authorize mark or driver |
| V1-031 | HTTPS ticket gate precedes durable/print effects | On malformed integrated Core HTTPS ticket, agent stops after claim/preflight; journal count unchanged, no mark-sending request and no driver call |
| V1-032 | Staff inbound queue bearer and cache policy | Missing bearer is 401, non-staff is 403, authorized staff uses Bearer and receives `Cache-Control: no-store`; endpoint has no caller-selected shop query and returns bounded metadata only |
| V1-033 | Principal-derived shop scope | Queue is scoped to authenticated `principal.shop_id`; a spoofed shop query is ignored or rejected, and returned IDs remain a subset of that principal's rows with zero foreign IDs. The endpoint has no caller-selected shop route. |
| V1-034 | Truthful inbound status and file readiness | Show `NEEDS_HUMAN` / `AWAITING_MEDIA`; tell staff the original file is not saved or ready and cannot be previewed, confirmed, approved or printed yet |
| V1-035 | Failed refresh hides old queue data | Network, 401 and 503 failures clear prior rows and show an error/unverified state; stale rows are not shown as current |
| V1-036 | Inbound queue stays read-only | Queue only calls its GET endpoint; no preview fetch, customer confirmation, approval or print-job mutation occurs |
| V1-037 | Word source hash mismatch | Changed DOCX bytes vs trusted source SHA => NEEDS_HUMAN before Word launch or bundle creation |
| V1-038 | Word request hash mismatch | Changed request payload vs trusted request hash => NEEDS_HUMAN before Word launch or bundle creation |
| V1-039 | Word active revision mismatch | Current Core active revision differs from requested revision => NEEDS_HUMAN; no stale bundle or print side effect |
| V1-040 | Word launch default OFF | Default internal adapter config does not start Word; result is NEEDS_HUMAN until privileged runtime configuration is supplied |
| V1-041 | Word timeout/malformed output | Timeout and malformed worker output each produce NEEDS_HUMAN, cleanup, and zero artifact/print side effects |
| V1-042 | Word review bundle remains review-only | Native DOCX source and same source hash are retained; bundle status REVIEW_REQUIRED, ready=false, allowed_to_print=false, staff review required; preview PDF never becomes print source |
| V1-043 | Synthetic/fake Word cannot claim native success | injected_fake evidence is rejected as NEEDS_HUMAN and cannot create a review bundle or print authority |
| V1-044 | AI1 snapshot revision/request binding | Snapshot requires current active revision and request hash; either mismatch is held before bundle creation |
| V1-045 | Source and manifest byte verification | DOCX and manifest SHA-256 plus byte sizes match trusted bytes; manifest binds exact source SHA/size; result remains review-only |
| V1-046 | Cross-tenant and forged source refs | Cross-tenant and forged refs are rejected without opening untrusted bytes, creating a bundle or mutating order/print state |
| V1-047 | Last-moment stale snapshot recheck | Revision and request hash are re-read immediately before bundle creation; drift is held with no bundle or side effects |
| V1-048 | Original DOCX bytes preserved | Review bundle and manifest bind original DOCX byte length/hash; DOCX remains source format and print source, with no print authority |
| V1-049 | Snapshot path has no consent or print effects | Confirmations, approvals, print jobs and outbox counts remain unchanged across source fetch/review-only bundle creation |
| V1-050 | Tenant/order mismatch | Wrong shop or order binding is held, source bytes are not opened, no bundle or side effect |
| V1-051 | Revision/request/source/manifest mismatch | Independently mutate revision, request hash, source SHA/size, manifest ref/SHA; each must hold |
| V1-052 | Untrusted locator rejection | URL, absolute path, `..` traversal and cross-bundle references are rejected before opening bytes |
| V1-053 | Duplicate manifest JSON keys | Strict manifest parsing rejects duplicate keys before worker launch or bundle creation |
| V1-054 | Revision changes during read | Reload scope after I/O; do not return the stale snapshot or launch the worker |
| V1-055 | Fake renderer/preview | Untrusted renderer identity or preview bytes cannot produce a trusted worker result/bundle |
| V1-056 | Worker/UI DTO contract | Exact AI3/UI schemas; four review-only flags stay fail-closed; source bytes/private refs never reach UI |
| V1-057 | Image manual route | Preserve accepted image file, create staff route, disclose manual handling and skip Word worker |
| V1-058 | No mutations on review path | Confirmation, approval, print-job and outbox counters remain unchanged |


### Required evidence tuple and authority

Canonical AI0 contract is **PrintEvidenceV1**, schema \`ai0.print_evidence.v1\`:
trusted ordered \`sources[{source_artifact_ref,format,size_bytes,source_sha256}]\`,
\`source_set_sha256\`, \`settings_sha256\`, \`manifest_ref\`, \`manifest_sha256\`,
\`previews[{index,bytes,sha256}]\`, \`renderer_sha256\`, \`plan_sha256\`,
\`printer_id\`, \`printer_capability_sha256\` and \`evidence_sha256\`.
\`evidence_sha256\` hashes canonical UTF-8 JSON of all other snapshot fields.
Hashes are lower-case 64-character SHA-256 of authoritative bytes/identity,
not browser/AI-supplied values. **A path staying the same does not authorize
reusing an old confirmation or print ticket after a digest changes.**

For each order, record and compare
\`shop_id/order_id/revision/request_hash/source_sha256(or ordered source list)/
settings_sha256/manifest_sha256/preview_sha256/quote_revision/approved_revision/
printer_id/driver_capability_digest/idempotency_key\` at the appropriate
boundaries. These names are acceptance **evidence requirements**, **not**
a unilateral instruction to add product columns; AI0 must settle Core↔AI3↔agent
wire/schema ownership with AI1 and AI3 before implementation. An old consent
or approval cannot be revived by replay, and spooler ACK is not a paper count.

**Crucial separation:** The base Core already invalidates stale *revisions*.
That alone does **not** prove it binds actual sealed source bytes, print settings
digest, native Word preview or last-moment Windows agent. Positive native/agent
gates cannot PASS from an in-memory plan or synthetic principal.

## 2. Files/harness and permitted execution

- \`fixture_gate.py --check-fixture\`: generates **synthetic** PDF, minimal
  DOCX OOXML, PNG/JPEG, XLSX sentinel and ZIP of 6 PDF documents, pins expected
  ids/outcomes, checks signatures/distinct SHA, emits \`V1_FIXTURE_JSON\` and TAP.
  **PASS means fixture only; product NOT RUN**. Synthetic JPEG is not a CCCD.
- \`fixture_gate.py\` additionally builds **3 synthetic before/after
  PrintEvidenceV1 snapshots**. Each pair changes exactly one of the
  manifest/preview/renderer digest while holding paths, source bytes,
  source-set digest, settings digest, request hash and revision fixed.
  An evidence-digest change here is a **fixture assertion**, NOT proof that
  Core rejects an old customer's confirmation.
- \`test_fixture_gate.py\`: pytest negative controls for source mutation,
  settings digest, document structure and manual routing intent, **not** product.
- \`core_baseline_pg.mjs\`: guarded real-Core PostgreSQL checks for
  source/settings **encoded in request_data** causing revision staleness,
  idempotent order create/conflict, staff/cross-shop/unauthenticated denial,
  manual Core lock and persistence after a **synthetic** AI exception. Requires
  \`AUTOIN_OPERATION_MODE=simulation\`,
  \`AUTOIN_ALLOW_PG_ACCEPTANCE=YES_ISOLATED_TEST_DB\` and localhost
  \`TEST_DATABASE_URL=.../autoin_test_*\`. Still **not** source-byte verification
  or AI2 routing, verified provider confirmation, native Word or printer agent.
- \`audit_candidate.py\`: V1-025–027 demand original authoritative
  before/after PrintEvidenceV1 evidence with canonical SHA and **identical
  storage locators**; inspect proof that confirmation, approval, claim,
  preflight and mark-sending were blocked and that SQL guard/driver send
  counters did not increase. A digest-only synthetic JSON is insufficient.
- \`audit_candidate.py\`: future fail-closed ZIP SHA256/exact Git checkout/
  exact unified job log/\`product_commit_sha\`/TAP+JSON equality and
  **58 individually recorded** product observation/guard checks.
  A synthetically fabricated report or generic green CI is **not enough**:
  AI5 independently checks authoritative PG/HTTP/agent traces before declaring
  any candidate PASS. The instrument cannot attest raw device results alone.
  Every claimed product row must reference an authoritative trace capture
  bound to the exact candidate SHA and run mode, with a run ID, evidence locator,
  SHA-256 and `synthetic=false`; fixture-only, synthetic, wrong-SHA or missing
  captures are rejected.
- \`ticket_gate_matrix.json\` defines V1-028–031 separately from file fixtures.
  Each candidate report must include \`evidence.ticket_gate\` for these cases:
  SHA-256 references for authenticated HTTPS, agent and Core guard traces;
  all required mutation outcomes; and zero journal/mark/driver side effects for
  every rejected variation. V1-030 covers all seven cached-lease identity
  fields. V1-031 records \`claim\`, \`preflight\` only. These fields define the
  evidence shape, not proof by themselves; AI5 must inspect original traces.
  Synthetic fixture output remains \`FIXTURE_PASS_PRODUCT_NOT_RUN\` and cannot
  satisfy the product auditor.
- Matrix \`additional_cases\` defines V1-032–036. Each report must include
  \`evidence.inbound_queue\` with API/UI/DB-guard trace SHA-256 values. It records
  bearer/no-store responses, principal-scoped and spoof-query results, exact
  status/readiness copy, empty visible queue after network/401/503 errors, and
  unchanged preview/confirmation/approval/job counters. Evidence shape does
  not prove the underlying behavior; AI5 must inspect the original traces.
  Unit tests on a candidate do not replace isolated PostgreSQL and
  browser-level evidence for these five acceptance cases.
- \`word_review_matrix.json\` defines V1-037–058. Every product row defaults to
  \`observed=NOT_RUN\`. V1-044–058 use the exact contract DTO names `ai0.word_review_source.v1`,
  `ai0.word_review_manifest.v1`, `ai3.native_word_preview.v1`, and
  `ai0.word_review_preview.v1`. Every row requires exact-candidate product
  capture metadata and separate source/storage/manifest/Core trace SHA-256s.
  Cases cover tenant/order/revision/request/source hash+size/manifest ref+SHA
  mismatch; URL, absolute, parent-traversal and cross-bundle refs; duplicate
  JSON keys; revision drift during read; fake renderer/preview; exact review-only
  worker/UI flags and app-relative preview URLs; staff routing for images; and
  unchanged confirmation/approval/job/outbox counters. Evidence fields define what must be inspected; they are
  not product PASS, and the auditor rejects synthetic or wrong-SHA traces. Fixture-only or synthetic capture, wrong candidate/mode,
  or missing trace is rejected. These fields are evidence shape, not proof by
  themselves: AI5 must inspect the referenced original traces. Fixture/auditor
  self-tests never count as product evidence or as a Windows Word PASS.

### Commands to run in the exact integrated checkout (after AI0 hands off)

\`\`\`bash
git rev-parse HEAD
npm ci
npm run check
python -m compileall -q workers/documents agents/windows tests/unit/documents tests/unit/printing tests/acceptance/v1-word-pdf
python -m pytest -q tests/unit/documents tests/unit/printing tests/acceptance/v1-word-pdf
(cd web && npm ci && npm test && npm run typecheck && VITE_DEMO_MODE=false npm run build && npm run test:chromium:code008)
python tests/acceptance/v1-word-pdf/fixture_gate.py --check-fixture --json-out /tmp/v1-fixture.json

# Core baseline, NOT all 58 V1 product acceptance cases:
export AUTOIN_OPERATION_MODE=simulation
export AUTOIN_ALLOW_PG_ACCEPTANCE=YES_ISOLATED_TEST_DB
export TEST_DATABASE_URL='postgresql://auto_in:CI_ONLY@127.0.0.1:5432/autoin_test_v1wp'
export DATABASE_URL="$TEST_DATABASE_URL"
npm run db:migrate
node --import tsx --test tests/acceptance/v1-word-pdf/core_baseline_pg.mjs
\`\`\`

Do NOT execute on a production DB, production Zalo OA, Windows queue or Ricoh.
For final V1 product evidence AI0 must bind the exact SHA observed at runner
start, run all 58 scenarios against **the actual integrated product** (not just the Core
baseline), archive artifact \`v1-word-pdf.json\` and \`v1-word-pdf.tap\`
with original HTTP/SQL logs, job ID, exact checked-out SHA and SHA256 ZIP digest.
AI5 then runs:

\`\`\`bash
python tests/acceptance/v1-word-pdf/audit_candidate.py \
 --candidate-sha '<CANDIDATE_SHA_40_HEX>' \
 --artifact /tmp/v1-word-pdf-artifact.zip \
 --zip-sha256 '<GITHUB_ARTIFACT_ZIP_SHA256>' \
 --job-log /tmp/exact-head-unified-job.log
\`\`\`

A **PASS audit consistency** does not alone prove the underlying business
outcomes; AI5 must inspect the original, scope-bound evidence. Missing tests
are explicitly **NOT RUN**, not silent PASS/SKIP.

**Change control (18/10/2026):** File/evidence matrix includes V1-025–027;
ticket-gate overlay adds V1-028–031; inbound-queue acceptance adds V1-032–036;
Word review acceptance adds V1-037–058. All 58 product scenarios remain NOT RUN.
No exact integrated candidate SHA or product JSON/TAP/ZIP exists yet for these
new contract scenarios. Prior PR144/PR153 general CI is not acceptance evidence
for the Core↔AI3↔agent manifest/preview/renderer hash contract.

## 3. Execution status for THIS handoff

| Layer | Status | Limits |
| --- | --- | --- |
| Manifest/harness creation | **DONE** | 27 synthetic file fixtures + 31 acceptance overlays; all 58 product results NOT RUN |
| Fixture gate / Python compile | **FIXTURE PASS** | 27 synthetic inputs pass; 31 product acceptance overlays remain NOT RUN |
| `tests/ui/inbound-review.test.ts` | **PASS 5/5** | Node built-in unit tests on base `9dbaea9919d36a6fddae07cc972dfec1897ff3b5`; not browser or DB acceptance |
| Python pytest | **BLOCKED** | `python -m pytest` unavailable (`No module named pytest`); acceptance Python modules compile successfully |
| npm run check | **NOT RUN for this docs/acceptance-only branch** | AI0's base-candidate check is separate and does not include this AI5 change |
| UI Chromium | **NOT RUN for this acceptance-only branch** | Not exercised by ticket-gate acceptance changes |
| Core PostgreSQL isolated | **NOT RUN** | No isolated PostgreSQL evidence was produced for this task |
| 58-case integrated V1 acceptance | **NOT RUN / BLOCKED on AI0 integration** | Product runner/traces for V1-028–058 pending; fixture output is not product evidence |
| Real Windows Word COM, fonts/layout, Ricoh, OA/DeepSeek, Safari/iPhone | **NOT RUN** | No actual native Word/render/physical result is claimed |
| TN037 ≥210 real accepted jobs over ≥7 clean days | **NOT RUN** | Not replaced by synthetic batch or benchmark |

**Handoff to AI0:** jointly settle binding tuple with AI1/AI3, finish AI2 intake
and AI4 manual queue, merge into a **new** candidate only after reviewing
conflicts (not main), run the exact-SHA candidate commands and provide immutable
JSON/TAP/ZIP digest/Actions job for AI5 independent acceptance. PR149 remains
Draft Phase 2. **No merge, deploy, live OA or physical printing; V1 BLOCKED.**
