# TN021-OCR-VARIETY-BENCHMARK-01 — Vietnamese first-page synthetic variety

**Implementation DONE; local exploratory run DONE; exact candidate classifier-blob-verified run NOT RUN. V1 BLOCKED.**

This is deliberately difficult synthetic diagnostic data, NOT TN037 evidence and NOT classifier accuracy on 100 real documents.

## Provenance, fixed labels and coverage

- Created from candidate PR144 exactly at 0673460af71205986b901a21fc7724dbea23c991. Source workers/documents/first_page_classifier.py unchanged, Git blob 3334feb61a85b8663043fae076d922be05ddc3e5. No product, CI, OA, worker, schema or print changes.
- Manifest tests/fixtures/public/tn021_ocr_variety/manifest.json pins 100 synthetic examples: 8 supported classes (WORKSHEET, EXAM, APPLICATION_FORM, CONTRACT_MINUTES, LESSON_PLAN, CV_PROFILE, ADMINISTRATIVE, GENERAL_DOCUMENT) with 10 each and UNKNOWN with 20. Modes: 56 extractable-text PDFs, 22 PNG scans, 22 raster-PDF scans. Source bytes are generated on demand and each of the 100 gets a distinct SHA-256 within the run. No real customer content.
- Diversity: accented Vietnamese, varying structure/wording, prefixes/punctuation, quoted examples, cover pages, dual-class ambiguous headings, minor rotation/blur and 10 second-page decoys. Some title variants are semantically recognizable to humans but not to rigid regular expressions; these are intentionally included to expose false negatives. UNKNOWN is a valid ground-truth class. All category labels were fixed before predictions.
- Uses locally installed Unicode TTF font (set TN021_FONT), embeds it in generated PDFs but does not commit/distribute font binaries. PDFs use no_new_id=True to avoid randomly changing source identifiers, and all 100 output hashes are rechecked for distinctness. Different fonts, renderers and OCR language packs can change bytes/results: source hashes are verified within-run rather than pinned cross-machine.
- The test-only runner tests classifier output schema (no raw text), SHA of actual source bytes and first-page-only reading. Exports full confusion matrix with classes UNKNOWN, NEEDS_HUMAN and ERROR; errors, methods, per-case result (id/hash/no raw OCR), latency p50/p95/max and per-mode scores. Wrong predictions are recorded, not treated as a benchmark execution failure.

## Exact-source commands for an AI0 audit run (NOT RUN in remote CI)

Run from an isolated checkout of this new branch, including the unchanged candidate AI3 classifier file:

    python -m pip install -r workers/documents/requirements-test.txt
    # Install local Tesseract and vie+eng language packs independently, never call a cloud OCR provider.
    export TN021_PRODUCT_SHA="$(git rev-parse HEAD)"
    PYTHONPATH=. python tests/acceptance/tn021_ocr_variety_benchmark.py --check-fixture --require-source-blob
    PYTHONPATH=. python tests/acceptance/tn021_ocr_variety_benchmark.py --require-source-blob --json-out /tmp/tn021-result.json --tap-out /tmp/tn021-result.tap
    PYTHONPATH=. python tests/acceptance/tn021_ocr_variety_benchmark.py --require-source-blob --no-local-ocr --json-out /tmp/tn021-no-ocr-result.json

Strict source guard --require-source-blob requires git hash-object workers/documents/first_page_classifier.py to equal 3334feb61a85b8663043fae076d922be05ddc3e5. Fixture check PASS validates the manifest and 100 SHA, NOT classification accuracy. TAP ok 1 means the benchmark finished, never that every classification is correct.

## Local exploratory benchmark — NOT exact-source-certified

On 17 October 2026 a local semantic mirror of the candidate classifier was invoked with the same classifier contract and 100 synthetic input pages, Python 3.13.5, PyMuPDF 1.26.7, Pillow 12.3.0, Tesseract local vie+eng, Unicode DejaVuSans.ttf. No provider, PostgreSQL, printer or live OA. The local environment lacked a byte-verified checkout: classifier_blob_verified=false and actual_product_commit_sha=NOT_VERIFIED_LOCAL. Thus this is **exploratory only**; candidate exact-SHA classifier result remains **NOT RUN** until the committed runner executes against the true source blob.

Local score: **64/100 correct (64%); 36/100 incorrect**. With OCR disabled: **48/100 correct**, illustrating how this synthetic set depends on local OCR. Neither number is a real-world OCR accuracy estimate.

### Full local confusion matrix

Rows are human-intended ground truth and columns are classifier predictions.

| Truth / prediction | WORKSHEET | EXAM | APPLICATION_FORM | CONTRACT_MINUTES | LESSON_PLAN | CV_PROFILE | ADMINISTRATIVE | GENERAL_DOCUMENT | UNKNOWN | NEEDS_HUMAN | ERROR |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| WORKSHEET | 6 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 4 | 0 | 0 |
| EXAM | 0 | 6 | 0 | 0 | 0 | 0 | 0 | 0 | 4 | 0 | 0 |
| APPLICATION_FORM | 0 | 0 | 6 | 0 | 0 | 0 | 0 | 0 | 4 | 0 | 0 |
| CONTRACT_MINUTES | 0 | 0 | 0 | 6 | 0 | 0 | 0 | 0 | 4 | 0 | 0 |
| LESSON_PLAN | 0 | 0 | 0 | 0 | 6 | 0 | 0 | 0 | 4 | 0 | 0 |
| CV_PROFILE | 0 | 0 | 0 | 0 | 0 | 6 | 0 | 0 | 4 | 0 | 0 |
| ADMINISTRATIVE | 0 | 0 | 0 | 0 | 0 | 0 | 6 | 0 | 4 | 0 | 0 |
| GENERAL_DOCUMENT | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 6 | 4 | 0 | 0 |
| UNKNOWN | 4 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 16 | 0 | 0 |

**Errors:** 32 supported-class documents fell back to UNKNOWN (four in every supported category) when titles included punctuation or synonyms. Four UNKNOWN pages were incorrectly assigned WORKSHEET, because quoted examples within a document were mistaken for its actual headline. Reason codes: NONE 52; COVER_OR_INSUFFICIENT_EVIDENCE 44; AMBIGUOUS_CONTENT 4. No OCR_TIMEOUT or OCR_FAILED was observed in this synthetic local run: it cannot rule out timeouts/failures on real scans.

| Generated format | Locally correct | Notes |
|---|---:|---|
| Native-text Vietnamese PDF | 36/56 | Unicode embedded; some misleading second pages |
| PNG requiring local OCR | 14/22 | Small blur/rotation on selected pages |
| Raster PDF requiring local OCR | 14/22 | Tesseract vie+eng |
| TOTAL | **64/100** | Not a release/operational accuracy score |

Approximate per-case classifier latency in the final local exploratory run: p50 **8.52 ms**, p95 **503.11 ms**, max **641.34 ms**; approximately **29.72 seconds** total including fixture generation. Host-specific and not an API/worker or printer SLA.

## PASS/FAIL/SKIP/NOT RUN and follow-up

- **PASS**: local 100-case fixture generation, pinned ID→label/mode mapping, 100 unique source hashes, local benchmark command completing and confusion-matrix accounting (benchmarked local classifier mirror).
- **FAIL (classification, not test harness)**: 36/100 local expected labels not matched, explicitly retained above. This does not claim V1 FAIL or release threshold not met; there is no validated production threshold here.
- **SKIP**: none during local benchmark with Tesseract; an OCR-disabled baseline was run separately, not silently substituted for OCR evidence.
- **NOT RUN**: exact classifier Git-blob-certified benchmark on candidate branch/CI; AI3 bounded subprocess integration; 100 actual Vietnamese customer documents; real camera glare/handwriting; provider OA and DeepSeek; Ricoh/Windows real printing; Safari iPhone; TN037 ≥210 real jobs/≥7 days.
- **AI0** should run the exact strict-source commands on the merged candidate SHA (and publish JSON/TAP + environment), and separately assign title-synonym/punctuation and quoted-heading false positives to AI3 if desired. AI5 must not repair product classifier as part of this benchmark. No merge, deploy, OA or real printing. **V1 remains BLOCKED**.
