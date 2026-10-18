# AI5 V1-ACCEPTANCE-20 — PDF review route audit

**Result: component and synthetic service checks PASS; PostgreSQL/HTTP route acceptance NOT RUN.** This is an audit of the exact candidate below, not full V1 acceptance or live-operation approval. One configuration gap and one private-artifact cleanup gap remain.

## Candidate and scope

- Candidate/base audited: `ceee7706186757b4147c623efc339e8af09f1ced` (`wire simulation PDF review preview route`). The AI5 branch was created directly from this commit.
- AI5 branch: `ai5/v1-acceptance-20-pdf-review-route-audit-20261018`.
- The candidate adds the simulation source reader/preview service and routes, updates the PostgreSQL route test, and adds reader tests. This report is the only AI5 file change.
- No other PR CI or newer candidate is used as evidence.

## Findings

| Area | Result | Evidence and boundary |
| --- | --- | --- |
| Source registry and provenance | **PASS — simulation code and local tests** | `createSyntheticPdfReviewSourceReader` scopes the query to configured shop/OA, registered OA, simulation mode, completed draft/order, inbound event, customer/conversation, and current revision/hash/data. It requires one match, checks direct-draft or completed AI2 adoption receipt, exact `artifact_name`, source SHA/size, upload-manifest SHA/shape/duplicate keys and private same-bundle refs. It reads source and manifest bytes from owner-only storage. Reader tests: 3/3 PASS; Core source tests: 11/11 PASS. No real Zalo media/provider path is exercised. |
| Current Core revision and hash | **PASS — Core unit/mock evidence; HTTP race NOT RUN** | `readPdfReviewSource` requires verified staff/owner, tenant-scopes the order, checks canonical hash against unchanged stored request data in a read-only READ COMMITTED transaction, calls the registered reader, and rereads the order/revision after I/O. POST checks requested revision and rereads Core after rendering; page GET rereads Core before and after reading bytes and clears the cache on errors. The Core race test is mocked; the HTTP/PostgreSQL race test is skipped. |
| Private bytes and refs | **PASS — local synthetic service check** | Core defines `private_bytes` as non-enumerable. The worker bridge receives bytes only in a server-to-local-CLI request. The HTTP DTO is built from an explicit projection containing scope, digests, flags, counts/settings and app-relative page URLs; internal source/manifest/page refs and bytes are not copied into it. A synthetic service-to-CLI run returned a review-only DTO with one PNG and no `private_bytes`/`artifact_ref` fields. This was local, non-HTTP evidence. |
| Staff page authorization and no-store | **PASS — code inspection; HTTP NOT RUN** | Both routes resolve a bearer principal. Core source reads and the legacy page fallback call `assertStaff`; the PDF page path also requests the source again under that principal. The global `onSend` hook sets `Cache-Control: no-store` for PDF POST and page GET responses, including handled errors; POST additionally sets it before authentication. No live HTTP response/header was observed because PostgreSQL was unavailable. The route test does not separately assert no-store on error responses. |
| Stale revision/race denial | **PASS — code inspection and Core mock test; route NOT RUN** | Core checks before/after private reads. POST compares current revision, raw request hash, source SHA/ref and manifest SHA after CLI work, discarding the generated bundle if stale. Cached page GET checks current source before and after the file read, then evicts on error. The PostgreSQL route test includes stale denial assertions but did not execute. |
| Bounded CLI output and ordinary cache cleanup | **PASS — code plus synthetic service check** | Node limits serialized stdin to 36 MiB, captures at most 16 KiB stdout, enforces a 120-second timeout, invokes Python without a shell, and discards stderr. The Python CLI separately limits input/output and emits one JSON line. Cache entries expire after 15 minutes and are capped at 32; replacement, stale/error, explicit clear and expiry eviction remove known private bundles. A synthetic service run verified successful projection, explicit eviction and expired-entry cleanup. Expiry pruning is demand-driven by later `find`/`remember` calls, not a background timer. |
| Forced-process cleanup | **GAP — fail-closed response, orphan risk** | On timeout or stdout overflow, Node sends `SIGKILL` and rejects without receiving an artifact ref. The Python artifact writer cleans on caught exceptions, but a killed process can bypass that cleanup after creating its `doc-*` directory. That directory is not in the cache and is not found by normal eviction. Repeated timed-out renders can therefore leave private orphan bundles; cleanup is not fully bounded. |
| Confirmation/approval/job/outbox side effects | **PASS — code inspection; database counts NOT RUN** | The PDF route reads Core source and creates a review preview; neither route nor native PDF CLI calls confirmation, approval, print-job, outbound-message, driver, spooler or network-send operations. The route test contains before/after SQL assertions for these counts, but they did not run. No database side-effect result is claimed. |
| Runtime entrypoint wiring | **BLOCKED in `backend/server.ts`** | `buildIntegratedApp` only creates the PDF source/service when `trustedPrintEvidence`, synthetic artifact ingest, and `pdfReviewArtifactRoot` are provided. The server entrypoint supplies neither `trustedPrintEvidence` nor `pdfReviewArtifactRoot`; it therefore registers the route but leaves the service unavailable, producing HTTP 503 after authentication. The working path demonstrated here is an explicitly configured simulation composition, not a running server deployment. |

## Checks at the exact candidate SHA

| Command / check | Result |
| --- | --- |
| `npm run build` | PASS |
| `npm run typecheck` | PASS |
| `node --test tests/unit/core/pdf-review-source.test.cjs` | PASS — 11/11 |
| `node --import tsx --test tests/integration/composition/pdf-review-source-reader.test.ts` | PASS — 3/3, synthetic/mocked DB |
| `python -m unittest tests.unit.documents.test_native_pdf_review -v` | PASS — 8/8, synthetic PDF |
| Synthetic `checkedPdfReviewSnapshot` → preview service → native CLI → cache clear/expiry check | PASS — local synthetic fixture; no HTTP or PostgreSQL |
| `node --import tsx --test tests/integration/composition/pdf-review-route-pg.test.mjs` | **SKIP** — `TEST_DATABASE_URL` missing. Candidate route registration probe found both the PDF POST and authenticated page GET routes; no PostgreSQL/HTTP assertions ran. |

## Limits and handoff

Zalo OA delivery/download, production runtime wiring, PostgreSQL/HTTP response and error headers, Chromium/UI, Windows, Word COM, Ricoh, paper output, and TN-037 soak remain **NOT RUN**. This candidate only implements a simulation preview route and never establishes print authority. AI0 should wire the intended simulation entrypoint when authorized and fix/contain child-process timeout artifacts before treating cache cleanup as closed. Do not call this full V1 acceptance, production readiness, or live-print evidence.
