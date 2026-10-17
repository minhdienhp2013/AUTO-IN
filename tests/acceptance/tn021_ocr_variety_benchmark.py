"""TN021-OCR-VARIETY-BENCHMARK-01: current AI3 classifier, synthetic-only.

From repository root with PyMuPDF/Pillow/pytesseract/Tesseract:
  PYTHONPATH=. python tests/acceptance/tn021_ocr_variety_benchmark.py --check-fixture
  PYTHONPATH=. python tests/acceptance/tn021_ocr_variety_benchmark.py \
    --require-source-blob --json-out /tmp/tn021-result.json \
    --tap-out /tmp/tn021-result.tap

Does not touch PostgreSQL, OA, DeepSeek, Windows or any print service.
Wrong predictions do NOT fail the benchmark; infrastructure/fixture errors do.
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
import os
import subprocess
from pathlib import Path
import sys
from time import perf_counter

HERE = Path(__file__).resolve()
ROOT = HERE.parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tests.fixtures.public.tn021_ocr_variety.cases import (
    CLASSES, SEED, cases, materialize, resolve_font,
)
from workers.documents.first_page_classifier import (
    SCHEMA_VERSION, classify_first_page,
)

EXPECTED_COUNTS = {
    **{label: 10 for label in CLASSES if label != "UNKNOWN"},
    "UNKNOWN": 20,
}
EXPECTED_MODES = {"text_pdf": 56, "png": 22, "scan_pdf": 22}
PREDICTIONS = (*CLASSES, "NEEDS_HUMAN", "ERROR")
BENCHMARK_NAME = "TN021-OCR-VARIETY-BENCHMARK-01"
SOURCE_HEAD = "0673460af71205986b901a21fc7724dbea23c991"
EXPECTED_CLASSIFIER_BLOB = "3334feb61a85b8663043fae076d922be05ddc3e5"
MANIFEST_PATH = ROOT / "tests/fixtures/public/tn021_ocr_variety/manifest.json"


def percentile(values, fraction):
    if not values:
        return None
    ordered = sorted(values)
    pos = (len(ordered) - 1) * fraction
    low, high = int(pos), min(len(ordered) - 1, int(pos) + 1)
    return round(ordered[low] + (ordered[high] - ordered[low]) * (pos - low), 2)


def no_leaks(result):
    # Only documented metadata may leave the classifier; no raw OCR text.
    return set(result) == {
        "schema_version", "status", "category", "confidence_label",
        "analyzed_page_count", "method", "reason_code",
    } and result["schema_version"] == SCHEMA_VERSION


def benchmark(check_fixture=False, allow_local_ocr=True, require_source_blob=False):
    import fitz
    import PIL

    dataset = cases()
    assert len(dataset) == 100 and len({c["id"] for c in dataset}) == 100
    assert dict(Counter(c["expected"] for c in dataset)) == EXPECTED_COUNTS
    assert dict(Counter(c["mode"] for c in dataset)) == EXPECTED_MODES
    declared = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    expected_manifest = [{"id": c["id"], "expected": c["expected"],
                          "mode": c["mode"], "format_hint": c["format_hint"],
                          "variant": c["variant"]} for c in dataset]
    assert declared["schema"] == "autoin.tn021.fixed_100.v1"
    assert declared["cases"] == expected_manifest, "FIXTURE_MANIFEST_MISMATCH"
    font = resolve_font()
    try:
        sha_cmd = subprocess.run(["git", "hash-object", "workers/documents/first_page_classifier.py"],
            cwd=ROOT, text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=5)
        classifier_blob = sha_cmd.stdout.strip() if sha_cmd.returncode == 0 else "UNVERIFIED_LOCAL"
    except (FileNotFoundError, subprocess.TimeoutExpired):
        classifier_blob = "UNVERIFIED_LOCAL"
    verified_blob = classifier_blob == EXPECTED_CLASSIFIER_BLOB
    if require_source_blob and not verified_blob:
        raise RuntimeError("TN021_CLASSIFIER_BLOB_NOT_EXACT_CANDIDATE")

    result = {
        "schema": "autoin.tn021.ocr_variety.v1",
        "benchmark": BENCHMARK_NAME,
        "mode": "public_synthetic_only",
        "source_product_sha": SOURCE_HEAD,
        "actual_product_commit_sha": os.getenv("TN021_PRODUCT_SHA", "NOT_VERIFIED_LOCAL"),
        "classifier_blob": classifier_blob,
        "classifier_blob_verified": verified_blob,
        "expected_candidate_classifier_blob": EXPECTED_CLASSIFIER_BLOB,
        "status": "FIXTURE_ONLY" if check_fixture else "BENCHMARK_COMPLETED",
        "classifier_schema": SCHEMA_VERSION,
        "ocr_enabled": bool(allow_local_ocr),
        "environment": {
            "python": sys.version.split()[0], "pymupdf": fitz.VersionBind,
            "pillow": PIL.__version__, "font_basename": font.name,
        },
        "n": len(dataset),
        "expected_distribution": EXPECTED_COUNTS,
        "format_distribution": EXPECTED_MODES,
        "cases": [],
    }
    matrix = {truth: {pred: 0 for pred in PREDICTIONS} for truth in CLASSES}
    method_counts, reason_counts, latencies = Counter(), Counter(), []
    seen_hashes = set()
    count_correct = 0
    start = perf_counter()

    original_load_page = fitz.Document.load_page
    for c in dataset:
        payload, sha = materialize(c, font)
        assert sha not in seen_hashes, f"duplicated source bytes: {c['id']}"
        seen_hashes.add(sha)
        assert hashlib.sha256(payload).hexdigest() == sha
        assert (payload.startswith(b"%PDF-") if c["format_hint"] == "pdf"
                else payload.startswith(b"\x89PNG"))
        row = {"id": c["id"], "expected": c["expected"], "mode": c["mode"],
               "format_hint": c["format_hint"], "source_sha256": sha,
               "source_bytes": len(payload)}
        if not check_fixture:
            def only_page_zero(doc, page=0):
                assert page == 0, "NON_FIRST_PAGE_READ"
                return original_load_page(doc, page)
            fitz.Document.load_page = only_page_zero
            started = perf_counter()
            try:
                output = classify_first_page(payload, format_hint=c["format_hint"],
                    expected_sha256=sha, allow_local_ocr=allow_local_ocr)
                assert no_leaks(output), "INVALID_CLASSIFIER_SCHEMA_OR_TEXT_LEAK"
                assert output["analyzed_page_count"] in (0, 1)
                if output["status"] == "SUGGESTED":
                    predicted = output["category"] if output["category"] in CLASSES else "ERROR"
                elif output["status"] == "UNKNOWN":
                    predicted = "UNKNOWN"
                elif output["status"] == "NEEDS_HUMAN":
                    predicted = "NEEDS_HUMAN"
                else:
                    predicted = "ERROR"
                row.update({"predicted": predicted, "status": output["status"],
                    "reason_code": output["reason_code"], "method": output["method"],
                    "confidence_label": output["confidence_label"],
                    "pages_analyzed": output["analyzed_page_count"]})
                method_counts[output["method"]] += 1
                reason_counts[output["reason_code"]] += 1
            except Exception as exc:
                # Failure class only, no OCR/customer content or stack details.
                predicted = "ERROR"
                row.update({"predicted": predicted, "status": "ERROR",
                    "reason_code": type(exc).__name__, "method": "not_run",
                    "confidence_label": "none", "pages_analyzed": 0})
                reason_counts["BENCHMARK_CLASSIFIER_EXCEPTION"] += 1
            finally:
                fitz.Document.load_page = original_load_page
            latency = round((perf_counter() - started) * 1000, 2)
            row["latency_ms"] = latency
            latencies.append(latency)
            matrix[c["expected"]][predicted] += 1
            count_correct += predicted == c["expected"]
        result["cases"].append(row)
        if (len(result["cases"]) % 20) == 0:
            print(f"TN021_PROCESSED {len(result['cases'])}/100", file=sys.stderr)

    assert len(seen_hashes) == 100
    result["distinct_sha256"] = len(seen_hashes)
    result["elapsed_seconds"] = round(perf_counter() - start, 2)
    if not check_fixture:
        per_class = {}
        for label in CLASSES:
            tp = matrix[label][label]
            actual_total = sum(matrix[label].values())
            pred_total = sum(matrix[truth][label] for truth in CLASSES)
            per_class[label] = {
                "support": actual_total,
                "correct": tp,
                "recall": round(tp / actual_total, 4),
                "precision": round(tp / pred_total, 4) if pred_total else None,
            }
        by_mode = {}
        for mode in EXPECTED_MODES:
            subset = [r for r in result["cases"] if r["mode"] == mode]
            by_mode[mode] = {"n": len(subset),
                "correct": sum(x["predicted"] == x["expected"] for x in subset)}
        result.update({
            "confusion_matrix": matrix,
            "per_class": per_class,
            "overall": {"correct": count_correct, "incorrect": 100 - count_correct,
                        "accuracy": round(count_correct / 100, 4)},
            "by_mode": by_mode,
            "reason_codes": dict(sorted(reason_counts.items())),
            "methods": dict(sorted(method_counts.items())),
            "latency_ms": {"p50": percentile(latencies, .5),
                           "p95": percentile(latencies, .95),
                           "max": max(latencies)},
            "misclassifications": [
                {"id": r["id"], "expected": r["expected"],
                 "predicted": r["predicted"], "reason_code": r["reason_code"],
                 "mode": r["mode"]}
                for r in result["cases"] if r["expected"] != r["predicted"]],
        })
    return result


def main():
    parser = argparse.ArgumentParser(description=BENCHMARK_NAME)
    parser.add_argument("--check-fixture", action="store_true")
    parser.add_argument("--require-source-blob", action="store_true",
                        help="Require classifier Git blob to equal the audited PR144 source blob")
    parser.add_argument("--no-local-ocr", action="store_true",
                        help="Fail-closed OCR-unavailable baseline, not a real OCR score")
    parser.add_argument("--json-out", type=Path)
    parser.add_argument("--tap-out", type=Path)
    args = parser.parse_args()
    try:
        report = benchmark(args.check_fixture, not args.no_local_ocr, args.require_source_blob)
    except Exception as exc:
        print(f"TN021_INFRA_FAIL {type(exc).__name__}", file=sys.stderr)
        return 2
    report_json = json.dumps(report, ensure_ascii=False, sort_keys=True,
                             indent=2) + "\n"
    if args.json_out:
        args.json_out.parent.mkdir(parents=True, exist_ok=True)
        args.json_out.write_text(report_json, encoding="utf-8")
    tap = ("TAP version 13\n"
           "ok 1 - TN021 100 deterministic synthetic first-page fixtures and 100 distinct source SHA\n"
           "1..1\n" if args.check_fixture else
           "TAP version 13\n"
           "ok 1 - TN021 benchmark completed with 100 classifier invocations; "
           "NOT a classifier-accuracy PASS\n1..1\n")
    tap += "TN021_JSON " + json.dumps(report, ensure_ascii=False,
                                        separators=(",", ":")) + "\n"
    if args.tap_out:
        args.tap_out.parent.mkdir(parents=True, exist_ok=True)
        args.tap_out.write_text(tap, encoding="utf-8")
    print(tap)
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
