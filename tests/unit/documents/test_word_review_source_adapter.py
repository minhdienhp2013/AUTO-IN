"""AI1→AI3 Word source adapter tests; all source/preview bytes are synthetic."""
from __future__ import annotations

import hashlib
import json

from tests.unit.documents.word_review_source_fixture import (
    request_data, sha, source_snapshot, synthetic_observation,
)
from workers.documents.word_review_source_adapter import adapt_word_review_source


def _docx() -> bytes:
    # Small placeholder is sufficient because the native observation is
    # synthetic and the adapter does not launch Word. It is never print-ready.
    return b"synthetic original DOCX bytes"


def test_core_word_source_becomes_section8_anchored_review_only_bundle(tmp_path):
    source = _docx()
    snapshot = source_snapshot(source)
    result = adapt_word_review_source(
        snapshot=snapshot, observation=synthetic_observation(source), artifact_root=tmp_path)

    assert result["schema"] == "ai3.native_word_preview.v1"
    assert result["status"] == "REVIEW_REQUIRED", result
    assert result["shop_id"] == snapshot["shop_id"]
    assert result["order_id"] == snapshot["order_id"]
    assert result["active_revision"] == snapshot["active_revision"]
    assert result["request_hash"] == snapshot["request_hash"]
    assert result["source"] == snapshot["source"]
    assert result["input_manifest"] == snapshot["manifest"]
    assert result["ready"] is False
    assert result["allowed_to_print"] is False
    assert result["requires_staff_review"] is True
    assert result["physical_print_verified"] is False
    assert result["document_pages"] == result["printed_faces"] == result["physical_sheets"] == 1

    output_bytes = (tmp_path / result["artifact_ref"]).read_bytes()
    assert hashlib.sha256(output_bytes).hexdigest() == result["manifest_sha256"]
    output_manifest = json.loads(output_bytes)
    for key in ("shop_id", "order_id", "active_revision", "source", "input_manifest"):
        assert output_manifest[key] == result[key]
    bundled_source = (tmp_path / output_manifest["files"][0]["source_artifact_ref"]).read_bytes()
    assert bundled_source == source


def test_adapter_rejects_source_byte_drift_and_missing_private_bytes(tmp_path):
    snapshot = source_snapshot(_docx())
    snapshot["private_bytes"]["source"] = b"changed source"
    result = adapt_word_review_source(
        snapshot=snapshot, observation=synthetic_observation(b"changed source"), artifact_root=tmp_path)
    assert result["status"] == "NEEDS_HUMAN"
    assert result["reason_code"] == "CORE_WORD_SOURCE_HASH_OR_REFERENCE_MISMATCH"
    assert result["allowed_to_print"] is False
    assert not list(tmp_path.glob("doc-*"))

    snapshot = source_snapshot(_docx())
    snapshot["private_bytes"]["manifest"] += b" "
    result = adapt_word_review_source(
        snapshot=snapshot, observation=synthetic_observation(_docx()), artifact_root=tmp_path)
    assert result["status"] == "NEEDS_HUMAN"
    assert result["reason_code"] == "CORE_WORD_SOURCE_HASH_OR_REFERENCE_MISMATCH"

    snapshot = source_snapshot(_docx())
    del snapshot["private_bytes"]
    result = adapt_word_review_source(
        snapshot=snapshot, observation=synthetic_observation(_docx()), artifact_root=tmp_path)
    assert result["reason_code"] == "CORE_WORD_SOURCE_SNAPSHOT_MISSING_OR_MALFORMED"


def test_adapter_rejects_manifest_scope_request_and_duplicate_key_drift(tmp_path):
    source = _docx()
    request = request_data()
    snapshot = source_snapshot(source, request, manifest_order_id="other-order")
    result = adapt_word_review_source(
        snapshot=snapshot, observation=synthetic_observation(source), artifact_root=tmp_path)
    assert result["reason_code"] == "CORE_WORD_SOURCE_SCOPE_OR_MANIFEST_MISMATCH"

    snapshot = source_snapshot(source, request)
    snapshot["request_data"] = {"documents": []}
    result = adapt_word_review_source(
        snapshot=snapshot, observation=synthetic_observation(source), artifact_root=tmp_path)
    assert result["reason_code"] == "CORE_WORD_SOURCE_SCOPE_OR_MANIFEST_MISMATCH"

    snapshot = source_snapshot(source, request)
    duplicate = snapshot["private_bytes"]["manifest"].decode("utf-8")
    duplicate = duplicate.replace('"schema":"ai0.word_review_manifest.v1",',
                                  '"schema":"ai0.word_review_manifest.v1","schema":"ai0.word_review_manifest.v1",')
    duplicate_bytes = duplicate.encode("utf-8")
    snapshot["private_bytes"]["manifest"] = duplicate_bytes
    snapshot["manifest"]["sha256"] = hashlib.sha256(duplicate_bytes).hexdigest()
    result = adapt_word_review_source(
        snapshot=snapshot, observation=synthetic_observation(source), artifact_root=tmp_path)
    assert result["reason_code"] == "CORE_WORD_SOURCE_MANIFEST_OR_REQUEST_INVALID"
    assert result["allowed_to_print"] is False
