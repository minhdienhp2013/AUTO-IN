"""V1-NATIVE-01: real PyMuPDF PDF bytes + synthetic DOCX/COM; never print."""
from __future__ import annotations

import hashlib
import io
import json
import zipfile
from dataclasses import replace
from pathlib import Path

import fitz
import pytest

from workers.documents.bridge import _canonical, process_request
from workers.documents.native_job_binding import TrustedNativeJob, verify_native_job
from workers.documents.native_word_artifacts import make_word_review_artifacts
from workers.documents.word_review_source_adapter import adapt_word_review_source
from agents.windows.native_word_document import preview_word_native
from workers.documents.print_evidence_v1 import create_print_evidence_v1
from agents.windows.native_simulation_review import review_simulation_only
from tests.unit.documents.word_review_source_fixture import source_snapshot


CAPS = {
    "printer_id": "RMP7000", "queue_name": "RMP7000",
    "driver": "Ricoh PCL6 V4", "port": "IP_192.168.1.195",
    "supports": ["A4", "A3", "duplex", "monochrome"],
}


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


def _core_plan(trusted, manifest):
    counts = manifest["counts"]
    return {
        "request_hash": trusted.request_hash,
        "physical_sheets": counts["physical_sheets"],
        "document_pages": counts["document_pages"],
        "printed_faces": counts["printed_faces"],
        "ready": True, "printer_id": trusted.printer_id,
        "artifact_ref": trusted.manifest_ref, "verified_by": "ai3.processor.v1",
    }


def _evidence_and_ticket(trusted, job, manifest_bytes, source, previews,
                         settings, *, renderer=None, capabilities=None):
    manifest = json.loads(manifest_bytes)
    context = {"shop_id": trusted.shop_id, "order_id": trusted.order_id,
               "revision": trusted.revision, "request_hash": trusted.request_hash,
               "manifest_ref": trusted.manifest_ref, "printer_id": trusted.printer_id}
    renderer = renderer or manifest.get("renderer_identity", manifest.get("renderer_versions"))
    capabilities = capabilities or CAPS
    plan = _core_plan(trusted, manifest)
    proof_args = {
        "context": context, "manifest_bytes": manifest_bytes,
        "originals": (source,), "previews": previews,
        "settings": (settings,), "trusted_core_plan": plan,
        "renderer_identity": renderer, "printer_capabilities": capabilities,
    }
    derived = create_print_evidence_v1(**proof_args)
    assert derived["status"] == "SNAPSHOT_DERIVED", derived
    snapshot = derived["snapshot"]
    trusted = replace(trusted, evidence_sha256=snapshot["evidence_sha256"])
    ticket = {
        "allowed": True, "job_id": trusted.job_id,
        "revision": trusted.revision, "mode": "simulation",
        "approval_id": trusted.approval_id,
        "review_receipt": {
            "receipt_id": "synthetic-review-receipt",
            "shop_id": trusted.shop_id, "order_id": trusted.order_id,
            "revision": trusted.revision, "request_hash": trusted.request_hash,
            "evidence_sha256": trusted.evidence_sha256,
            "reviewer_id": "synthetic-reviewer",
            "reviewed_at": "2026-10-18T10:00:00Z", "decision": "checked",
        },
        "trusted_evidence": {
            "schema": "ai0.print_evidence.v1",
            "shop_id": trusted.shop_id, "order_id": trusted.order_id,
            "revision": trusted.revision, "request_hash": trusted.request_hash,
            "evidence_sha256": trusted.evidence_sha256,
            "settings_sha256": snapshot["settings_sha256"],
            "renderer_sha256": snapshot["renderer_sha256"],
            "printer_capability_sha256": snapshot["printer_capability_sha256"],
            "preview_sha256": [item["sha256"] for item in snapshot["previews"]],
            "printer_id": trusted.printer_id,
        },
        "trusted_job": {
            "job_id": trusted.job_id, "shop_id": trusted.shop_id,
            "order_id": trusted.order_id, "revision": trusted.revision,
            "request_hash": trusted.request_hash,
            "approval_id": trusted.approval_id, "printer_id": trusted.printer_id,
            "evidence_sha256": trusted.evidence_sha256,
            "mode": "simulation", "state": "NOT_SENT",
        },
    }
    verified = verify_native_job(
        job, trusted, manifest_bytes=manifest_bytes, source_bytes=source,
        previews=previews, verified_settings=settings,
        preflight_ticket=ticket, expected_evidence=snapshot,
        trusted_core_plan=plan, renderer_identity=renderer,
        printer_capabilities=capabilities)
    return trusted, ticket, snapshot, verified, plan, renderer, capabilities


def test_pdf_source_preview_manifest_revision_and_settings_bind(tmp_path):
    trusted, job, manifest, source, previews, settings = _ready_pdf(tmp_path)
    trusted, ticket, snapshot, result, _, _, _ = _evidence_and_ticket(
        trusted, job, manifest, source, previews, settings)
    assert result["status"] == "EVIDENCE_VERIFIED", result
    assert result["allowed_to_print"] is False
    assert result["document_pages"] == 3
    assert result["printed_faces"] == 6 and result["physical_sheets"] == 4
    assert result["physical_print_verified"] is False
    prepared = review_simulation_only(
        verified_evidence=result, snapshot=snapshot,
        preflight_ticket=ticket, claimed_job=job)
    assert prepared["status"] == "PREPARED_NOT_SENT", prepared
    assert prepared["allowed_to_print"] is False
    assert prepared["queue_submission_enabled"] is False


@pytest.mark.parametrize("mutation", [
    "revision", "job", "source", "manifest", "preview", "settings",
    "renderer", "capability", "printer",
])
def test_any_changed_sealed_job_component_holds(tmp_path, mutation):
    trusted, job, manifest, source, previews, settings = _ready_pdf(tmp_path)
    trusted, ticket, snapshot, _, plan, renderer, capabilities = _evidence_and_ticket(
        trusted, job, manifest, source, previews, settings)
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
    if mutation == "renderer":
        renderer = {**renderer, "version": "different-renderer"}
    if mutation == "capability":
        capabilities = {**capabilities, "driver": "different-driver"}
    if mutation == "printer":
        trusted = replace(trusted, printer_id="Canon")
        job["printer_id"] = "Canon"
    result = verify_native_job(job, trusted, manifest_bytes=manifest,
                               source_bytes=source, previews=previews,
                               verified_settings=settings,
                               preflight_ticket=ticket, expected_evidence=snapshot,
                               trusted_core_plan=plan, renderer_identity=renderer,
                               printer_capabilities=capabilities)
    assert result["status"] == "NEEDS_HUMAN", (mutation, result)
    assert result["allowed_to_print"] is False


def test_missing_or_client_augmented_core_ticket_and_replayed_job_hold(tmp_path):
    trusted, job, manifest, source, previews, settings = _ready_pdf(tmp_path)
    trusted, ticket, snapshot, verified, plan, renderer, capabilities = _evidence_and_ticket(
        trusted, job, manifest, source, previews, settings)
    kwargs = dict(manifest_bytes=manifest, source_bytes=source, previews=previews,
                  verified_settings=settings, expected_evidence=snapshot,
                  trusted_core_plan=plan, renderer_identity=renderer,
                  printer_capabilities=capabilities)
    for bad_ticket in (None, {**ticket, "document_evidence_verified": True}):
        result = verify_native_job(job, trusted, preflight_ticket=bad_ticket, **kwargs)
        assert result["status"] == "NEEDS_HUMAN"
        assert result["allowed_to_print"] is False

    client_flagged_job = {**job, "document_evidence_verified": True}
    result = verify_native_job(client_flagged_job, trusted,
                              preflight_ticket=ticket, **kwargs)
    assert result["status"] == "NEEDS_HUMAN"
    assert result["allowed_to_print"] is False

    for state in ("SENDING", "UNKNOWN", "SIMULATED_DONE"):
        replay_ticket = json.loads(json.dumps(ticket))
        replay_ticket["trusted_job"]["state"] = state
        result = verify_native_job(job, trusted,
                                  preflight_ticket=replay_ticket, **kwargs)
        assert result["status"] == "NEEDS_HUMAN", (state, result)
        assert result["queue_submission_enabled"] is False


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


def test_reviewed_word_keeps_docx_source_and_stops_prepared_not_sent(tmp_path):
    source = _docx()
    observation = preview_word_native(
        source, expected_sha256=sha(source), allow_word_launch=True,
        session_factory=FakeWordSession)
    observation = {**observation, "evidence_kind": "windows_word_com_preview_only",
                   "native_word_verified": True,
                   "renderer_identity": {"engine": "microsoft_word_com",
                                         "version": "SYNTHETIC-NOT-REAL"}}
    request = {"documents": [{"artifact_name": "source.docx", "copies": 2,
                              "paper": "A4", "duplex": True,
                              "orientation": "portrait", "binding": "long_edge"}]}
    request_hash = sha(_canonical(request).encode())
    core_source = source_snapshot(
        source, request, shop_id="test-shop", order_id="word-order", revision=4)
    packaged = adapt_word_review_source(
        snapshot=core_source, observation=observation, artifact_root=tmp_path)
    assert packaged["status"] == "REVIEW_REQUIRED", packaged
    assert packaged["source"] == core_source["source"]
    assert packaged["input_manifest"] == core_source["manifest"]
    manifest_ref = packaged["artifact_ref"]
    manifest_bytes = (tmp_path / manifest_ref).read_bytes()
    manifest = json.loads(manifest_bytes)
    source = (tmp_path / manifest["files"][0]["source_artifact_ref"]).read_bytes()
    previews = tuple((tmp_path / item["ref"]).read_bytes()
                     for item in manifest["previews"])
    settings = {key: value for key, value in request["documents"][0].items()
                if key != "artifact_name"}
    trusted = TrustedNativeJob(
        shop_id="test-shop", order_id="word-order", job_id="word-job",
        revision=4, active_revision=4, request_hash=request_hash,
        approval_id="word-approval", printer_id="RMP7000",
        manifest_ref=manifest_ref, manifest_sha256=sha(manifest_bytes),
        source_sha256=sha(source), settings_sha256=sha(_canonical(settings).encode()),
        preview_sha256=tuple(sha(item) for item in previews),
        lease_token="synthetic-word-lease")
    job = {"shop_id": trusted.shop_id, "order_id": trusted.order_id,
           "job_id": trusted.job_id, "revision": trusted.revision,
           "request_hash": trusted.request_hash, "approval_id": trusted.approval_id,
           "printer_id": trusted.printer_id, "lease_token": trusted.lease_token,
           "mode": "simulation"}
    trusted, ticket, snapshot, verified, _, _, _ = _evidence_and_ticket(
        trusted, job, manifest_bytes, source, previews, settings)
    assert snapshot["sources"][0]["format"] == "DOCX"
    assert snapshot["sources"][0]["source_sha256"] == sha(source)
    assert verified["status"] == "EVIDENCE_VERIFIED", verified
    assert verified["native_format"] == "DOCX"
    prepared = review_simulation_only(
        verified_evidence=verified, snapshot=snapshot,
        preflight_ticket=ticket, claimed_job=job)
    assert prepared["status"] == "PREPARED_NOT_SENT", prepared
    assert prepared["source_formats"] == ("DOCX",)
    assert prepared["allowed_to_print"] is False
    assert prepared["queue_submission_enabled"] is False
