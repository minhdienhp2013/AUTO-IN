"""AI0 evidence tuple, source bytes and staff-review simulation: SYNTHETIC ONLY."""
from dataclasses import replace
import hashlib
import json

import pytest

from workers.documents.print_evidence_v1 import (
    create_print_evidence_v1, verify_print_evidence_v1,
)
from agents.windows.native_simulation_review import (
    TrustedStaffReview, review_simulation_only,
)
from tests.unit.documents.test_native_word_pdf_v1 import (
    _ready_pdf, _docx, FakeWordSession, sha,
)
from agents.windows.native_word_document import preview_word_native
from workers.documents.native_word_artifacts import make_word_review_artifacts
from workers.documents.bridge import _canonical


CAPS = {
    "printer_id": "RMP7000", "queue_name": "RMP7000",
    "driver": "Ricoh PCL6 V4", "port": "IP_192.168.1.195",
    "supports": ["A4", "A3", "duplex", "monochrome"],
}


def _pdf_inputs(tmp_path):
    trusted, job, manifest_bytes, source, previews, settings = _ready_pdf(tmp_path)
    manifest = json.loads(manifest_bytes)
    context = {
        "shop_id": trusted.shop_id, "order_id": trusted.order_id,
        "revision": trusted.revision, "request_hash": trusted.request_hash,
        "manifest_ref": trusted.manifest_ref, "printer_id": trusted.printer_id,
    }
    args = dict(context=context, manifest_bytes=manifest_bytes,
                originals=(source,), previews=previews, settings=(settings,),
                renderer_identity=manifest["renderer_versions"],
                printer_capabilities=CAPS)
    return args, trusted, job


def _approved_snapshot(tmp_path):
    args, trusted, job = _pdf_inputs(tmp_path)
    observed = create_print_evidence_v1(**args)
    assert observed["status"] == "SNAPSHOT_DERIVED", observed
    assert observed["allowed_to_print"] is False
    snapshot = observed["snapshot"]
    verified = verify_print_evidence_v1(
        expected=snapshot, trusted_evidence_sha256=snapshot["evidence_sha256"],
        active_revision=trusted.active_revision, **args)
    assert verified["status"] == "EVIDENCE_VERIFIED", verified
    return args, trusted, job, snapshot, verified


def _review(trusted, snapshot):
    return TrustedStaffReview(
        shop_id=trusted.shop_id, order_id=trusted.order_id,
        revision=trusted.revision, request_hash=trusted.request_hash,
        evidence_sha256=snapshot["evidence_sha256"],
        settings_sha256=snapshot["settings_sha256"],
        renderer_sha256=snapshot["renderer_sha256"],
        printer_capability_sha256=snapshot["printer_capability_sha256"],
        preview_sha256=tuple(p["sha256"] for p in snapshot["previews"]),
        approval_id=trusted.approval_id, job_id=trusted.job_id,
        reviewer_id="synthetic-staff-reviewer", reviewer_role="staff",
        reviewed_at="2026-10-17T10:00:00Z",
        decision="STAFF_PREVIEW_CONFIRMED",
    )


def _job(job, snapshot):
    return {**job, "evidence_sha256": snapshot["evidence_sha256"],
            "state": "NOT_SENT"}


def test_pdf_exact_tuple_core_anchor_and_staff_review_allows_simulation_only(tmp_path):
    args, trusted, job, snapshot, verified = _approved_snapshot(tmp_path)
    assert snapshot["schema"] == "ai0.print_evidence.v1"
    assert snapshot["sources"][0]["format"] == "PDF"
    assert snapshot["sources"][0]["source_sha256"] == sha(args["originals"][0])
    assert snapshot["manifest_sha256"] == sha(args["manifest_bytes"])
    assert snapshot["settings_sha256"] == sha(_canonical(list(args["settings"])).encode())
    assert snapshot["source_set_sha256"] == sha(_canonical(snapshot["sources"]).encode())
    assert snapshot["printer_capability_sha256"] == sha(_canonical(CAPS).encode())
    assert verified["allowed_to_simulate"] is False
    ok = review_simulation_only(
        verified_evidence=verified, snapshot=snapshot,
        review=_review(trusted, snapshot), trusted_job=_job(job, snapshot))
    assert ok["status"] == "SIMULATION_ONLY_REVIEW_CONFIRMED", ok
    assert ok["allowed_to_simulate"] is True
    assert ok["allowed_to_print"] is False
    assert ok["queue_submission_enabled"] is False
    assert ok["physical_print_verified"] is False


@pytest.mark.parametrize("mutation", [
    "source", "manifest", "preview", "settings", "renderer", "capability",
    "revision", "printer", "order",
])
def test_each_changed_byte_or_tuple_member_invalidates_core_anchor(tmp_path, mutation):
    args, trusted, job, snapshot, _ = _approved_snapshot(tmp_path)
    modified = dict(args)
    if mutation == "source":
        modified["originals"] = (args["originals"][0] + b"one byte",)
    elif mutation == "manifest":
        modified["manifest_bytes"] = args["manifest_bytes"] + b" "
    elif mutation == "preview":
        modified["previews"] = (args["previews"][0] + b"one byte",) + args["previews"][1:]
    elif mutation == "settings":
        modified["settings"] = ({**args["settings"][0], "copies": 3},)
    elif mutation == "renderer":
        modified["renderer_identity"] = {**args["renderer_identity"], "pymupdf": "different"}
    elif mutation == "capability":
        modified["printer_capabilities"] = {**CAPS, "driver": "changed"}
    else:
        ctx = dict(args["context"])
        if mutation == "revision":
            ctx["revision"] += 1
        if mutation == "printer":
            ctx["printer_id"] = "Canon"
        if mutation == "order":
            ctx["order_id"] = "other-order"
        modified["context"] = ctx
    out = verify_print_evidence_v1(
        expected=snapshot, trusted_evidence_sha256=snapshot["evidence_sha256"],
        active_revision=trusted.active_revision, **modified)
    assert out["status"] == "NEEDS_HUMAN", (mutation, out)
    assert out["allowed_to_print"] is False


@pytest.mark.parametrize("mutation", [
    "missing_review", "old_digest", "wrong_approval", "wrong_preview",
    "changed_driver", "unverified_staff", "unknown", "sending",
    "mode_production", "changed_job",
])
def test_simulation_admission_requires_same_staff_review_and_unsent_job(tmp_path, mutation):
    args, trusted, job, snapshot, verified = _approved_snapshot(tmp_path)
    review = _review(trusted, snapshot)
    current_job = _job(job, snapshot)
    if mutation == "missing_review":
        review = None
    elif mutation == "old_digest":
        review = replace(review, evidence_sha256="0" * 64)
    elif mutation == "wrong_approval":
        review = replace(review, approval_id="different")
    elif mutation == "wrong_preview":
        review = replace(review, preview_sha256=("0" * 64,))
    elif mutation == "changed_driver":
        review = replace(review, printer_capability_sha256="0" * 64)
    elif mutation == "unverified_staff":
        review = replace(review, decision="PENDING")
    elif mutation == "unknown":
        current_job["state"] = "UNKNOWN"
    elif mutation == "sending":
        current_job["state"] = "SENDING"
    elif mutation == "mode_production":
        current_job["mode"] = "production"
    elif mutation == "changed_job":
        current_job["job_id"] = "different"
    result = review_simulation_only(
        verified_evidence=verified, snapshot=snapshot,
        review=review, trusted_job=current_job)
    assert result["status"] == "NEEDS_HUMAN", (mutation, result)
    assert result["allowed_to_simulate"] is False
    assert result["queue_submission_enabled"] is False


def test_untrusted_self_consistent_snapshot_cannot_replace_core_digest(tmp_path):
    args, trusted, _, snapshot, _ = _approved_snapshot(tmp_path)
    invented = dict(snapshot)
    invented["evidence_sha256"] = "0"*64
    out = verify_print_evidence_v1(
        expected=invented, trusted_evidence_sha256=snapshot["evidence_sha256"],
        active_revision=trusted.active_revision, **args)
    assert out["status"] == "NEEDS_HUMAN"


def test_word_original_docx_and_renderer_version_bind_and_review_only(tmp_path):
    # Fake COM is only unit-test plumbing, explicitly spoofed as a LIVE-like
    # envelope to exercise hashing; NEVER an actual Windows/Word attestation.
    data = _docx()
    observed = preview_word_native(
        data, expected_sha256=sha(data), allow_word_launch=True,
        session_factory=FakeWordSession)
    assert observed["evidence_kind"] == "injected_fake"
    observation = {**observed, "evidence_kind": "windows_word_com_preview_only",
                   "native_word_verified": True,
                   "renderer_identity": {"engine": "microsoft_word_com",
                                         "version": "SYNTHETIC-NOT-REAL"}}
    request = {"documents": [{"artifact_name": "synthetic.docx", "copies": 2,
                              "paper": "A4", "duplex": True}]}
    result = make_word_review_artifacts(
        source=data, trusted_request_data=request,
        expected_request_hash=sha(_canonical(request).encode()),
        revision=3, observation=observation, artifact_root=tmp_path)
    assert result["status"] == "REVIEW_REQUIRED", result
    assert result["allowed_to_print"] is False
    manifest_bytes = (tmp_path / result["artifact_ref"]).read_bytes()
    manifest = json.loads(manifest_bytes)
    assert manifest["ready"] is False
    assert manifest["renderer_identity"] == observation["renderer_identity"]
    source = (tmp_path / manifest["files"][0]["source_artifact_ref"]).read_bytes()
    assert source == data  # NEVER substitute Word-exported preview PDF
    previews = tuple((tmp_path / p["ref"]).read_bytes() for p in manifest["previews"])
    args = dict(
        context={"shop_id": "synthetic-shop", "order_id": "word-order",
                 "revision": 3, "request_hash": sha(_canonical(request).encode()),
                 "manifest_ref": result["artifact_ref"], "printer_id": "RMP7000"},
        manifest_bytes=manifest_bytes, originals=(source,), previews=previews,
        settings=({"copies": 2, "paper": "A4", "duplex": True},),
        renderer_identity=manifest["renderer_identity"], printer_capabilities=CAPS)
    evidence = create_print_evidence_v1(**args)
    assert evidence["status"] == "SNAPSHOT_DERIVED", evidence
    snap = evidence["snapshot"]
    assert snap["sources"][0]["format"] == "DOCX"
    assert snap["sources"][0]["source_sha256"] == sha(data)
    verify = verify_print_evidence_v1(
        expected=snap, trusted_evidence_sha256=snap["evidence_sha256"],
        active_revision=3, **args)
    assert verify["status"] == "EVIDENCE_VERIFIED", verify
    # Even with a synthetic staff review, the only result is a no-print simulator.
    trusted = replace(_review_obj_for_word(snap), job_id="fake-word-job")
    job = {
        "shop_id": snap["shop_id"], "order_id": snap["order_id"],
        "revision": 3, "request_hash": snap["request_hash"],
        "evidence_sha256": snap["evidence_sha256"], "printer_id": "RMP7000",
        "approval_id": trusted.approval_id, "job_id": trusted.job_id,
        "mode": "simulation", "state": "NOT_SENT",
    }
    simulation = review_simulation_only(
        verified_evidence=verify, snapshot=snap, review=trusted, trusted_job=job)
    assert simulation["status"] == "SIMULATION_ONLY_REVIEW_CONFIRMED", simulation
    assert simulation["source_formats"] == ("DOCX",)
    assert simulation["allowed_to_print"] is False


def _review_obj_for_word(s):
    return TrustedStaffReview(
        shop_id=s["shop_id"], order_id=s["order_id"],
        revision=s["revision"], request_hash=s["request_hash"],
        evidence_sha256=s["evidence_sha256"],
        settings_sha256=s["settings_sha256"],
        renderer_sha256=s["renderer_sha256"],
        printer_capability_sha256=s["printer_capability_sha256"],
        preview_sha256=tuple(p["sha256"] for p in s["previews"]),
        approval_id="fake-word-approval", job_id="fake-word-job",
        reviewer_id="fake-staff", reviewer_role="staff",
        reviewed_at="2026-10-17T10:00:00Z", decision="STAFF_PREVIEW_CONFIRMED")
