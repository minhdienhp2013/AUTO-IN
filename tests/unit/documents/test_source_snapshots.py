"""P0 regression: source printed must be exactly the bytes verified by AI3."""
import hashlib
import json
from pathlib import Path
import os
import zipfile

import fitz
from PIL import Image

from workers.documents.bridge import _canonical, process_request


def _roots(tmp_path):
    source, published = tmp_path / "inbox", tmp_path / "private-artifacts"
    source.mkdir()
    published.mkdir()
    return source, published


def _request(documents):
    request_data = {"documents": documents}
    return {
        "request_data": request_data,
        "expected_request_hash": hashlib.sha256(
            _canonical(request_data).encode("utf-8")).hexdigest(),
    }


def _pdf(path, pages=3):
    with fitz.open() as pdf:
        for _ in range(pages):
            page = pdf.new_page()
            page.draw_rect(fitz.Rect(30, 30, 140, 140))
        pdf.save(path)


def _manifest(public_root, result):
    return json.loads((public_root / result["plan"]["artifact_ref"]).read_text())


def test_snapshot_is_verified_unchanged_even_if_inbox_mutates(tmp_path):
    source, published = _roots(tmp_path)
    original = source / "customer.pdf"
    _pdf(original)
    contents = original.read_bytes()
    request = _request([{"artifact_name": "customer.pdf", "copies": 3, "duplex": True}])
    result = process_request(request, input_root=source, artifact_root=published)
    assert result["status"] == "READY", result
    manifest = _manifest(published, result)
    evidence = manifest["files"][0]
    assert (result["plan"]["physical_sheets"], evidence["physical_sheets"]) == (6, 6)
    snapshot = published / evidence["source_artifact_ref"]
    assert snapshot.read_bytes() == contents
    assert evidence["file_sha256"] == hashlib.sha256(contents).hexdigest()
    assert evidence["size_bytes"] == len(contents)
    assert "customer.pdf" not in str(snapshot)
    assert snapshot.stat().st_mode & 0o222 == 0

    # A second customer upload to the same inbox path is NOT the approved file.
    _pdf(original, pages=1)
    assert original.read_bytes() != contents
    assert snapshot.read_bytes() == contents
    assert hashlib.sha256(snapshot.read_bytes()).hexdigest() == evidence["file_sha256"]


def test_snapshot_manifest_hash_is_location_independent(tmp_path):
    source, published = _roots(tmp_path)
    Image.new("RGB", (320, 480), "white").save(source / "photo.png")
    request = _request([{"artifact_name": "photo.png", "paper": "A4"}])
    first = process_request(request, input_root=source, artifact_root=published)
    second = process_request(request, input_root=source, artifact_root=published)
    assert first["status"] == second["status"] == "READY"
    assert first["content_settings_sha256"] == second["content_settings_sha256"]
    a = _manifest(published, first)["files"][0]
    b = _manifest(published, second)["files"][0]
    assert a["source_artifact_ref"] != b["source_artifact_ref"]
    assert a["file_sha256"] == b["file_sha256"]
    assert (published / a["source_artifact_ref"]).read_bytes() == (
        published / b["source_artifact_ref"]).read_bytes()


def test_zip_sources_are_individual_immutable_artifacts(tmp_path):
    source, published = _roots(tmp_path)
    _pdf(source / "one.pdf", pages=3)
    payload = (source / "one.pdf").read_bytes()
    with zipfile.ZipFile(source / "docs.zip", "w") as archive:
        archive.writestr("one.pdf", payload)
        archive.writestr("two.pdf", payload)
    result = process_request(
        _request([{"artifact_name": "docs.zip", "duplex": True}]),
        input_root=source, artifact_root=published)
    assert result["status"] == "READY", result
    manifest = _manifest(published, result)
    assert len(manifest["files"]) == 2
    assert result["plan"]["physical_sheets"] == 4
    a, b = manifest["files"]
    assert a["source_artifact_ref"] != b["source_artifact_ref"]
    for evidence in (a, b):
        assert (published / evidence["source_artifact_ref"]).read_bytes() == payload


def test_storage_failure_never_publishes_unverified_plan(tmp_path, monkeypatch):
    source, published = _roots(tmp_path)
    Image.new("RGB", (320, 480), "white").save(source / "image.png")
    request = _request([{"artifact_name": "image.png"}])

    def disk_error(_fd):
        raise OSError("synthetic disk failure: sensitive pathname")

    monkeypatch.setattr(os, "fsync", disk_error)
    result = process_request(request, input_root=source, artifact_root=published)
    assert result["status"] == "NEEDS_HUMAN"
    assert result["reason_code"] == "PROCESSOR_UNVERIFIED"
    assert "plan" not in result
    assert not list(published.iterdir())


def test_total_source_volume_is_limited_before_snapshot(tmp_path, monkeypatch):
    from workers.documents import processor
    source, published = _roots(tmp_path)
    Image.new("RGB", (320, 480), "white").save(source / "large.png")
    monkeypatch.setattr(processor, "MAX_ARCHIVE", 8)
    result = process_request(
        _request([{"artifact_name": "large.png"}]),
        input_root=source, artifact_root=published)
    assert result["status"] == "NEEDS_HUMAN"
    assert result["reason_code"] == "ARTIFACT_TOTAL_TOO_LARGE"
    assert not list(published.iterdir())
