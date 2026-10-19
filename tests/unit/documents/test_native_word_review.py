"""Contract and fail-closed tests for the AI0 Word source snapshot adapter."""
from __future__ import annotations

import hashlib
import io
import json
import os
from pathlib import Path
import stat
import tempfile
import zipfile

import workers.documents.native_word_review as review
from workers.documents.bridge import _canonical


def _docx() -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("[Content_Types].xml", "<Types/>")
        archive.writestr("word/document.xml", "<document/>")
    return buffer.getvalue()


def _snapshot(*, manifest_raw: bytes | None = None) -> dict:
    source = _docx()
    request = {"documents": [{"artifact_name": "source.docx", "copies": 1,
                               "duplex": False, "paper": "A4"}]}
    request_hash = hashlib.sha256(_canonical(request).encode()).hexdigest()
    source_ref, manifest_ref = "bundle-123/source.docx", "bundle-123/manifest.json"
    source_facts = {"format": "DOCX", "artifact_ref": source_ref,
                    "sha256": hashlib.sha256(source).hexdigest(), "size_bytes": len(source)}
    if manifest_raw is None:
        manifest_raw = json.dumps({"schema": "ai0.word_review_manifest.v1",
            "manifest_ref": manifest_ref, "shop_id": "shop-1", "order_id": "order-1",
            "active_revision": 7, "request_hash": request_hash, "source": source_facts},
            separators=(",", ":")).encode()
    return {"schema": "ai0.word_review_source.v1", "shop_id": "shop-1",
        "order_id": "order-1", "active_revision": 7, "request_hash": request_hash,
        "request_data": request, "source": source_facts,
        "manifest": {"ref": manifest_ref, "sha256": hashlib.sha256(manifest_raw).hexdigest()},
        "private_bytes": {"source": source, "manifest": manifest_raw}}


def _trusted_observation(source: bytes) -> dict:
    png = b"\x89PNG\r\n\x1a\nmock"
    return {"schema": "ai3.word_native_preview.v1", "status": "REVIEW_REQUIRED",
        "evidence_kind": "windows_word_com_preview_only", "native_word_verified": True,
        "physical_print_verified": False, "allowed_to_print": False,
        "source_format": "DOCX", "print_source_format": "DOCX",
        "source_sha256": hashlib.sha256(source).hexdigest(), "renderer_identity": {
            "engine": "microsoft_word_com", "version": "test-mock"},
        "document_pages": 1, "preview_png": (png,),
        "preview_sha256": (hashlib.sha256(png).hexdigest(),)}


def test_default_configuration_keeps_word_launch_disabled():
    source = _docx()
    original = review.preview_word_native
    review.preview_word_native = lambda *_args, **_kwargs: (_ for _ in ()).throw(
        AssertionError("default must not launch Word"))
    try:
        with tempfile.TemporaryDirectory() as folder:
            result = review.prepare_native_word_review_from_snapshot(
                snapshot=_snapshot(), artifact_root=folder)
            assert (result["status"], result["reason_code"]) == (
                "NEEDS_HUMAN", "WORD_LAUNCH_NOT_AUTHORIZED")
            assert result["ready"] is False and result["allowed_to_print"] is False
            assert result["requires_staff_review"] is True
            assert result["physical_print_verified"] is False
            assert list(Path(folder).iterdir()) == []
    finally:
        review.preview_word_native = original
    assert source


def test_verified_mock_bundle_repeats_all_scope_and_source_anchors():
    snapshot = _snapshot()
    source = snapshot["private_bytes"]["source"]
    original = review.preview_word_native
    review.preview_word_native = lambda *_args, **_kwargs: _trusted_observation(source)
    try:
        with tempfile.TemporaryDirectory() as folder:
            result = review.prepare_native_word_review_from_snapshot(snapshot=snapshot,
                artifact_root=folder,
                config=review.NativeWordReviewConfig(allow_word_launch=True))
            assert result["status"] == "REVIEW_REQUIRED"
            assert result["shop_id"] == "shop-1" and result["order_id"] == "order-1"
            assert result["active_revision"] == 7 and result["request_hash"] == snapshot["request_hash"]
            assert result["source"] == snapshot["source"]
            assert result["input_manifest"] == snapshot["manifest"]
            assert result["document_pages"] == 1 and result["printed_faces"] == 1
            assert result["physical_sheets"] == 1 and result["settings_sha256"]
            assert result["renderer_identity"]["engine"] == "microsoft_word_com"
            assert result["ready"] is False and result["allowed_to_print"] is False
            assert result["requires_staff_review"] is True
            assert result["physical_print_verified"] is False
            manifest = json.loads((Path(folder) / result["artifact_ref"]).read_text())
            assert manifest["shop_id"] == result["shop_id"]
            assert manifest["source"] == snapshot["source"]
            assert manifest["input_manifest"] == snapshot["manifest"]
            assert manifest["ready"] is False and manifest["allowed_to_print"] is False
    finally:
        review.preview_word_native = original


def test_word_artifacts_pass_composition_private_mode_rule_with_umask_022(tmp_path):
    snapshot = _snapshot()
    source = snapshot["private_bytes"]["source"]
    original = review.preview_word_native
    review.preview_word_native = lambda *_args, **_kwargs: _trusted_observation(source)
    previous_umask = os.umask(0o022)
    try:
        result = review.prepare_native_word_review_from_snapshot(snapshot=snapshot,
            artifact_root=tmp_path,
            config=review.NativeWordReviewConfig(allow_word_launch=True))
    finally:
        os.umask(previous_umask)
        review.preview_word_native = original

    assert result["status"] == "REVIEW_REQUIRED"
    assert result["ready"] is False and result["allowed_to_print"] is False
    bundle_dir = tmp_path / result["artifact_ref"].split("/", 1)[0]
    manifest_path = tmp_path / result["artifact_ref"]
    manifest = json.loads(manifest_path.read_bytes())
    artifact_paths = [
        manifest_path,
        tmp_path / manifest["files"][0]["source_artifact_ref"],
        *(tmp_path / preview["ref"] for preview in manifest["previews"]),
    ]

    # This mirrors composition's root/directory/file mode predicate exactly.
    assert stat.S_IMODE(tmp_path.stat().st_mode) & 0o077 == 0
    assert stat.S_IMODE(bundle_dir.stat().st_mode) & 0o077 == 0
    for path in artifact_paths:
        assert stat.S_IMODE(path.stat().st_mode) & 0o077 == 0, path.name
    assert stat.S_IMODE(manifest_path.stat().st_mode) == 0o600
    for preview in manifest["previews"]:
        assert stat.S_IMODE((tmp_path / preview["ref"]).stat().st_mode) == 0o600


def test_hash_binding_and_scope_mutations_fail_closed_before_word_launch():
    mutations = [
        lambda s: s["private_bytes"].update(source=b"changed"),
        lambda s: s.update(active_revision=8),
        lambda s: s["source"].update(sha256="0" * 64),
        lambda s: s["manifest"].update(ref="other/manifest.json"),
        lambda s: s["source"].update(artifact_ref="bundle-123/../source.docx"),
    ]
    for mutate in mutations:
        snapshot = _snapshot()
        mutate(snapshot)
        original = review.preview_word_native
        review.preview_word_native = lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("invalid source must not launch Word"))
        try:
            with tempfile.TemporaryDirectory() as folder:
                result = review.prepare_native_word_review_from_snapshot(snapshot=snapshot,
                    artifact_root=folder, config=review.NativeWordReviewConfig(allow_word_launch=True))
                assert result["status"] == "NEEDS_HUMAN"
                assert result["ready"] is False and result["allowed_to_print"] is False
                assert list(Path(folder).iterdir()) == []
        finally:
            review.preview_word_native = original


def test_duplicate_keys_and_manifest_binding_mismatch_are_rejected():
    valid = _snapshot()
    duplicate = valid["private_bytes"]["manifest"].replace(b'"schema":', b'"schema":"bad","schema":', 1)
    for raw in (duplicate, valid["private_bytes"]["manifest"].replace(b'"order-1"', b'"order-2"')):
        snapshot = _snapshot(manifest_raw=raw)
        with tempfile.TemporaryDirectory() as folder:
            result = review.prepare_native_word_review_from_snapshot(snapshot=snapshot,
                artifact_root=folder, config=review.NativeWordReviewConfig(allow_word_launch=True))
            assert result["status"] == "NEEDS_HUMAN"
            assert list(Path(folder).iterdir()) == []


def test_request_shape_without_registered_single_docx_is_held():
    for request in ({"items": [{"file": "source.docx"}]},
                    {"documents": [{"artifact_name": "other.docx"}]},
                    {"documents": [{"artifact_name": "source.docx"},
                                    {"artifact_name": "other.docx"}]}):
        snapshot = _snapshot()
        snapshot["request_data"] = request
        snapshot["request_hash"] = hashlib.sha256(_canonical(request).encode()).hexdigest()
        with tempfile.TemporaryDirectory() as folder:
            result = review.prepare_native_word_review_from_snapshot(snapshot=snapshot,
                artifact_root=folder, config=review.NativeWordReviewConfig(allow_word_launch=True))
            assert result["status"] == "NEEDS_HUMAN"
            assert list(Path(folder).iterdir()) == []


def test_timeout_malformed_and_fake_renderer_are_held():
    source = _docx()
    outcomes = [
        {"status": "NEEDS_HUMAN", "reason_code": "PROCESSING_TIMEOUT"},
        {"unexpected": "shape"},
        {"schema": "ai3.word_native_preview.v1", "status": "REVIEW_REQUIRED",
         "evidence_kind": "injected_fake", "native_word_verified": False,
         "physical_print_verified": False, "allowed_to_print": False,
         "source_format": "DOCX", "print_source_format": "DOCX",
         "source_sha256": hashlib.sha256(source).hexdigest()},
    ]
    original = review.preview_word_native
    try:
        for observation in outcomes:
            review.preview_word_native = lambda *_args, _observation=observation, **_kwargs: _observation
            with tempfile.TemporaryDirectory() as folder:
                result = review.prepare_native_word_review_from_snapshot(snapshot=_snapshot(),
                    artifact_root=folder, config=review.NativeWordReviewConfig(allow_word_launch=True))
                assert result["status"] == "NEEDS_HUMAN"
                assert result["ready"] is False and result["allowed_to_print"] is False
                assert result["requires_staff_review"] is True
                assert list(Path(folder).iterdir()) == []
    finally:
        review.preview_word_native = original
