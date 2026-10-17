"""V1-NATIVE-01: real PyMuPDF PDF bytes + synthetic DOCX/COM; never print."""
from __future__ import annotations

import hashlib
import io
import json
import zipfile
from pathlib import Path

import fitz
import pytest

from workers.documents.bridge import _canonical, process_request
from workers.documents.native_job_binding import TrustedNativeJob, verify_native_job
from workers.documents.native_word_artifacts import make_word_review_artifacts
from agents.windows.native_word_document import preview_word_native


def sha(data):
    return hashlib.sha256(data).hexdigest()


def _pdf():
    with fitz.open() as f:
        for n in range(3):
            p = f.new_page()
            p.draw_rect(fitz.Rect(25 + n, 30, 90, 120))
        return f.tobytes()


def _ready_pdf(tmp_path):
    incoming = tmp_path / "incoming"
    outgoing = tmp_path / "outgoing"
    incoming.mkdir()
    outgoing.mkdir()
    source = _pdf()
    (incoming / "fixture.pdf").write_bytes(source)
    request = {"documents": [{"artifact_name": "fixture.pdf", "copies": 2,
                              "duplex": True, "paper": "A4", "orientation": "portrait",
                              "binding": "long_edge"}]}
    result = process_request({"request_data": request,
                              "expected_request_hash": sha(_canonical(request).encode())},
                             input_root=incoming, artifact_root=outgoing)
    assert result["status"] == "READY", result
    manifest_ref = result["plan"]["artifact_ref"]
    raw = (outgoing / manifest_ref).read_bytes()
    manifest = json.loads(raw)
    source_ref = manifest["files"][0]["source_artifact_ref"]
    snapshots = (outgoing / source_ref).read_bytes()
    pngs = tuple((outgoing / p["ref"]).read_bytes() for p in manifest["previews"])
    settings = {k: v for k, v in request["documents"][0].items() if k != "artifact_name"}
    trusted = TrustedNativeJob(
        shop_id="test-shop", order_id="order-one", job_id="job-one",
        revision=2, active_revision=2,
        request_hash=result["plan"]["request_hash"],
        approval_id="approval-one", printer_id="RMP7000",
        manifest_ref=manifest_ref, manifest_sha256=sha(raw),
        source_sha256=sha(source), settings_sha256=sha(_canonical(settings).encode()),
        preview_sha256=tuple(sha(x) for x in pngs),
        lease_token="test-lease-never-real")
    job = {"shop_id": trusted.shop_id, "order_id": trusted.order_id,
           "job_id": trusted.job_id, "revision": trusted.revision,
           "request_hash": trusted.request_hash, "approval_id": trusted.approval_id,
           "printer_id": trusted.printer_id, "lease_token": trusted.lease_token,
           "mode": "simulation"}
    return trusted, job, raw, snapshots, pngs, settings


def test_pdf_source_preview_manifest_revision_and_settings_bind(tmp_path):
    trusted, job, manifest, source, previews, settings = _ready_pdf(tmp_path)
    result = verify_native_job(job, trusted, manifest_bytes=manifest,
                               source_bytes=source, previews=previews,
                               verified_settings=settings)
    assert result["status"] == "EVIDENCE_VERIFIED", result
    assert result["allowed_to_print"] is False
    assert result["document_pages"] == 3
    assert result["printed_faces"] == 6 and result["physical_sheets"] == 4
    assert result["physical_print_verified"] is False


@pytest.mark.parametrize("mutation,code", [
    ("revision", "STALE_REVISION"),
    ("job", "JOB_IDENTITY_MISMATCH"),
    ("source", "SOURCE_CHANGED"),
    ("manifest", "MANIFEST_CHANGED"),
    ("preview", "PREVIEW_CHANGED"),
    ("settings", "SETTINGS_CHANGED"),
    ("printer", "PRINTER_REQUIRES_STAFF"),
])
def test_any_changed_sealed_job_component_holds(tmp_path, mutation, code):
    from dataclasses import replace
    trusted, job, manifest, source, previews, settings = _ready_pdf(tmp_path)
    if mutation == "revision":
        trusted = replace(trusted, active_revision=3)
    if mutation == "job":
        job["approval_id"] = "other"
    if mutation == "source":
        source += b"altered"
    if mutation == "manifest":
        manifest += b" "
    if mutation == "preview":
        previews = (previews[0] + b"altered",) + previews[1:]
    if mutation == "settings":
        settings["copies"] = 3
    if mutation == "printer":
        trusted = replace(trusted, printer_id="Canon")
        job["printer_id"] = "Canon"
    result = verify_native_job(job, trusted, manifest_bytes=manifest,
                               source_bytes=source, previews=previews,
                               verified_settings=settings)
    assert (result["status"], result["reason_code"], result["allowed_to_print"]) == (
        "NEEDS_HUMAN", code, False), result


def _docx(macro=False):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        archive.writestr("[Content_Types].xml", "<Types></Types>")
        archive.writestr("word/document.xml", "<document>synthetic</document>")
        if macro:
            archive.writestr("word/vbaProject.bin", b"synthetic")
    return output.getvalue()


class FakeWordSession:
    def __init__(self):
        self.opened_bytes = None

    def __enter__(self):
        return self

    def render(self, source: Path, output_pdf: Path):
        self.opened_bytes = source.read_bytes()
        with fitz.open() as f:
            for _ in range(2):
                f.new_page()
            output_pdf.write_bytes(f.tobytes())
        return 2

    def __exit__(self, *_):
        return False


def test_word_requires_explicit_native_preflight_and_does_not_print():
    source = _docx()
    status = preview_word_native(source, expected_sha256=sha(source))
    assert (status["status"], status["reason_code"]) == (
        "NEEDS_HUMAN", "WORD_LAUNCH_NOT_AUTHORIZED")
    assert status["native_word_verified"] is False
    assert status["physical_print_verified"] is False
    status2 = preview_word_native(source, expected_sha256="0" * 64,
                                  allow_word_launch=True)
    assert status2["reason_code"] == "SOURCE_HASH_MISMATCH"


def test_fake_word_session_generates_real_preview_but_never_live_attestation():
    source = _docx()
    holder = FakeWordSession()
    result = preview_word_native(source, expected_sha256=sha(source),
                                 allow_word_launch=True, session_factory=lambda: holder)
    assert result["status"] == "REVIEW_REQUIRED", result
    assert result["document_pages"] == 2
    assert holder.opened_bytes == source  # original DOCX, not a print-converted PDF
    assert result["evidence_kind"] == "injected_fake"
    assert result["native_word_verified"] is False
    assert result["allowed_to_print"] is False
    assert result["print_source_format"] == "DOCX"
    assert len(result["preview_png"]) == 2
    assert all(blob.startswith(b"\x89PNG\r\n\x1a\n") for blob in result["preview_png"])


def test_word_fake_com_cannot_produce_verified_bundle(tmp_path):
    source = _docx()
    observation = preview_word_native(source, expected_sha256=sha(source),
                                      allow_word_launch=True, session_factory=FakeWordSession)
    data = {"documents": [{"artifact_name": "source.docx", "copies": 2,
                           "paper": "A4", "duplex": True}]}
    result = make_word_review_artifacts(
        source=source, trusted_request_data=data, revision=2,
        expected_request_hash=sha(_canonical(data).encode()), observation=observation,
        artifact_root=tmp_path)
    assert result["status"] == "NEEDS_HUMAN"
    assert result["reason_code"] == "WORD_NATIVE_EVIDENCE_UNVERIFIED"
    assert not list(tmp_path.glob("doc-*"))


def test_macro_docx_fail_closed_without_starting_com():
    source = _docx(macro=True)
    result = preview_word_native(source, expected_sha256=sha(source),
                                 allow_word_launch=True, session_factory=FakeWordSession)
    assert result["status"] == "NEEDS_HUMAN"
    assert result["reason_code"] == "DOCX_UNSAFE_OR_CORRUPT"


def test_synthetic_native_word_preview_bundle_still_requires_staff(tmp_path):
    # Synthetic trusted-looking observation only proves packaging, NOT actual COM.
    source = _docx()
    fake = preview_word_native(source, expected_sha256=sha(source),
                               allow_word_launch=True, session_factory=FakeWordSession)
    fake = {**fake, "evidence_kind": "windows_word_com_preview_only",
            "native_word_verified": True,
            # Explicit TEST-ONLY spoof of a native observation: not genuine
            # Windows/COM attestation and never usable as print authority.
            "renderer_identity": {"engine": "microsoft_word_com",
                                  "version": "synthetic-unverified"}}
    data = {"documents": [{"artifact_name": "source.docx", "copies": 2,
                           "paper": "A4", "duplex": True}]}
    result = make_word_review_artifacts(
        source=source, trusted_request_data=data, revision=2,
        expected_request_hash=sha(_canonical(data).encode()),
        observation=fake, artifact_root=tmp_path)
    assert result["status"] == "REVIEW_REQUIRED", result
    assert result["ready"] is False and result["allowed_to_print"] is False
    assert result["printed_faces"] == 4 and result["physical_sheets"] == 2
    manifest = json.loads((tmp_path / result["artifact_ref"]).read_bytes())
    assert manifest["schema"] == "ai3.native_word_preview.v1"
    assert manifest["ready"] is False
    assert manifest["revision"] == 2
    assert manifest["files"][0]["file_sha256"] == sha(source)
    assert (tmp_path / manifest["files"][0]["source_artifact_ref"]).read_bytes() == source
