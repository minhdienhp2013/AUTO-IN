# AI5 V1-ACCEPTANCE-17 — PDF source contract / adapter / UI audit

**Result: component-level PASS on exact candidate `71a59b5bf78ebb35f8e18e99d31a0730c661c0a7`; integrated PDF review remains BLOCKED / NOT RUN. This is not V1 acceptance.** All positive results below are local synthetic/unit checks, not production or live evidence.

## Candidate and ancestry

- AI5 report branch: `ai5/v1-acceptance-17-pdf-source-audit-20261018`, created directly from candidate/base `71a59b5bf78ebb35f8e18e99d31a0730c661c0a7`.
- The candidate contains content-equivalent cherry-picks of AI1 CORE-12 `8621bfa953ae356f146f799f3465c9cb3a47095c`, AI4 QUEUE-08 `3db7a8308d38fe65bbfff39d9c663c48814742b9`, and AI3 NATIVE-12 `56f562c84547e49f1560cb68331878bfe6e2c024`. Their candidate commits are `edd3a97b98a0dd2854b7aea58105cd9f25926922`, `ae6bebb223bc91d6a086b021ed0a3cc4bab1a14d`, and `71a59b5bf78ebb35f8e18e99d31a0730c661c0a7` respectively. Each specialist commit is a sibling from merge base `c2055829606d0572a63fcd498382e03f50546f82`, not an ancestor of the candidate; matching stable patch IDs confirm the exact patches are present.
- Candidate diff from that merge base: 11 files, 1,310 insertions, 5 deletions. This report adds no product change.

## Independent findings

| Area | Result | Evidence and boundary |
| --- | --- | --- |
| AI1 Core source contract | **PASS — local unit scope only** | Contract binds shop/order/current revision/request hash, exact PDF bytes and size, manifest bytes/hash, duplicate JSON keys and safe same-bundle references. Request data is copied/frozen; the registered reader is called twice and byte drift is rejected. Staff and tenant checks run before private reads; service rereads revision after I/O and issues a read-only transaction. `private_bytes` is non-enumerable and is absent from JSON serialization. `tests/unit/core/pdf-review-source.test.cjs`: 7/7 PASS. |
| AI3 native PDF review adapter | **PASS — synthetic local unit scope only** | The synthetic PDF is checked against source/manifest anchors and request hash. Worker creates a read-only source copy and raster previews, preserves the original PDF as `print_source_format: PDF`, and returns `REVIEW_REQUIRED`; `ready=false`, `allowed_to_print=false`, staff review required, and physical-print verification false. Invalid scope/digest/size/manifest/ref, unsupported request, encrypted or uncertain-font PDF, and render failures hold as `NEEDS_HUMAN`. Worker result omits private bytes. `python -m unittest tests.unit.documents.test_native_pdf_review -v`: 7/7 PASS; `python -m compileall -q ...`: PASS. |
| AI4 PDF panel projection | **PASS — standalone render/unit scope only** | Projection enforces authenticated staff, exact shop/order/revision/request/source/manifest hashes, allowlisted DTO fields and app-relative PNG paths; mismatch/error/NOT_WIRED hides old pages. Status remains review-only and the panel has no confirmation/approval controls. `cd web && npm test`: 120/120 PASS; typecheck/build PASS. |
| Core → AI0 registry/runtime → Python bytes → PrintAgent | **BLOCKED / NOT RUN** | `TrustedPdfReviewSourceReader` is an interface; Core's `pdfSource` option is optional and returns `PDF_SOURCE_NOT_CONFIGURED` when absent. `readPdfReviewSource` has no registered HTTP route. No composition code invokes `readPdfReviewSource` or `prepare_native_pdf_review_from_snapshot`, and no JS-to-Python private-byte bridge exists in this candidate. The PostgreSQL test uses a synthetic in-memory reader and requires `TEST_DATABASE_URL`; it was skipped, so actual DB/registry/runtime behavior is NOT RUN. |
| Current preview API/UI wiring | **BLOCKED** | `PdfReviewPanel` is not imported or rendered by `web/src/App.tsx`. Existing runtime preview routes read the existing verified-plan artifact path; that verifier only accepts `ai3.document_bridge.v1` or `ai3.native_word_preview.v1`, not `ai3.native_pdf_preview.v1`, and it does not return the new `ai0.pdf_review_preview.v1` DTO. Thus the passing component tests do not prove a real API response or visible integrated PDF panel. |
| Printer and external operation | **NOT RUN** | The new PDF adapter has no printer call, `PrintOut`, RAW9100, spooler, or Ricoh send path. Chromium/API browser, PostgreSQL, Windows/PDF renderer, Ricoh, Zalo OA, customer confirmation, staff approval/print job, physical paper and TN037 soak test were not run. |

## Commands at exact candidate SHA

Ran from the AI5 worktree while its source HEAD was exactly `71a59b5bf78ebb35f8e18e99d31a0730c661c0a7`:

```text
npm run build                                      PASS
node --test tests/unit/core/pdf-review-source.test.cjs    PASS 7/7
python -m unittest tests.unit.documents.test_native_pdf_review -v  PASS 7/7
python -m compileall -q workers/documents/native_pdf_review.py workers/documents/native_pdf_artifacts.py  PASS
cd web && npm test                                 PASS 120/120
cd web && npm run typecheck                        PASS
cd web && npm run build                            PASS
node --test tests/integration/core/v1-pdf-source-pg.test.cjs  SKIP: TEST_DATABASE_URL absent
```

The repository's 58 product acceptance rows remain `NOT RUN`. These tests establish only the isolated component behavior above. **Full integrated V1 acceptance, live OA, Windows/Word/Ricoh, and actual printing remain NOT RUN. Do not use this report as a release or operations authorization.**
