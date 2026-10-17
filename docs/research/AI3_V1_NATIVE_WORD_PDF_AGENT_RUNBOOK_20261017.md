# V1-NATIVE-01 — AI3 Word/PDF native preparation (no live print)

**BASE:** AI0 PR #144 at SHA 0673460af71205986b901a21fc7724dbea23c991. **Ownership:** AI3 modules/tests/documentation only. **Safety:** No live Word, Ricoh, Zalo, physical printing, schema, API or Core change in CI.

## TN-009 / TN-012 / TN-023 / TN-029 / TN-034

Use explicit Windows printer inventory, never a default printer or silent Canon fallback. The intended device is Ricoh IM7000, Windows queue RMP7000, PCL6 V4 and port IP_192.168.1.195 (RAW 9100), but these strings do not verify the real device. A4/A3, orientation, copies, duplex and long-/short-edge binding must be preserved; shrink only, never upscale. A spooler acknowledgement does not prove paper. A lost acknowledgement / UNKNOWN job is held for human reconciliation, not automatically resent. Never force DOCX into PDF as the print source.

## Existing PDF pathway — unchanged

The established bridge and processor use PyMuPDF to rasterize representative pages, count total pages, faces and physical sheets (separate each file and copy), and write a private byte-identical PDF source, raster PNG and manifest. Core must independently anchor the exact revision/request hash/manifest SHA. The native binding validates all those bytes but cannot authorize a printer.

## New modules

1. workers/documents/native_job_binding.py: pure source/settings/manifest/preview/job verifier. Requires a trusted DB-derived ticket containing shop, order, job, revision, active revision, request hash, approval, lease, RMP7000, source/settings/manifest/preview SHA256. Compares manifest contents, recomputes PDF page/physical sheet plan, rejects stale/changed evidence. EVIDENCE_VERIFIED still returns allowed_to_print=false. Word remains blocked even if an untrusted manifest claims success. AI0 must ensure the ticket is built from authenticated Core records, not a client payload.

2. agents/windows/native_word_document.py: explicit privileged allow_word_launch option defaults FALSE. On Windows with pywin32 and separate authorization, opens a byte-identical private DOCX in Microsoft Word via COM DispatchEx, read-only, disables macros/links, repaginates and reads ComputeStatistics(wdStatisticPages). ExportAsFixedFormat produces only a temporary PDF for generating PNG preview with PyMuPDF; that PDF is deleted and NEVER becomes the print input. Original DOCX stays the intended Word-native print source. The module NEVER calls PrintOut, driver, spooler or RAW9100. Even after real COM render the result is REVIEW_REQUIRED because font substitution, table layout and Ricoh output have not been verified. Injected sessions are tagged injected_fake and never treated as live Word proof. COM can hang; AI0 must provide a parent watchdog/kill and private Windows session.

3. workers/documents/native_word_artifacts.py: stores a provisional private DOCX source/PNG/manifest bundle with SHA256 and processor.plan sheet-counts from Word-native reported pages. Schema ai3.native_word_preview.v1; returns REVIEW_REQUIRED and ready=false. Does not publish to Core. Fake observation is rejected unless a unit test deliberately spoofs a real-looking envelope for packaging coverage; this is NOT cryptographic attestation or live evidence.

4. agents/windows/native_queue_plan.py: compares inventory against RMP7000/Ricoh IM7000/PCL6/port, source format and approved PDF proof plus A4/A3 orientation/duplex/binding/copies. At most returns PREPARED_NOT_SENT with queue_submission_enabled=false, paper_verified=false. No Windows API or network calls and no fallback.

## Security and stage boundaries

- The signed-off AI0/AI1 Port must load verified private source/manifest/preview bytes with safe file handles; this pure verifier does not implement filesystem authorization.
- Bind active revision, request hash, settings hash, content SHA, manifest SHA, preview digests, approval, lease and printer to the claimed job and re-check through AI1 CAS immediately before a future send boundary.
- PDF uses original PDF; Word uses the original native DOCX, never the intermediary preview PDF. If fonts, Word installation, pagination or physical tray/duplex are uncertain => staff review and new confirmation after any changes.
- Never permit print based on a local flag or injected mock. Do not change legacy DryRun CLI, journal or one-job fake spooler.
- Any future native printing needs an independently approved authenticated staff review receipt and new AI0/AI1 contract; NO live printer adapter has been implemented in this branch.

## Validation commands

python -m compileall -q workers/documents agents/windows tests/unit/documents tests/unit/printing

python -m pytest -q tests/unit/documents tests/unit/printing

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
