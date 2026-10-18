"""AI0 evidence tuple, source bytes and staff-review simulation: SYNTHETIC ONLY."""
from dataclasses import replace
import hashlib
import json
from pathlib import Path

import pytest

from workers.documents.print_evidence_v1 import (
    create_print_evidence_v1, verify_print_evidence_v1,
)
from agents.windows.native_simulation_review import review_simulation_only
from tests.unit.documents.test_native_word_pdf_v1 import (
    _ready_pdf, _docx, FakeWordSession, sha,
)
from agents.windows.native_word_document import preview_word_native
from workers.documents.word_review_source_adapter import adapt_word_review_source
from tests.unit.documents.word_review_source_fixture import source_snapshot
from workers.documents.bridge import _canonical


CAPS = {
    "printer_id": "RMP7000", "queue_name": "RMP7000",
    "driver": "Ricoh PCL6 V4", "port": "IP_192.168.1.195",
    "supports": ["A4", "A3", "duplex", "monochrome"],
}


def _core_plan(context, counts):
    """Synthetic copy of the Core PrintPlan row for this isolated test."""
    return {
        "request_hash": context["request_hash"],
        "physical_sheets": counts["physical_sheets"],
        "document_pages": counts["document_pages"],
        "printed_faces": counts["printed_faces"],
        "ready": True,
        "printer_id": context["printer_id"],
        "artifact_ref": context["manifest_ref"],
        "verified_by": "ai3.processor.v1",
    }


def test_shared_vector_matches_core_canonical_digests():
    fixture = Path(__file__).parent / "fixtures" / "print_evidence_v1_core_vector.json"
    vector = json.loads(fixture.read_text(encoding="utf-8"))
    scope = vector["scope"]
    proof = vector["proof"]
    expected = vector["expected_sha256"]

    def core_sha(value):
        return hashlib.sha256(_canonical(value).encode("utf-8")).hexdigest()

    assert vector["synthetic_only"] is True
    assert vector["processor_counts"] == {
        key: scope["plan"][key]
        for key in ("document_pages", "printed_faces", "physical_sheets")
    }
    assert proof["plan_sha256"] == expected["plan_sha256"] == core_sha(scope["plan"])
    assert proof["source_set_sha256"] == expected["source_set_sha256"] == core_sha(proof["sources"])
    body = {key: value for key, value in proof.items() if key != "evidence_sha256"}
    assert proof["evidence_sha256"] == expected["evidence_sha256"] == core_sha(body)
    assert set(proof) == {
        "schema", "shop_id", "order_id", "revision", "request_hash", "sources",
        "source_set_sha256", "settings_sha256", "manifest_ref", "manifest_sha256",
        "previews", "renderer_sha256", "plan_sha256", "printer_id",
        "printer_capability_sha256", "evidence_sha256",
    }


def _pdf_inputs(tmp_path):
    trusted, job, manifest_bytes, source, previews, settings = _ready_pdf(tmp_path)
    manifest = json.loads(manifest_bytes)
    context = {
        "shop_id": trusted.shop_id, "order_id": trusted.order_id,
        "revision": trusted.revision, "request_hash": trusted.request_hash,
        "manifest_ref": trusted.manifest_ref, "printer_id": trusted.printer_id,
    }
    core_plan = _core_plan(context, manifest["counts"])
    args = dict(context=context, manifest_bytes=manifest_bytes,
                originals=(source,), previews=previews, settings=(settings,),
                trusted_core_plan=core_plan,
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
    del trusted
    return {
        "receipt_id": "synthetic-review-receipt",
        "shop_id": snapshot["shop_id"], "order_id": snapshot["order_id"],
        "revision": snapshot["revision"],
        "request_hash": snapshot["request_hash"],
        "evidence_sha256": snapshot["evidence_sha256"],
        "reviewer_id": "synthetic-staff-reviewer",
        "reviewed_at": "2026-10-17T10:00:00Z", "decision": "checked",
    }


def _job(job, snapshot):
    return {**job, "evidence_sha256": snapshot["evidence_sha256"],
            "state": "NOT_SENT"}


def _ticket(job, snapshot):
    return {
        "allowed": True, "job_id": job["job_id"],
        "revision": job["revision"], "mode": "simulation",
        "approval_id": job["approval_id"],
        "review_receipt": _review(None, snapshot),
        "trusted_evidence": {
            "schema": "ai0.print_evidence.v1",
            "shop_id": snapshot["shop_id"], "order_id": snapshot["order_id"],
            "revision": snapshot["revision"],
            "request_hash": snapshot["request_hash"],
            "evidence_sha256": snapshot["evidence_sha256"],
            "settings_sha256": snapshot["settings_sha256"],
            "renderer_sha256": snapshot["renderer_sha256"],
            "printer_capability_sha256": snapshot["printer_capability_sha256"],
            "preview_sha256": [item["sha256"] for item in snapshot["previews"]],
            "printer_id": snapshot["printer_id"],
        },
        "trusted_job": {
            "job_id": job["job_id"], "shop_id": snapshot["shop_id"],
            "order_id": job["order_id"], "revision": job["revision"],
            "request_hash": job["request_hash"],
            "approval_id": job["approval_id"], "printer_id": job["printer_id"],
            "evidence_sha256": snapshot["evidence_sha256"],
            "mode": "simulation", "state": "NOT_SENT",
        },
    }


def test_pdf_exact_tuple_core_anchor_and_staff_review_allows_simulation_only(tmp_path):
    args, trusted, job, snapshot, verified = _approved_snapshot(tmp_path)
    assert snapshot["schema"] == "ai0.print_evidence.v1"
    assert snapshot["sources"][0]["format"] == "PDF"
    assert snapshot["sources"][0]["source_sha256"] == sha(args["originals"][0])
    assert snapshot["manifest_sha256"] == sha(args["manifest_bytes"])
    assert snapshot["plan_sha256"] == sha(_canonical(args["trusted_core_plan"]).encode())
    assert snapshot["settings_sha256"] == sha(_canonical(list(args["settings"])).encode())
    assert snapshot["source_set_sha256"] == sha(_canonical(snapshot["sources"]).encode())
    assert snapshot["printer_capability_sha256"] == sha(_canonical(CAPS).encode())
    assert verified["allowed_to_simulate"] is False
    current_job = _job(job, snapshot)
    ok = review_simulation_only(
        verified_evidence=verified, snapshot=snapshot,
        preflight_ticket=_ticket(current_job, snapshot), claimed_job=current_job)
    assert ok["status"] == "PREPARED_NOT_SENT", ok
    assert ok["allowed_to_simulate"] is True
    assert ok["allowed_to_print"] is False
    assert ok["queue_submission_enabled"] is False
    assert ok["physical_print_verified"] is False


def test_processor_counts_must_match_the_active_core_plan(tmp_path):
    args, trusted, _ = _pdf_inputs(tmp_path)
    changed_plan = {**args["trusted_core_plan"], "physical_sheets": 99}
    result = create_print_evidence_v1(**{**args, "trusted_core_plan": changed_plan})
    assert result["status"] == "NEEDS_HUMAN"
    assert result["reason_code"] == "CORE_PLAN_COUNT_MISMATCH"
    assert result["allowed_to_print"] is False


def test_missing_active_core_plan_fails_closed(tmp_path):
    args, _, _ = _pdf_inputs(tmp_path)
    result = create_print_evidence_v1(**{**args, "trusted_core_plan": None})
    assert result["status"] == "NEEDS_HUMAN"
    assert result["reason_code"] == "CORE_PLAN_UNVERIFIED"
    assert result["allowed_to_print"] is False


@pytest.mark.parametrize("field,value", [
    ("request_hash", "0" * 64),
    ("printer_id", "Canon"),
    ("artifact_ref", "doc-other/manifest.json"),
    ("ready", False),
    ("verified_by", ""),
])
def test_core_plan_scope_and_readiness_must_match_manifest(tmp_path, field, value):
    args, _, _ = _pdf_inputs(tmp_path)
    changed_plan = {**args["trusted_core_plan"], field: value}
    result = create_print_evidence_v1(**{**args, "trusted_core_plan": changed_plan})
    assert result["status"] == "NEEDS_HUMAN", (field, result)
    assert result["reason_code"] == "CORE_PLAN_SCOPE_UNVERIFIED"
    assert result["allowed_to_print"] is False


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
    current_job = _job(job, snapshot)
    ticket = _ticket(current_job, snapshot)
    if mutation == "missing_review":
        ticket.pop("review_receipt")
    elif mutation == "old_digest":
        ticket["review_receipt"]["evidence_sha256"] = "0" * 64
    elif mutation == "wrong_approval":
        ticket["trusted_job"]["approval_id"] = "different"
    elif mutation == "wrong_preview":
        ticket["trusted_evidence"]["preview_sha256"] = ["0" * 64]
    elif mutation == "changed_driver":
        ticket["trusted_evidence"]["printer_capability_sha256"] = "0" * 64
    elif mutation == "unverified_staff":
        ticket["review_receipt"]["decision"] = "pending"
    elif mutation == "unknown":
        ticket["trusted_job"]["state"] = "UNKNOWN"
    elif mutation == "sending":
        ticket["trusted_job"]["state"] = "SENDING"
    elif mutation == "mode_production":
        current_job["mode"] = "production"
    elif mutation == "changed_job":
        ticket["trusted_job"]["job_id"] = "different"
    result = review_simulation_only(
        verified_evidence=verified, snapshot=snapshot,
        preflight_ticket=ticket, claimed_job=current_job)
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
    core_source = source_snapshot(
        data, request, shop_id="synthetic-shop", order_id="word-order", revision=3)
    result = adapt_word_review_source(
        snapshot=core_source, observation=observation, artifact_root=tmp_path)
    assert result["status"] == "REVIEW_REQUIRED", result
    assert result["source"] == core_source["source"]
    assert result["input_manifest"] == core_source["manifest"]
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
    args["trusted_core_plan"] = _core_plan(args["context"], manifest["counts"])
    evidence = create_print_evidence_v1(**args)
    assert evidence["status"] == "SNAPSHOT_DERIVED", evidence
    snap = evidence["snapshot"]
    assert snap["sources"][0]["format"] == "DOCX"
    assert snap["sources"][0]["source_sha256"] == sha(data)
    changed_anchor = dict(manifest)
    changed_anchor["source"] = {**manifest["source"], "sha256": "0" * 64}
    changed_bytes = json.dumps(
        changed_anchor, sort_keys=True, ensure_ascii=False, separators=(",", ":")
    ).encode("utf-8")
    rejected = create_print_evidence_v1(**{**args, "manifest_bytes": changed_bytes})
    assert rejected["status"] == "NEEDS_HUMAN"
    assert rejected["reason_code"] == "WORD_CORE_SOURCE_BYTES_CHANGED"
    verify = verify_print_evidence_v1(
        expected=snap, trusted_evidence_sha256=snap["evidence_sha256"],
        active_revision=3, **args)
    assert verify["status"] == "EVIDENCE_VERIFIED", verify
    # Even with a synthetic staff review, the only result is a no-print simulator.
    job = {
        "shop_id": snap["shop_id"], "order_id": snap["order_id"],
        "revision": 3, "request_hash": snap["request_hash"],
        "evidence_sha256": snap["evidence_sha256"], "printer_id": "RMP7000",
        "approval_id": "fake-word-approval", "job_id": "fake-word-job",
        "lease_token": "synthetic-lease", "mode": "simulation",
    }
    ticket = _ticket(job, snap)
    simulation = review_simulation_only(
        verified_evidence=verify, snapshot=snap, preflight_ticket=ticket,
        claimed_job=job)
    assert simulation["status"] == "PREPARED_NOT_SENT", simulation
    assert simulation["source_formats"] == ("DOCX",)
    assert simulation["allowed_to_print"] is False


def test_missing_core_context_returns_hold_not_exception(tmp_path):
    args, trusted, _, snapshot, _ = _approved_snapshot(tmp_path)
    invalid = {**args, "context": None}
    result = verify_print_evidence_v1(
        expected=snapshot, trusted_evidence_sha256=snapshot["evidence_sha256"],
        active_revision=trusted.active_revision, **invalid)
    assert result["status"] == "NEEDS_HUMAN"
    assert result["reason_code"] == "CORE_EVIDENCE_OR_REVISION_UNVERIFIED"
    assert result["allowed_to_print"] is False
