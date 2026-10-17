# TN011-FILE-CLEANUP-INVENTORY-01 — AI3 inventory & dry-run contract proposal

**Status:** INVENTORY DONE / DELETION BLOCKED pending AI0 lifecycle authorization.
**Read-only source:** candidate `0673460af71205986b901a21fc7724dbea23c991` (AI0 Draft PR #144), 17 October 2026.
**Ownership:** AI3 inventory/proposal only; AI0 owns retention policy, eligibility, authoritative database joins, scheduler, system paths, backup/legal hold and integration. **NO cleanup command is implemented or enabled.** No production filesystem, DB, OCR content, Windows, Ricoh or Zalo OA accessed. No schema change.

## 1. Precisely scoped inventory (source evidence, not physical disk verification)

| Class | Producer / current path pattern | Trust/DB anchor | Current inspection or cleanup | Missing for TN-011 |
| --- | --- | --- | --- | --- |
| **Inbound original / sealed synthetic upload** | `backend/composition/synthetic-ingest.ts:78-92` creates `<syntheticArtifactIngest.artifactRoot>/doc-*/source-000-<sha256>.<ext>` and `manifest.json` (`ai3.upload_snapshot.v1`), private and immutable. `AUTOIN_INPUT_ROOT` may point to this trusted input-root; **do not assume input and output roots are distinct**. | `ai0_inbound_document_artifacts` maps `(shop_id,oa_id,event_id)` to `artifact_ref,sha256,manifest_ref,manifest_sha256,created_at`; `backend/composition/inbound-draft.ts` verifies event+manifest+bytes; `source-binding.ts` checks the server-bound order/source. | Only **losing concurrent scratch directory** is removed by `synthetic-ingest.ts:110-118` when a different winning DB ref is confirmed. On DB ambiguity bytes deliberately retained. Not a retention sweep. | Need reference graph across inbound event, draft, current/older order revisions, supplement, audit/hold; cannot delete merely because status is `COMMITTED`. |
| **Processed original/snapshot** | `workers/documents/bridge.py:153-161,192-217` creates `<AUTOIN_ARTIFACT_ROOT>/doc-*/source-<index>-<sha256>.<ext>` with read-only file mode and PDF/PNG/etc from *exact* bytes; may duplicate inbound source intentionally. | `manifest.json` (`ai3.document_bridge.v1`) hashes each source and carries request/settings/page plan; `ai0_verified_plan_manifests` anchors `(shop_id,order_id,revision,request_hash,artifact_ref,manifest_sha256,created_at)`. `core_revisions.plan` refers to artifact. | `workers/documents/evidence_guard.py`, `backend/composition/approved-document-evidence.ts`, `source-binding.ts` check manifest/ref/hash and block tamper, **no time-based deletion**. | All revisions and pending/UNKNOWN/held jobs must be reconciled before any deletion; old revisions may still be needed for audit/dispute. |
| **Raster preview** | Same output `doc-*/<source-sha-prefix>-<index>-p<n>.png`, up to 3 representative frames per file, written by `workers/documents/processor.py:38-99` and enumerated in `bridge.py:218-239`. CLI `workers.documents.cli inspect --preview-dir <caller-selected>` can also write outside the main artifact root; discover these deployments separately. | Manifest `previews[].{ref,sha256,bytes}`; `backend/composition/preview.ts` checks active revision, anchor and all PNG bytes before serving staff via Fastify. `previewArtifactRoot` is an AI0-configured root, **not necessarily a second copy**. | Read-on-demand with `Cache-Control:no-store` on verified preview routes; **no file expiry sweep** or preview cache folder proved. | Need root/volume mapping, staff/open preview sessions, orphaned render directories, linked inputs and backup coverage. |
| **Intermediate render scratch** | `workers/documents/bridge.py:159-160` uses `tempfile.mkdtemp(prefix='doc-', dir=artifact_root)` *before* publish. `workers/documents/fact_inspect.py:59` uses `tempfile.TemporaryDirectory(prefix='autoin-fact-')` for local previews. | A successful render is anchored later by AI0 processor/PG; an unfinished dir may have **no** DB anchor. | `bridge.py:283-297` attempts `shutil.rmtree` on caught processing errors/timeouts; delete failure is swallowed, comment explicitly reserves cleanup for privileged worker. `TemporaryDirectory` normally cleans on context exit; crash/process kill may leave files. | No safe orphan/partial-file retention rule; do not treat `mtime`, missing manifest or absent anchor in a single query as enough to delete. |
| **OCR, image classification data** | `workers/documents/first_page_classifier.py` reads page 0/frame 0, creates transient text/OCR **in process**; local Tesseract/PyTesseract may use OS temp files during subprocess execution. `backend/composition/first-page-suggestion.ts:65-90` pipes source base64 to isolated Python over stdin. | `ai0_first_page_suggestions` persists **metadata** `(shop_id,order_id,revision,request_hash,artifact_sha256,metadata,created_at)`; current classifier JSON has categories/reasons only, no raw OCR text. | Code reviewed has **no dedicated persisted raw-OCR file/cache or expiration implementation**. This is not proof no OS temp/OCR files exist on a real host. | Inventory `TMPDIR`/worker runtime mounts, Python/Tesseract temp behavior and any future caching. Classifier metadata/SQL history needs its own policy; never copy OCR into audit records. |
| **Agent journal (exclude from customer-content expiry)** | `agents/windows/agent.py:43-68`: persistent local `--journal` SQLite with WAL/FULL, job evidence/UNKNOWN; SQLite can maintain `-wal/-shm` beside DB. | Local journal/print-job state used for crash/ACK reconciliation; **not** part of manifest/preview content expiration and not a disposable cache. | Read/recover only for authorized agent; **no retention cleanup** present. | Explicit separate AI0/AI1/owner rule; do not erase journal or `UNKNOWN` reconciliation to satisfy TN-011. |
| **Database records / event metadata (not customer file bytes)** | `zalo_inbound_events.payload_json`, `ai0_inbound_document_artifacts`, `ai0_verified_plan_manifests`, `ai0_first_page_suggestions`, `core_revisions`, source adoption receipts, `core_audit`, payment/delivery and job tables. | DB keys capture shop/OA/event/order/revision/approval references. Creation timestamps **are not** terminal-order timestamps. | No evidence of a TN-011 eligible-file deletion scheduler in this candidate; DB retains scoped provenance and transaction receipts. | Must separate 30-day *file bytes* from ~24-month operating/customer history and any regulated financial records. Never remove order/ledger rows as a side effect. |
| **Backups, replicas, browser/service-worker/cache, actual OA download storage** | No verifiable production mount map, external object storage inventory, backup lifecycle or live OA download path in this candidate. `web/public/sw.js` may cache app shell, **not evidence of a customer document cache**. | Outside AI3's source-only inventory. | **NOT VERIFIED**; absence of a repository path cannot establish deletion coverage. | AI0/infrastructure must supply live volume/blob/bucket and backup inventory, hold/restore policy, and an OS temp scan scope before any delete approval. |

### Existing deletion operations found (not a retention feature)

1. `synthetic-ingest.ts:110-118`: `rm(directory,{recursive:true,force:true})` **only for proven losing scratch dir**, preserves bytes if DB outcome uncertain.
2. `bridge.py:283-297`: `shutil.rmtree(output_dir)` on caught render failure/deadline; best-effort, may leave partial dirs.
3. `fact_inspect.py:59`: context-managed Python temporary directory, normally removed after private render facts.
4. **Not found in reviewed candidate:** scheduled sweep by 30-day lifecycle, filesystem tombstone ledger, multi-root orphan index, trash/retry state machine, backup purge policy, production cache/OCR expiry. **Do not infer absence in infrastructure external to repo.**

## 2. TN-011 eligibility: BLOCKED pending AI0's explicit authoritative contract

Business rule `docs/spec/DAC_TA_TN001-TN037.md` TN-011: delete customer original/preview/OCR/cache no later than **30 days after a validly completed or properly closed order**, subject to separately settled requirements for incomplete orders, backups, legal holds and verified deletion requests. TN-031/036 do not authorize automatic close/delivery or loss of debt history. A file's `ctime`, `mtime`, `created_at`, an old revision, `zalo_process_queue.COMMITTED` or a missing anchor does **not** demonstrate eligible age.

**Default: 0 eligible and 0 deletions.** Proposed authoritative eligibility has to be approved by AI0 and contain at least:

- Scoped immutable identity: `shop_id`, trusted `oa_id/event_id` or `order_id/revision`, `request_hash`, `artifact_ref`, `manifest_sha256`, source/preview digest; every physical byte copy deduplicated across all references.
- Proven valid terminal event and terminal timestamp from owner-approved AI1/Core semantics (e.g. completed/closed), all related active/inactive orders, open/reopened/reprint/manual jobs, pending inbound changes, `SENDING/UNKNOWN` reconciliation and existing holds evaluated.
- Retention deadline and zone explicitly defined; verified deletion request policy distinct from normal expiry; owner/role permissions; minimum period and proof-of-eligibility recorded as a server-signed/versioned snapshot.
- Source-root + output-root + previewRoot physical mapping; Windows journal, historical audit/payment/delivery, unbounded backup/replica paths and any shared-reference hardlinks excluded by default.
- SQL snapshot and filesystem state reconciled again **immediately before** any future physical operation; explicit approved concurrency/CAS and restore/dispute safeguards. No inferred removal based on a one-pass filesystem listing.

## 3. Proposed read-only dry-run interface — CONTRACT ONLY, NOT IMPLEMENTED

An AI0-owned privileged background service could expose a **staff/owner-only internal API or offline CLI**, never an unauthenticated web route, e.g.

```text
inventory_customer_files(
  mode = "dry_run",
  trusted_roots = server_config_only,
  scope = authenticated_shop,
  policy_version = "<AI0_APPROVED_VERSION>",
  cursor = optional_opaque_cursor,
  max_entries = bounded
) -> DryRunInventoryReport
```

- Before AI0 approves policy, use `policy_version="UNAPPROVED"` => all candidates `BLOCKED_POLICY_UNAPPROVED`, `eligible_count=0`, `would_delete_count=0`; **never** publish a callable delete mode by merely switching `mode`.
- Server enumerates only configured private roots with symlink/junction/mount crossing rejected; bounded per-run entries/bytes and no `realpath`-then-delete race. Never trust client-supplied local absolute paths, `ref` from webhook, or database metadata without signed scope.
- Resolve refs to DB anchors and active/inactive revisions; output **sanitized aggregate counts**, with opaque/HMAC artifact handles if needed; do not log private paths, actual filenames, OCR strings, tokens or bearer credentials.

**Example schema proposal** (fake synthetic data, no actual delete plan):
```json
{
  "schema": "tn011.cleanup_inventory.dry_run.v0",
  "mode": "dry_run",
  "policy_version": "UNAPPROVED",
  "status": "BLOCKED",
  "scan_scope": "synthetic_temp_only",
  "counters": {
    "inbound_snapshot_bundles": 1,
    "rendered_bundles": 1,
    "unanchored_candidates": 1,
    "symlink_holds": 1,
    "scanned_files": 6,
    "scanned_bytes": 563,
    "eligible_count": 0,
    "would_delete_count": 0
  },
  "reason_codes": [
    "BLOCKED_POLICY_UNAPPROVED",
    "HOLD_UNANCHORED",
    "HOLD_SYMLINK"
  ],
  "deleted_count": 0
}
```
This is **not yet** a shared API contract; exact shape, pagination, job journal, permissions and data-retention semantics require AI0 sign-off.

## 4. Proposed audit/event and retry/error model (future implementation only)

**Minimal append-only audit model** (do not create a table here): `run_id`, `operation_id`, `policy_version`, `scan_at`, trusted scope/actor/role, opaque artifact handle, `asset_class`, sanitized byte count, anchor/version fingerprints (prefer keyed HMAC, avoid exposing raw file digest), `action=DRY_RUN|HOLD|DELETE_REQUESTED|DELETE_CONFIRMED`, `reason_code`, `decision_source`, `attempt`, `result`, `error_code`, `checked_at`. Audit itself stays independent of customer-byte expiry. Store **no** original filename, full path, OCR, preview bytes, customer text, credentials, or sensitive exception string. Do not write a row that says deleted unless filesystem/object-store verification succeeded.

Proposed future **idempotent deletion** handshake (requires separate explicit authorization and an AI0-owned durable journal before coding):
1. Lock and verify a rooted physical *bundle* with SQL revision/closure/hold proof, snapshot digests, every inbound/rendered reference and backup policy; state `CANDIDATE` is **not** permission to delete. Prevent concurrent new references through approved database CAS and service lock.
2. Persist a deterministic operation identity for `(shop, physical bundle, policy version, terminal proof, digest)` and irreversible-attempt boundary. On crash, record `UNKNOWN_NEEDS_RECONCILIATION` until reread; do **not** assume file missing == success.
3. Revalidate contents, symlink/hardlink ownership, expected inode/size/hash and last reference **immediately before** any future atomic quarantine/unlink, under an explicit approved race-free filesystem contract. Never delete a shared source because one revision expired.
4. A repeated idempotency key must return the original result; a different payload with same key => `409 IDEMPOTENCY_CONFLICT`. `ENOENT` counts as complete **only** when a prior durable operation and postcondition prove the exact object was already deleted. Otherwise `HOLD_UNVERIFIED_MISSING`.
5. `EPERM/EACCES/EBUSY`, DB unavailable, network partition, mismatched hash, symlink/mount crossing, still referenced/reopened, legal hold, missing terminal timestamp or unknown Windows job => **HOLD / NEEDS_HUMAN**. Retry only a previously authorized and durably recorded idempotent step after revalidation; never treat transient errors as permission to broaden scope. On partial bundle deletion, reconcile remaining members without deleting unrelated ones.
6. Keep immutable audit + evidence of verification (counts/operation IDs), but redact customer content. Revisions, Zalo receipts, money, deliveries and Windows journal have **different** lifecycle rules; never cascade-delete them in a byte cleanup task.

## 5. Synthetic read-only inspection proof — no real data or deletion

Executed twice inside Python `tempfile.TemporaryDirectory(prefix='tn011-inventory-only-')` with only fake source/manifest/PNG-like byte signatures and:
- One `ai3.upload_snapshot.v1` inbound bundle, one `ai3.document_bridge.v1` rendered bundle, one unanchored scratch bundle, and one symlink to another synthetic directory.
- **PASS:** both dry-run enumerations produced identical classification: `1/1/1/1`, 6 files and 563 total bytes, and the **SHA-256 of every file before/after was unchanged**.
- **PASS:** `eligible_to_delete=0`, `deleted_count=0`, no write/unlink/rename; symlink categorized hold, not followed. Fixtures cleaned only by the `TemporaryDirectory` context manager *after* exercise, never any genuine input/artifact root.
- Scope of proof: one-off local synthetic read-only inventory **not** an integrated scanner, API or retention worker. No file/DB age, 30-day proof, permissions, PostgreSQL or production mounts tested.

## 6. AI0 gate before any implementation

**[AI0] TN011-LIFECYCLE-CONTRACT:** supply exact owner-approved transition to "completed/legally closed", timestamp and 30-day counting method; eligibility for unclosed/stale revisions/UNKNOWN/held or reopened orders; verified deletion-request handling, legal holds, and separate backup/replica SLA; roots/mount/ACL per site and all content-bearing caches; reference ownership and concurrency/CAS; dedup/hardlink policies; privileged agent and audit store. **DONE only once policy and DB+filesystem preconditions are signed off.**

**[AI5] TN011-INDEPENDENT-ACCEPTANCE (after AI0):** test same-SHA dry-run never mutates bytes, holds shared and orphan files, cross-shop isolation, symlink/junction/traversal, short/long age boundary, closed vs unclosed, unknown print, crash/ambiguous outcome/replay, race between new reference and cleanup, DB-down/no-credentials, backup evidence and preservation of money/audit. Real deletion and restores require separately authorized isolated test environment; **NOT RUN in this inventory**.

**Safety conclusion:** This handoff provides **inventory and a proposed contract only**. No cleanup scheduler, deletion endpoint, schema migration, retention count claiming real eligibility, real-customer file access, actual Word/Ricoh/OA execution, merge or deployment.
