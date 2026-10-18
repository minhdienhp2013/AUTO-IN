"""Fail-closed tests for the internal Word review orchestrator.

Fakes below model only denied/timeout paths. They never impersonate a real
Microsoft Word renderer and cannot establish a successful Word artifact.
"""
from __future__ import annotations

import hashlib
import io
from pathlib import Path
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


def _request() -> tuple[dict, str]:
    data = {"documents": [{"artifact_name": "order.docx", "copies": 1,
                           "duplex": False, "paper": "A4"}]}
    return data, hashlib.sha256(_canonical(data).encode("utf-8")).hexdigest()


def _call(source: bytes, root: Path, *, config=None, request_hash=None):
    data, calculated_hash = _request()
    return review.prepare_native_word_review(
        source=source, expected_source_sha256=hashlib.sha256(source).hexdigest(),
        trusted_request_data=data,
        expected_request_hash=request_hash or calculated_hash,
        revision=7, artifact_root=root, config=config)


def test_default_configuration_keeps_word_launch_disabled():
    source = _docx()
    source_before = bytes(source)
    with tempfile.TemporaryDirectory() as folder:
        result = _call(source, Path(folder))
        assert (result["status"], result["reason_code"]) == (
            "NEEDS_HUMAN", "WORD_LAUNCH_NOT_AUTHORIZED")
        assert result["ready"] is False
        assert result["allowed_to_print"] is False
        assert result["requires_staff_review"] is True
        assert result["physical_print_verified"] is False
        assert list(Path(folder).iterdir()) == []
    assert source == source_before


def test_timeout_from_public_preview_is_held_and_source_remains_unchanged():
    source = _docx()
    source_before = bytes(source)
    original = review.preview_word_native
    review.preview_word_native = lambda *_args, **_kwargs: {
        "status": "NEEDS_HUMAN", "reason_code": "PROCESSING_TIMEOUT"}
    try:
        with tempfile.TemporaryDirectory() as folder:
            result = _call(source, Path(folder),
                           config=review.NativeWordReviewConfig(allow_word_launch=True))
            assert (result["status"], result["reason_code"]) == (
                "NEEDS_HUMAN", "PROCESSING_TIMEOUT")
            assert result["allowed_to_print"] is False
            assert result["requires_staff_review"] is True
            assert list(Path(folder).iterdir()) == []
    finally:
        review.preview_word_native = original
    assert source == source_before


def test_injected_fake_renderer_is_rejected_without_bundle():
    source = _docx()
    source_before = bytes(source)
    original = review.preview_word_native
    # This is deliberately labeled injected_fake; never a fake Microsoft Word
    # identity or successful preview evidence.
    review.preview_word_native = lambda *_args, **_kwargs: {
        "schema": "ai3.word_native_preview.v1",
        "status": "REVIEW_REQUIRED",
        "reason_code": "WORD_FONT_AND_LAYOUT_STAFF_REVIEW_REQUIRED",
        "evidence_kind": "injected_fake",
        "native_word_verified": False,
        "physical_print_verified": False,
        "allowed_to_print": False,
        "source_format": "DOCX",
        "print_source_format": "DOCX",
        "source_sha256": hashlib.sha256(source).hexdigest(),
        "renderer_identity": {"engine": "injected_fake", "version": "not_run"},
        "document_pages": 1,
        "preview_png": (b"fake-png",),
        "preview_sha256": ("0" * 64,),
    }
    try:
        with tempfile.TemporaryDirectory() as folder:
            result = _call(
                source, Path(folder),
                config=review.NativeWordReviewConfig(allow_word_launch=True))
            assert (result["status"], result["reason_code"]) == (
                "NEEDS_HUMAN", "WORD_NATIVE_EVIDENCE_UNVERIFIED")
            assert result["ready"] is False
            assert result["allowed_to_print"] is False
            assert result["requires_staff_review"] is True
            assert list(Path(folder).iterdir()) == []
    finally:
        review.preview_word_native = original
    assert source == source_before


def test_source_hash_mismatch_does_not_call_preview():
    source = _docx()
    original = review.preview_word_native
    review.preview_word_native = lambda *_args, **_kwargs: (_ for _ in ()).throw(
        AssertionError("preview must not start for a changed source"))
    try:
        with tempfile.TemporaryDirectory() as folder:
            data, request_hash = _request()
            result = review.prepare_native_word_review(
                source=source, expected_source_sha256="0" * 64,
                trusted_request_data=data, expected_request_hash=request_hash,
                revision=7, artifact_root=folder,
                config=review.NativeWordReviewConfig(allow_word_launch=True))
            assert (result["status"], result["reason_code"]) == (
                "NEEDS_HUMAN", "SOURCE_HASH_MISMATCH")
            assert result["allowed_to_print"] is False
            assert list(Path(folder).iterdir()) == []
    finally:
        review.preview_word_native = original


def test_word_worker_exception_fails_closed():
    source = _docx()
    original = review.preview_word_native
    review.preview_word_native = lambda *_args, **_kwargs: (_ for _ in ()).throw(
        RuntimeError("private worker detail"))
    try:
        with tempfile.TemporaryDirectory() as folder:
            result = _call(source, Path(folder),
                           config=review.NativeWordReviewConfig(allow_word_launch=True))
            assert (result["status"], result["reason_code"]) == (
                "NEEDS_HUMAN", "WORD_PREVIEW_UNAVAILABLE")
            assert result["allowed_to_print"] is False
            assert result["requires_staff_review"] is True
            assert list(Path(folder).iterdir()) == []
    finally:
        review.preview_word_native = original


def test_malformed_preview_response_is_held_without_artifacts():
    source = _docx()
    original = review.preview_word_native
    review.preview_word_native = lambda *_args, **_kwargs: {"unexpected": "shape"}
    try:
        with tempfile.TemporaryDirectory() as folder:
            result = _call(source, Path(folder),
                           config=review.NativeWordReviewConfig(allow_word_launch=True))
            assert (result["status"], result["reason_code"]) == (
                "NEEDS_HUMAN", "WORD_PREVIEW_UNVERIFIED")
            assert result["allowed_to_print"] is False
            assert result["requires_staff_review"] is True
            assert list(Path(folder).iterdir()) == []
    finally:
        review.preview_word_native = original


def test_request_hash_mismatch_is_held_before_word_launch():
    source = _docx()
    original = review.preview_word_native
    review.preview_word_native = lambda *_args, **_kwargs: (_ for _ in ()).throw(
        AssertionError("preview must not start for a mismatched request"))
    try:
        with tempfile.TemporaryDirectory() as folder:
            result = _call(source, Path(folder), request_hash="0" * 64,
                           config=review.NativeWordReviewConfig(allow_word_launch=True))
            assert (result["status"], result["reason_code"]) == (
                "NEEDS_HUMAN", "REQUEST_HASH_MISMATCH")
            assert result["allowed_to_print"] is False
            assert result["requires_staff_review"] is True
            assert list(Path(folder).iterdir()) == []
    finally:
        review.preview_word_native = original
