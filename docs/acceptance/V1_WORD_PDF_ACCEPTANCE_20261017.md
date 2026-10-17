# AUTO-IN — V1-ACCEPTANCE-01 | Word/PDF-first acceptance gate

**Status: PREPARED / product candidate NOT RUN.** This is a test-first AI5 plan and
independent verification harness, **not V1 release authorization**.

## Immutable source and ownership

- Branch: \`ai5/v1-word-pdf-acceptance-20261017\`, created from **PR144** candidate
  \`0673460af71205986b901a21fc7724dbea23c991\`; main at task start
  \`cb2be7a7b84d689dbe6c2c773192f111897c4063\`.
- Owner's Word/PDF-first criteria are recorded in AI0 **Draft PR150**,
  \`docs/architecture/V1_WORD_PDF_SCOPE_20261017.md\`, HEAD
  \`6a5c06126270fdd02155abe0cbd6070c423d2ec7\`.
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

\`tests/fixtures/public/v1-word-pdf/matrix.json\` is the machine-readable
24-case manifest. All rows start with \`observed=NOT_RUN\` deliberately.

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

### Required evidence tuple and authority

For each order, record and compare
\`shop_id/order_id/revision/request_hash/source_sha256(or ordered source list)/
settings_digest/manifest_sha256/preview_sha256/quote_revision/approved_revision/
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
- \`audit_candidate.py\`: future fail-closed ZIP SHA256/exact Git checkout/
  exact unified job log/\`product_commit_sha\`/TAP+JSON equality and
  **24 individually recorded** product observation/guard checks.
  A synthetically fabricated report or generic green CI is **not enough**:
  AI5 independently checks authoritative PG/HTTP/agent traces before declaring
  any candidate PASS. The instrument cannot attest raw device results alone.

### Commands to run in the exact integrated checkout (after AI0 hands off)

\`\`\`bash
git rev-parse HEAD
npm ci
npm run check
python -m compileall -q workers/documents agents/windows tests/unit/documents tests/unit/printing tests/acceptance/v1-word-pdf
python -m pytest -q tests/unit/documents tests/unit/printing tests/acceptance/v1-word-pdf
(cd web && npm ci && npm test && npm run typecheck && VITE_DEMO_MODE=false npm run build && npm run test:chromium:code008)
python tests/acceptance/v1-word-pdf/fixture_gate.py --check-fixture --json-out /tmp/v1-fixture.json

# Core baseline, NOT all 24 V1 product acceptance cases:
export AUTOIN_OPERATION_MODE=simulation
export AUTOIN_ALLOW_PG_ACCEPTANCE=YES_ISOLATED_TEST_DB
export TEST_DATABASE_URL='postgresql://auto_in:CI_ONLY@127.0.0.1:5432/autoin_test_v1wp'
export DATABASE_URL="$TEST_DATABASE_URL"
npm run db:migrate
node --import tsx --test tests/acceptance/v1-word-pdf/core_baseline_pg.mjs
\`\`\`

Do NOT execute on a production DB, production Zalo OA, Windows queue or Ricoh.
For final V1 product evidence AI0 must bind a new exact candidate SHA, run all
24 scenarios against **the actual integrated product** (not just the Core
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

## 3. Execution status for THIS handoff

| Layer | Status | Limits |
| --- | --- | --- |
| Manifest/harness creation | **DONE** | Test-first, 24 expected cases, all product observed NOT RUN |
| Fixture pytest / Python compile | **NOT RUN on exact Git checkout** | Local session lacks complete AUTO-IN repo backing; exact branch CI/test environment required |
| npm run check | **BLOCKED in local session** | No repository package.json locally; local Node 22, repo requires Node ≥24.19; do not confuse ENOENT with product failure |
| UI Chromium | **NOT RUN on this candidate** | Chromium binary present locally, but no compiled AUTO-IN web/dist checkout; older PR144 green CI does not test V1 changes |
| Core PostgreSQL isolated | **NOT RUN** | No local PostgreSQL 18.3 test instance/fully installed repo; tester fails closed without TEST_DATABASE_URL |
| 24-case integrated V1 acceptance | **NOT RUN / BLOCKED on AI0 integration** | Source/settings/plan/agent contract pending; existing synthetic PR144 PASS is not this result |
| Word COM, Windows Ricoh, OA/DeepSeek, Safari/iPhone | **NOT RUN** | Physical account/host/device tests need explicit owner approval |
| TN037 ≥210 real accepted jobs over ≥7 clean days | **NOT RUN** | Not replaced by synthetic batch or benchmark |

**Handoff to AI0:** jointly settle binding tuple with AI1/AI3, finish AI2 intake
and AI4 manual queue, merge into a **new** candidate only after reviewing
conflicts (not main), run the exact-SHA candidate commands and provide immutable
JSON/TAP/ZIP digest/Actions job for AI5 independent acceptance. PR149 remains
Draft Phase 2. **No merge, deploy, live OA or physical printing; V1 BLOCKED.**
