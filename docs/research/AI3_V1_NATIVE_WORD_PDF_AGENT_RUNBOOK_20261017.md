# V1-NATIVE-01 — AI3 Word/PDF native preparation (no live print)

**BASE:** AI0 PR #144 at SHA 0673460af71205986b901a21fc7724dbea23c991. **Ownership:** AI3 modules/tests/documentation only. **Safety:** No live Word, Ricoh, Zalo, physical printing, schema, API or Core change in CI.

## TN-009 / TN-012 / TN-023 / TN-029 / TN-034

Use explicit Windows printer inventory, never a default printer or silent Canon fallback. The intended device is Ricoh IM7000, Windows queue RMP7000, PCL6 V4 and port IP_192.168.1.195 (RAW 9100), but these strings do not verify the real device. A4/A3, orientation, copies, duplex and long-/short-edge binding must be preserved; shrink only, never upscale. A spooler acknowledgement does not prove paper. A lost acknowledgement / UNKNOWN job is held for human reconciliation, not automatically resent. Never force DOCX into PDF as the print source.

## Existing PDF pathway — unchanged

The established bridge and processor use PyMuPDF to rasterize representative pages, count total pages, faces and physical sheets (separate each file and copy), and write a private byte-identical PDF source, raster PNG and manifest. Core must independently anchor the exact revision/request hash/manifest SHA. The native binding validates all those bytes but cannot authorize a printer.

## New modules

1. workers/documents/native_job_binding.py: pure source/settings/manifest/preview/job verifier. Requires a Core preflight envelope with current receipt, evidence, job, approval, revision, request, lease and RMP7000 identity. Compares manifest contents, recomputes the evidence digest and PDF/Word page plan, and rejects stale or changed evidence. Word may pass evidence verification only with a current Core staff-review receipt for the same preview/evidence SHA; otherwise it stays NEEDS_HUMAN. A verified result has no print authority.

2. agents/windows/native_word_document.py: explicit privileged allow_word_launch option defaults FALSE. On Windows with pywin32 and separate authorization, opens a byte-identical private DOCX in Microsoft Word via COM DispatchEx, read-only, disables macros/links, repaginates and reads ComputeStatistics(wdStatisticPages). ExportAsFixedFormat produces only a temporary PDF for generating PNG preview with PyMuPDF; that PDF is deleted and NEVER becomes the print input. Original DOCX stays the intended Word-native print source. The module NEVER calls PrintOut, driver, spooler or RAW9100. Even after real COM render the result is REVIEW_REQUIRED because font substitution, table layout and Ricoh output have not been verified. Injected sessions are tagged injected_fake and never treated as live Word proof. COM can hang; AI0 must provide a parent watchdog/kill and private Windows session.

3. workers/documents/native_word_artifacts.py: stores a provisional private DOCX source/PNG/manifest bundle with SHA256 and processor.plan sheet-counts from Word-native reported pages. Schema ai3.native_word_preview.v1; returns REVIEW_REQUIRED and ready=false. Does not publish to Core. Fake observation is rejected unless a unit test deliberately spoofs a real-looking envelope for packaging coverage; this is NOT cryptographic attestation or live evidence.

4. agents/windows/native_queue_plan.py: compares inventory against RMP7000/Ricoh IM7000/PCL6/port, source format and the exact reviewed evidence/job tuple plus A4/A3 orientation/duplex/binding/copies. At most returns PREPARED_NOT_SENT with allowed_to_print=false, queue_submission_enabled=false and paper_verified=false. No Windows API or network calls and no fallback.

## Security and stage boundaries

- The signed-off AI0/AI1 Port must load verified private source/manifest/preview bytes with safe file handles; this pure verifier does not implement filesystem authorization.
- Bind active revision, request hash, settings hash, content SHA, manifest SHA, preview digests, approval, lease and printer to the claimed job and re-check through AI1 CAS immediately before a future send boundary.
- PDF uses original PDF; Word uses the original native DOCX, never the intermediary preview PDF. If fonts, Word installation, pagination or physical tray/duplex are uncertain => staff review and new confirmation after any changes.
- Never permit print based on a local flag or injected mock. Do not change legacy DryRun CLI, journal or one-job fake spooler.
- The current native route stops at simulation PREPARED_NOT_SENT. Physical printing still needs a separately approved authenticated staff review receipt and AI0/AI1 send/CAS/device contract; NO live printer adapter has been implemented in this branch.

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

### Staff review is required even for simulation

- `review_simulation_only` consumes only the exact internal AI1 preflight envelope and its nine-field DB receipt, evidence projection and job projection; it does not accept a client-built review dataclass, reviewer-role claim, approval ID or print flag. It requires the same shop/order/revision/request/evidence SHA, preview list, job and approval, with simulation mode and NOT_SENT state. Missing review, stale digest, changed preview, unsupported format, SENDING/UNKNOWN or different job blocks.
- The success output is PREPARED_NOT_SENT: allowed_to_simulate=true but allowed_to_print=false, queue_submission_enabled=false and physical_print_verified=false. It does not call or authorize any printer, queue, journal transition or physical retry.

### Original DOCX remains original

- native_word_document.py adds renderer_identity from Word COM app.Version when separately authorized on real Windows; injected mock is explicitly engine=injected_fake. Word raster PNG is made from a temporary preview-only Word PDF, which is deleted after use; it is never substituted for the original DOCX.
- native_word_artifacts.py includes the renderer identity in private ai3.native_word_preview.v1 manifest. Word stays REVIEW_REQUIRED, ready=false, regardless of snapshot generation.
- Synthetic unit tests intentionally spoof a COM-like envelope solely to exercise byte hashing and fail-closed simulation gating. This is NOT evidence real Word COM, Vietnamese fonts, pagination against paper, Ricoh or physical printing worked.

### AI0/AI1 integration still required

AI0 and AI1 own transactionally trusted evidence_sha256 on customer confirmation, staff approval and job, CAS at claim/preflight/mark-sending, staff review receipt authority, time-bounded isolated Windows COM, real Ricoh inventory, and reconciliation of ambiguous driver ACK. Cached SENDING/UNKNOWN never permits a second driver call. AI5 independently accepts the same integrated SHA. No real OA, Ricoh, Windows Word, merge or deployment in this PR.

## V1-NATIVE-02 — exact Core review ticket and Word/PDF preparation

- `workers.documents.print_evidence_v1` uses the same canonical JSON and SHA-256 rules as Core `checkedEvidence`: `plan_sha256 = sha(canonical(scope.plan))`, `source_set_sha256 = sha(canonical(sources))`, and `evidence_sha256 = sha(canonical(proof without evidence_sha256))`. The shared synthetic fixture `tests/unit/documents/fixtures/print_evidence_v1_core_vector.json` is the cross-language digest vector. `trusted_core_plan` must be the current server-loaded plan; hashing the local processor's richer plan is not a substitute.
- The reviewed gate consumes only the exact internal preflight envelope: top-level `allowed, job_id, revision, mode, approval_id, review_receipt, trusted_evidence, trusted_job`; receipt, evidence and job projections each have the exact field sets enforced in `workers.documents.native_job_binding`. It rejects an extra `document_evidence_verified` or other client authority field. `HttpBackendClient.preflight_native` caches only a validated ticket and binds it to the full current claim/lease identity. The ordinary claim's `approval_id` alone is never sufficient.
- `review_receipt` must be a current Core-persisted `decision='checked'` receipt for the same shop/order/revision/request/evidence SHA. `trusted_evidence` must match the locally recomputed digest, current settings/renderer/Ricoh capability hashes and ordered preview hashes; `trusted_job` must match the current job/approval and remain `mode='simulation', state='NOT_SENT'`. Missing, stale, replayed, uncertain, unsupported, or mismatched proof returns `NEEDS_HUMAN`.
- A valid PDF or reviewed DOCX reaches at most `PREPARED_NOT_SENT` / DryRun. `allowed_to_print=false`, `queue_submission_enabled=false`, and `physical_print_verified=false` stay fixed. Queue planning checks the same job/evidence tuple and rejects SENDING/UNKNOWN. It does not call Word `PrintOut`, a Windows driver/spooler, a Ricoh queue or RAW9100. A staff receipt is required before either format gets this simulated preparation result.
- Immediately before no-print queue planning, AI3 recomputes the settings, renderer and printer-capability digests against the reviewed tuple. Any post-review drift remains `NEEDS_HUMAN`; no changed settings can reuse the old review receipt.
- DOCX remains the original source. Word's temporary exported PDF is preview-only and deleted; the original DOCX hash is included in Core evidence. A fake Word preview cannot make a usable native renderer proof. A missing/uncertain font or layout review, unsupported file, changed preview, or stale customer/job revision stays with staff and cannot reuse an earlier receipt.
- Integration dependency: the AI1 authenticated internal preflight route must return the exact nested receipt/evidence/job projection above from locked current Core rows. If the candidate only returns the legacy five-field `{allowed,job_id,revision,mode,approval_id}` envelope, AI3 intentionally returns `NEEDS_HUMAN`; do not add or trust a browser/client `document_evidence_verified` flag to bypass the missing ticket. AI0/AI1 must wire this internal projection before the gate can pass in the integrated candidate.
- Validation attempted locally: `python -m compileall -q workers/documents agents/windows tests/unit/documents tests/unit/printing` PASS. `python -m pytest -q tests/unit/documents tests/unit/printing` BLOCKED because pytest is not installed in this environment; no dependency was installed or changed. Exact-SHA CI is required to execute the target tests. Actual Windows Word, fonts, Ricoh, driver, physical output, OA and deployment remain NOT RUN.

## V1-NATIVE-03 — AI1 private Word source adapter

- AI1's read-only source port contract is `WordReviewSourceV1` from `docs/architecture/V1_CORE_AGENT_EVIDENCE_CONTRACT_20261017.md` §8. Its local implementation commit `4f41a50724b3d40a3041f15bf329ebbe84c8c94` returns source/manifest anchors plus non-enumerable in-memory `private_bytes`. The port is not yet wired to an AI0 production registry or to a Python worker transport.
- `workers.documents.word_review_source_adapter.adapt_word_review_source` accepts that exact structural DTO inside the trusted server-to-worker boundary; it does not import AI1 branch code, open an artifact ref, or accept a browser/JSON request. It checks current-scope fields against the exact input manifest, canonical request hash, source byte hash/size, manifest byte hash, tenant/order/revision and same-bundle references, then passes the private original DOCX bytes to `make_word_review_artifacts`.
- The resulting `ai3.native_word_preview.v1` bundle and DTO carry the AI1 `shop_id`, `order_id`, `active_revision`, `request_hash`, original `source` metadata and `input_manifest` ref/hash. `print_evidence_v1` requires these anchors for native DOCX, binds source bytes to the Core source hash/size and still verifies its own private preview bundle and current Core plan.
- Word preview remains `REVIEW_REQUIRED`, `ready=false`, `allowed_to_print=false`, `requires_staff_review=true`. The existing receipt-gated simulation path may reach only `PREPARED_NOT_SENT`, with `queue_submission_enabled=false`. A missing snapshot/byte/manifest anchor, stale scope, drift or uncertain Word/font/layout stays `NEEDS_HUMAN`.
- The AI1 TypeScript `Uint8Array` to Python in-memory handoff and AI0 production wiring remain integration dependencies. Do not serialize `private_bytes` to a public/browser response or invent a subprocess encoding in this module. AI0 must provide a private, bounded, timeout-isolated bridge before integrated acceptance. Tests use synthetic bytes/observations only; Word COM, Windows, Ricoh, driver, RAW9100, OA and physical printing are NOT RUN.
