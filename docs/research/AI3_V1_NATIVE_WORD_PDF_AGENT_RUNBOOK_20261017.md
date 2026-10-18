# V1-NATIVE-01 — AI3 Word/PDF native preparation (no live print)

## V1-NATIVE-10 — source contract adapter (18/10/2026)

`prepare_native_word_review_from_snapshot` accepts only the server-to-worker
`ai0.word_review_source.v1` object and verifies its strict keys, tenant/order/
revision/request anchors, byte lengths and SHA-256 digests, opaque relative
refs, same-bundle source/manifest location, and exact
`ai0.word_review_manifest.v1` bytes. Duplicate JSON keys are rejected. The
existing Core request data is preserved and hashed as-is; the current
`documents[]` shape is accepted only when exactly one registered DOCX matches
the trusted source locator. Unknown shapes or ambiguous/missing DOCX stay
`NEEDS_HUMAN` pending a Core-owned schema/registry contract.

Successful bundles repeat shop/order/revision/request hash, original DOCX ref,
hash and size, input manifest ref/hash, page/face/sheet counts, settings digest,
renderer facts, and preview page refs/digests. They always remain
`REVIEW_REQUIRED`, `ready=false`, `allowed_to_print=false`,
`requires_staff_review=true`, and `physical_print_verified=false`. The DOCX
remains the source intended for printing; no API, DB, driver or physical print
path is added. Word COM, Windows host behavior and Ricoh paper output remain
NOT RUN; mock tests exercise contract and denial behavior only.


**BASE:** AI0 PR #144 at SHA 0673460af71205986b901a21fc7724dbea23c991. **Ownership:** AI3 modules/tests/documentation only. **Safety:** No live Word, Ricoh, Zalo, physical printing, schema, API or Core change in CI.

## TN-009 / TN-012 / TN-023 / TN-029 / TN-034

Use explicit Windows printer inventory, never a default printer or silent Canon fallback. The intended device is Ricoh IM7000, Windows queue RMP7000, PCL6 V4 and port IP_192.168.1.195 (RAW 9100), but these strings do not verify the real device. A4/A3, orientation, copies, duplex and long-/short-edge binding must be preserved; shrink only, never upscale. A spooler acknowledgement does not prove paper. A lost acknowledgement / UNKNOWN job is held for human reconciliation, not automatically resent. Never force DOCX into PDF as the print source.

## Existing PDF pathway — unchanged

The established bridge and processor use PyMuPDF to rasterize representative pages, count total pages, faces and physical sheets (separate each file and copy), and write a private byte-identical PDF source, raster PNG and manifest. Core must independently anchor the exact revision/request hash/manifest SHA. The native binding validates all those bytes but cannot authorize a printer.

## New modules

1. workers/documents/native_job_binding.py: pure source/settings/manifest/preview/job verifier. Requires a trusted DB-derived ticket containing shop, order, job, revision, active revision, request hash, approval, lease, RMP7000, source/settings/manifest/preview SHA256. Compares manifest contents, recomputes PDF page/physical sheet plan, rejects stale/changed evidence. EVIDENCE_VERIFIED still returns allowed_to_print=false. Word remains blocked even if an untrusted manifest claims success. AI0 must ensure the ticket is built from authenticated Core records, not a client payload.

2. agents/windows/native_word_document.py: explicit privileged allow_word_launch option defaults FALSE. On Windows with pywin32 and separate authorization, opens a byte-identical private DOCX in Microsoft Word via COM DispatchEx, read-only, disables macros/links, repaginates and reads ComputeStatistics(wdStatisticPages). ExportAsFixedFormat produces only a temporary PDF for generating PNG preview with PyMuPDF; that PDF is deleted and NEVER becomes the print input. Original DOCX stays the intended Word-native print source. The module NEVER calls PrintOut, driver, spooler or RAW9100. Even after real COM render the result is REVIEW_REQUIRED because font substitution, table layout and Ricoh output have not been verified. Injected sessions are tagged injected_fake and never treated as live Word proof. The public preview entry now runs real COM through `agents.windows.native_word_watchdog` and `native_word_worker`: parent wall-clock timeout is bounded to 1–120 seconds (default 45), private temp input/output is removed, timeout kills the worker process tree, and malformed/oversized/unsafe responses become NEEDS_HUMAN. This is a process boundary, not proof of Windows COM behavior; validate the kill policy on the private Windows host before integration. It does not authorize printing.

3. workers/documents/native_word_artifacts.py: stores a provisional private DOCX source/PNG/manifest bundle with SHA256 and processor.plan sheet-counts from Word-native reported pages. Schema ai3.native_word_preview.v1; returns REVIEW_REQUIRED and ready=false. Does not publish to Core. Fake observation is rejected unless a unit test deliberately spoofs a real-looking envelope for packaging coverage; this is NOT cryptographic attestation or live evidence.

4. agents/windows/native_queue_plan.py: compares inventory against RMP7000/Ricoh IM7000/PCL6/port, source format and approved PDF proof plus A4/A3 orientation/duplex/binding/copies. At most returns PREPARED_NOT_SENT with queue_submission_enabled=false, paper_verified=false. No Windows API or network calls and no fallback.

## Security and stage boundaries

### V1-NATIVE-05 — native Word child watchdog

- `agents/windows/native_word_watchdog.py` is the public preview boundary for a real Word launch. It writes only the already hash-checked DOCX bytes to a private temporary directory, starts a child without shell/stdin/stdout/stderr, waits a bounded 1–120 seconds, and returns only a validated, size-limited JSON result. Timeout kills the POSIX process group or Windows worker tree; all failures hold for staff review. The worker receives generated internal paths, not caller-provided paths.
- `agents/windows/native_word_worker.py` invokes the existing COM preview implementation and serializes only preview evidence. Its temporary Word-export PDF is still only for preview rasterization and is never used as print source. No PrintOut, spooler/driver submission, journal transition, or physical-print permission exists in this boundary.
- Fake-child unit tests cover valid preview response, wall-clock timeout plus descendant cleanup, malformed response, forged print authority and no-launch without authorization. They run cross-platform but do not validate actual Windows COM, taskkill behavior on a managed host, Word process activation/cleanup, Vietnamese fonts, or Ricoh output. AI0 must review the boundary before connecting it to product runtime.

### V1-NATIVE-07 — internal Word preview review orchestrator

- `workers/documents/native_word_review.py` provides an internal worker/library adapter only. It checks the exact input bytes SHA-256, trusted request hash and revision before calling the public `preview_word_native` watchdog, then passes those same bytes and anchors to `make_word_review_artifacts`. The DOCX remains the source format; the disposable PDF from Word is used only to create preview images.
- `NativeWordReviewConfig.allow_word_launch` defaults to false. It is an in-process privileged configuration and must never be constructed from customer content, a file, webhook, or public request. This adapter does not decide caller authorization; its runtime caller must be separately authorized.
- Any invalid config, hash/revision mismatch, unavailable Word, timeout, malformed/native-evidence failure, or artifact error returns `NEEDS_HUMAN`, `ready=false`, `allowed_to_print=false`, `requires_staff_review=true`, and `physical_print_verified=false`. The adapter does not mutate Core, publish a plan/manifest, expose an endpoint, call `PrintOut`, or submit to a driver/spooler. The caller retains the original source bytes.
- Focused cross-platform tests exercise disabled launch, timeout, worker exception, source/request hash mismatch, and rejection of an explicitly `injected_fake` observation. Fakes prove only that unsafe/unavailable paths hold; no successful Microsoft Word/COM evidence was fabricated. The successful artifact path remains unproven until a private Windows host with actual Word validates it.
- Windows/Word COM, Word process cleanup on the managed host, fonts/layout, Ricoh queue/driver, physical paper, Zalo OA, and production runtime wiring are **NOT RUN**. AI0 must review and wire only after this boundary is integrated; AI5 must test the exact integrated candidate SHA.

### V1-NATIVE-08 — agent source handoff audit (BLOCKED)

- Candidate: `e7d85b8797344cc69e9b35cd694356f1f8d31502`. The existing `agents/windows/agent.py:PrintAgent.run_once` flow is claim → server preflight → evidence gate → journal/mark-sending. It has no Word review stage and receives no source bytes or private source reference. This point is downstream of preview review, customer confirmation and staff approval, so it cannot create the preview that must be reviewed before confirmation.
- `agents/windows/backend_http.py:HttpBackendClient.preflight` keeps an authenticated in-memory ticket, but its exact contract contains job/order/revision/request/approval scope, receipt, evidence digests and preview digests only. It has no DOCX source bytes/ref/hash, manifest ref/hash or trusted request data. `evidence_verified()` returns only a boolean. `backend/composition/approved-document-evidence.ts` verifies already-approved evidence and returns a gate result; it does not supply source bytes or create a review bundle.
- `workers/documents/native_word_review.py` can process bytes when a trusted caller supplies them, but the candidate has no production/internal caller that can obtain those bytes and request/revision anchors together. There is no configured private artifact root on the Windows agent. `workers/documents.bridge._read_scoped` explicitly refuses its POSIX-only no-follow open on Windows, so it is not a safe source reader for a Windows-side integration.
- **Minimum AI0/AI1 contract before AI3 wiring:** an authenticated internal pre-confirmation source port must resolve the active order revision and request hash from server state, return the exact canonical request data and one immutable DOCX snapshot with source SHA-256/size plus manifest ref/SHA from a private store, and support a current-revision/evidence recheck after Word preview and before publishing the review-only bundle. Windows artifact access must use a private ACL-protected root and reject reparse-point/path substitution. The returned relative artifact ref and manifest SHA may go only to an authenticated staff preview path; all results remain `ready:false`, `allowed_to_print:false`, `requires_staff_review:true`. Do not derive this ticket from a webhook, customer file, claimed job, or browser payload.
- This AI3 task therefore makes no live transport or `PrintAgent` connection. Existing regression evidence is limited to source-hash mismatch holding before Word launch, timeout/worker failure and malformed/fake observation holding without artifacts, and watchdog timeout process-tree cleanup. A stale active-revision comparison cannot be exercised until the authoritative binding exists. Successful manifest/artifact integrity is **NOT RUN**: no genuine Windows Word observation is available, and synthetic COM-like bundle fixtures are deliberately not used as success evidence.
- AI0/AI1 must provide the source port/Windows-safe storage contract; then AI3 can add the adapter call site and stale-revision/artifact-reference regression tests, and AI5 must validate the exact integrated candidate. Windows Word/COM and real Ricoh remain **NOT RUN**.

- The signed-off AI0/AI1 Port must load verified private source/manifest/preview bytes with safe file handles; this pure verifier does not implement filesystem authorization.
- Bind active revision, request hash, settings hash, content SHA, manifest SHA, preview digests, approval, lease and printer to the claimed job and re-check through AI1 CAS immediately before a future send boundary.
- PDF uses original PDF; Word uses the original native DOCX, never the intermediary preview PDF. If fonts, Word installation, pagination or physical tray/duplex are uncertain => staff review and new confirmation after any changes.
- Never permit print based on a local flag or injected mock. Do not change legacy DryRun CLI, journal or one-job fake spooler.
- Any future native printing needs an independently approved authenticated staff review receipt and new AI0/AI1 contract; NO live printer adapter has been implemented in this branch.

## Validation commands

python -m compileall -q workers/documents agents/windows tests/unit/documents tests/unit/printing

python -m pytest -q tests/unit/documents tests/unit/printing

python -m pytest -q tests/unit/printing/test_native_word_watchdog.py

Synthetic tests use real PyMuPDF PDFs and fake COM; check PDF page plan (3 pages x 2 copies duplex = 6 faces / 4 sheets), hash/revision/settings/manifest/preview mismatches, fake Word preview, macro DOCX denial, Ricoh queue inventory and never-send assertions.

## Acceptance / handoff

AI0 and AI1 must define authoritative ticket/CAS binding, Word staff layout confirmation, secure filesystem scope, timeout-isolated Windows Word COM worker, temporary preview retention, font substitution and printer capabilities before integration. AI5 then independently tests the exact integrated SHA. Windows Word automation, Vietnamese fonts, Ricoh IM7000 actual driver, real page/duplex/printed-paper comparison, Zalo OA and production deployment are NOT RUN. Neither V1 ready-to-print nor physical completion may be inferred from a mock. Do not merge/deploy or resend UNKNOWN.


## V1-CORE-AGENT-EVIDENCE-01 — AI0 contract adopted (18/10/2026)

Source: AI0 Draft PR #150, docs/architecture/V1_CORE_AGENT_EVIDENCE_CONTRACT_20261017.md, SHA 05cf967be45d084a0e288efbdbaa3e2a308afc4f. This PR stays AI3-only; no Core/schema/API/driver change.

### Exact-byte snapshot + trusted Core comparison

- workers.documents.print_evidence_v1.create_print_evidence_v1 constructs the internal schema ai0.print_evidence.v1 from private original DOCX/PDF bytes, ordered sources, preview PNG bytes, manifest bytes, print settings, renderer identity and Ricoh capability inventory. Each file is checked against manifest source SHA, original size, format and settings digest; previews are verified by raw byte SHA, order and size. processor.plan recomputes page/face/sheet counts. The derived tuple contains shop/order/revision/request_hash, sources with source hashes, source_set_sha256, settings_sha256, manifest_ref/sha256, previews index/bytes/sha256, renderer_sha256, plan_sha256, RMP7000, printer_capability_sha256 and canonical evidence_sha256. Deriving a digest is NOT authorization.
- verify_print_evidence_v1 recreates and compares every field against the independent Core-trusted evidence_sha256, including active revision; changed content, manifest, settings, preview, renderer, printer capability, source order or revision is fail-closed. Every result has allowed_to_print=false and allowed_to_simulate=false.
- AI0 MUST provide the Core scope/anchor from authenticated DB plus independently read no-follow source/preview bytes, native Word renderer version and real queue inventory. Pure Python data and hashes cannot authenticate their own provenance. Any new migration/wire is AI0/AI1-owned.

### Core receipt required even for simulation

- `agents.windows.native_simulation_review.review_simulation_only` consumes only the exact DB tuple projected by AI0/AI1's authenticated internal ticket: `receipt_id`, shop/order/revision/request/evidence hashes, `reviewer_id`, `reviewed_at`, and `decision="checked"`. AI1 performs staff-role authorization and persistence when issuing the receipt. Do not pass browser-supplied dataclasses, approval IDs, role flags, or booleans; those fields are not accepted as receipt data.
- The gate checks that the receipt and trusted job match the current evidence snapshot and scope, recomputes the snapshot digest (including ordered preview hashes), and requires `NOT_SENT` plus simulation mode. Missing receipt, wrong scope/actor data, stale evidence/preview, malformed decision, production mode, SENDING or UNKNOWN blocks. It does not authenticate a receipt supplied outside the server-side Core ticket.
- Success advances only to `PREPARED_NOT_SENT` with `review_status="EVIDENCE_REVIEWED"` for simulation. `allowed_to_simulate=true` is limited to a simulation path; `allowed_to_print=false`, `queue_submission_enabled=false`, and `physical_print_verified=false` remain fixed. No printer or journal transition occurs.

### Original DOCX remains original

- native_word_document.py adds renderer_identity from Word COM app.Version when separately authorized on real Windows; injected mock is explicitly engine=injected_fake. Word raster PNG is made from a temporary preview-only Word PDF, which is deleted after use; it is never substituted for the original DOCX.
- native_word_artifacts.py includes the renderer identity in private ai3.native_word_preview.v1 manifest. Word stays REVIEW_REQUIRED, ready=false, regardless of snapshot generation.
- Synthetic unit tests intentionally spoof a COM-like envelope solely to exercise byte hashing and fail-closed simulation gating. This is NOT evidence real Word COM, Vietnamese fonts, pagination against paper, Ricoh or physical printing worked.

### AI0/AI1 integration still required

AI0 and AI1 own transactionally trusted evidence_sha256 on customer confirmation, staff approval and job, CAS at claim/preflight/mark-sending, staff review receipt authority, time-bounded isolated Windows COM, real Ricoh inventory, and reconciliation of ambiguous driver ACK. Cached SENDING/UNKNOWN never permits a second driver call. AI5 independently accepts the same integrated SHA. No real OA, Ricoh, Windows Word, merge or deployment in this PR.

## V1-NATIVE-03 — Core receipt review gate (18/10/2026)

- Work branch `ai3/v1-native-word-review-gate-20261018`, based on integrated candidate `bbf54749511f88efdf43ca9197eba1de5e0fe69f`.
- The simulation gate accepts the exact nine-field receipt tuple projected from an AI0/AI1 DB-built ticket; AI1 remains responsible for persistence and reviewer authorization. It checks receipt/job scope and recomputes the evidence digest, which binds ordered preview hashes.
- A matching Word receipt advances only to `PREPARED_NOT_SENT` / `EVIDENCE_REVIEWED` in simulation. DOCX remains the source; print, queue submission and physical verification flags stay false. Missing/stale receipt/evidence, preview drift, malformed actor tuple, browser object, SENDING and UNKNOWN fail closed.
- `python -m compileall -q workers/documents agents/windows tests/unit/documents tests/unit/printing`: PASS; `git diff --check`: PASS. Focused test functions were invoked directly: Word receipt + PDF receipt + 13 negative cases PASS. The requested pytest command could not run because `pytest` is not installed in either available Python environment.
- Actual Windows Word COM, Vietnamese fonts, Ricoh queue/driver, physical paper, Zalo OA and live operation remain NOT RUN. This AI3 branch is local/unpushed and must be integrated and accepted on the resulting exact candidate SHA.

## V1-NATIVE-04 — HTTP preflight ticket gate (18/10/2026)

- Branch `ai3/v1-native-review-ticket-20261018`, based exactly on candidate `13aaaacfcfad8292c77a016d5e519680350ad3fd`. The integrated HTTPS route returns the Core preflight envelope plus `document_evidence_verified: true` only after the composition byte verifier succeeds; the Windows client requires that exact 9-field top-level shape. A raw 8-field Core service result, extra fields, missing flag or non-literal-true flag fail closed.
- `HttpBackendClient` keeps an isolated copy of the server ticket in memory, bound to job/order/revision/request hash/approval/lease identity. It clears the ticket at claim, preflight start/failure, gate denial and mark-sending. The ticket is never copied into the job, SQLite journal, report or logs.
- `PrintAgent.evidence_gate` invokes the compact verifier after authenticated preflight and before `Journal.begin`; it returns true only for the exact `PREPARED_NOT_SENT` / `EVIDENCE_REVIEWED` simulation result with `allowed_to_print=false`, queue submission false and physical verification false. Core still rechecks current evidence and receipt at mark-sending.
- Unit coverage includes malformed/missing receipt, extra receipt fields, stale digest/scope, wrong order/revision, empty or malformed preview digest vector, UNKNOWN/SENDING/production, missing composition flag, changed lease identity, pre-journal denial and no ticket persistence. All tests use synthetic HTTPS responses and `DryRunDriver` only.
- This gate trusts nested evidence/receipt only as a response from the scoped authenticated HTTPS endpoint; it does not authenticate a dictionary independently. Windows Word COM, Vietnamese fonts, Ricoh, paper output, OA and all live operations remain NOT RUN.
