"""AI0 evidence tuple, source bytes and staff-review simulation: SYNTHETIC ONLY."""
import hashlib
import json
from pathlib import Path
from types import SimpleNamespace

import fitz
import pytest

from workers.documents.print_evidence_v1 import (
    create_print_evidence_v1, verify_print_evidence_v1,
)
from agents.windows.native_simulation_review import (
    review_simulation_only,
)
from tests.unit.documents.test_native_word_pdf_v1 import (
    _ready_pdf, _docx, FakeWordSession, sha,
)
from agents.windows.native_word_document import preview_word_native
from workers.documents.native_word_artifacts import make_word_review_artifacts
from workers.documents.bridge import _canonical
from workers.documents.native_pdf_review import prepare_native_pdf_review_from_snapshot


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


def _native_pdf_inputs(tmp_path):
    with fitz.open() as document:
        page = document.new_page()
        page.draw_rect(fitz.Rect(20, 20, 100, 120))
        original = document.tobytes()
    # Exact current Core PDF request shape; artifact_name is a scope anchor,
    # not a path to read. The native worker receives the already-private bytes.
    request_data = {"documents": [{"artifact_name": "bundle-1/source.pdf",
                                    "copies": 1, "duplex": False, "paper": "A4"}]}
    request_hash = sha(_canonical(request_data).encode("utf-8"))
    source_anchor = {"format": "PDF", "artifact_ref": "bundle-1/source.pdf",
                     "sha256": sha(original), "size_bytes": len(original)}
    input_manifest = {"schema": "ai0.pdf_review_manifest.v1",
        "manifest_ref": "bundle-1/manifest.json", "shop_id": "native-pdf-shop",
        "order_id": "native-pdf-order", "active_revision": 7,
        "request_hash": request_hash, "source": source_anchor}
    input_manifest_bytes = json.dumps(input_manifest, separators=(",", ":")).encode("utf-8")
    snapshot = {"schema": "ai0.pdf_review_source.v1", "shop_id": "native-pdf-shop",
        "order_id": "native-pdf-order", "active_revision": 7,
        "request_hash": request_hash, "request_data": request_data,
        "source": source_anchor,
        "manifest": {"ref": "bundle-1/manifest.json", "sha256": sha(input_manifest_bytes)},
        "private_bytes": {"source": original, "manifest": input_manifest_bytes}}
    artifact_root = tmp_path / "native-pdf-artifacts"
    artifact_root.mkdir()
    preview_result = prepare_native_pdf_review_from_snapshot(
        snapshot=snapshot, artifact_root=artifact_root)
    assert preview_result["status"] == "REVIEW_REQUIRED", preview_result
    assert preview_result["allowed_to_print"] is False
    manifest_bytes = (artifact_root / preview_result["artifact_ref"]).read_bytes()
    manifest = json.loads(manifest_bytes)
    source_bytes = (artifact_root / manifest["files"][0]["source_artifact_ref"]).read_bytes()
    previews = tuple((artifact_root / p["ref"]).read_bytes() for p in manifest["previews"])
    settings = ({"paper": "A4", "copies": 1, "duplex": False},)
    context = {"shop_id": snapshot["shop_id"], "order_id": snapshot["order_id"],
        "revision": snapshot["active_revision"], "request_hash": snapshot["request_hash"],
        "manifest_ref": preview_result["artifact_ref"], "printer_id": "RMP7000"}
    args = {"context": context, "manifest_bytes": manifest_bytes,
        "originals": (source_bytes,), "previews": previews, "settings": settings,
        "trusted_core_plan": _core_plan(context, manifest["counts"]),
        "renderer_identity": manifest["renderer_versions"],
        "printer_capabilities": CAPS, "input_manifest_bytes": input_manifest_bytes,
        "request_data": snapshot["request_data"]}
    return args, snapshot, input_manifest_bytes


def _reanchor_native_pdf_request(args, request_data):
    """Build a self-consistent synthetic candidate with a new Core request hash."""
    request_hash = sha(_canonical(request_data).encode("utf-8"))
    updated = dict(args)
    updated["request_data"] = request_data
    updated["context"] = {**args["context"], "request_hash": request_hash}
    updated["trusted_core_plan"] = {
        **args["trusted_core_plan"], "request_hash": request_hash}

    input_manifest = json.loads(args["input_manifest_bytes"].decode("utf-8"))
    input_manifest["request_hash"] = request_hash
    input_manifest_bytes = json.dumps(
        input_manifest, sort_keys=True, ensure_ascii=False,
        separators=(",", ":")).encode("utf-8")
    updated["input_manifest_bytes"] = input_manifest_bytes

    preview_manifest = json.loads(args["manifest_bytes"].decode("utf-8"))
    preview_manifest["request_hash"] = request_hash
    preview_manifest["input_manifest"] = {
        **preview_manifest["input_manifest"], "sha256": sha(input_manifest_bytes)}
    updated["manifest_bytes"] = json.dumps(
        preview_manifest, sort_keys=True, ensure_ascii=False,
        separators=(",", ":")).encode("utf-8")
    return updated


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


def _review_receipt(trusted, snapshot):
    """Synthetic projection of the exact AI1 DB receipt tuple."""
    return {
        "receipt_id": "synthetic-review-receipt",
        "shop_id": trusted.shop_id, "order_id": trusted.order_id,
        "revision": trusted.revision, "request_hash": trusted.request_hash,
        "evidence_sha256": snapshot["evidence_sha256"],
        "reviewer_id": "synthetic-staff-reviewer",
        "reviewed_at": "2026-10-17T10:00:00Z", "decision": "checked",
    }


def _job(job, snapshot):
    return {**job, "evidence_sha256": snapshot["evidence_sha256"],
            "mode": "simulation", "state": "NOT_SENT"}


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
    ok = review_simulation_only(
        verified_evidence=verified, snapshot=snapshot,
        review_receipt=_review_receipt(trusted, snapshot), trusted_job=_job(job, snapshot))
    assert ok["status"] == "PREPARED_NOT_SENT", ok
    assert ok["review_status"] == "EVIDENCE_REVIEWED"
    assert ok["mode"] == "simulation"
    assert ok["receipt_id"] == "synthetic-review-receipt"
    assert ok["allowed_to_simulate"] is True
    assert ok["allowed_to_print"] is False
    assert ok["queue_submission_enabled"] is False
    assert ok["physical_print_verified"] is False


def test_native_pdf_review_manifest_binds_original_source_input_manifest_and_core_plan(tmp_path):
    args, source_snapshot, input_manifest_bytes = _native_pdf_inputs(tmp_path)
    observed = create_print_evidence_v1(**args)
    assert observed["status"] == "SNAPSHOT_DERIVED", observed
    assert observed["allowed_to_print"] is False
    assert observed["allowed_to_simulate"] is False
    proof = observed["snapshot"]
    assert proof["schema"] == "ai0.print_evidence.v1"
    assert proof["sources"][0]["format"] == "PDF"
    assert proof["sources"][0]["source_sha256"] == source_snapshot["source"]["sha256"]
    assert proof["sources"][0]["size_bytes"] == source_snapshot["source"]["size_bytes"]
    assert proof["plan_sha256"] == sha(_canonical(args["trusted_core_plan"]).encode())
    assert proof["manifest_sha256"] == sha(args["manifest_bytes"])
    assert set(proof) == {
        "schema", "shop_id", "order_id", "revision", "request_hash", "sources",
        "source_set_sha256", "settings_sha256", "manifest_ref", "manifest_sha256",
        "previews", "renderer_sha256", "plan_sha256", "printer_id",
        "printer_capability_sha256", "evidence_sha256",
    }
    verified = verify_print_evidence_v1(
        expected=proof, trusted_evidence_sha256=proof["evidence_sha256"],
        active_revision=source_snapshot["active_revision"], **args)
    assert verified["status"] == "EVIDENCE_VERIFIED", verified
    assert verified["allowed_to_print"] is False
    assert verified["allowed_to_simulate"] is False
    assert verified["physical_print_verified"] is False
    assert sha(input_manifest_bytes) == json.loads(args["manifest_bytes"])["input_manifest"]["sha256"]


def test_native_pdf_evidence_rejects_missing_drifted_or_wrong_input_manifest(tmp_path):
    args, _, input_manifest_bytes = _native_pdf_inputs(tmp_path)
    missing = {key: value for key, value in args.items() if key != "input_manifest_bytes"}
    assert create_print_evidence_v1(**missing)["status"] == "NEEDS_HUMAN"

    changed = {**args, "input_manifest_bytes": input_manifest_bytes + b" "}
    result = create_print_evidence_v1(**changed)
    assert result["status"] == "NEEDS_HUMAN"
    assert result["reason_code"] == "PDF_INPUT_MANIFEST_ANCHOR_UNVERIFIED"
    assert result["allowed_to_print"] is False

    changed_source = {**args, "originals": (args["originals"][0] + b"drift",)}
    result = create_print_evidence_v1(**changed_source)
    assert result["status"] == "NEEDS_HUMAN"
    assert result["reason_code"] == "PDF_SOURCE_ANCHOR_UNVERIFIED"

    changed_scope = {**args, "context": {**args["context"], "revision": 8}}
    result = create_print_evidence_v1(**changed_scope)
    assert result["status"] == "NEEDS_HUMAN"
    assert result["reason_code"] == "PDF_REVIEW_PENDING"


def test_native_pdf_evidence_binds_core_request_hash_to_native_plan_settings(tmp_path):
    args, _, _ = _native_pdf_inputs(tmp_path)
    changed_settings = {**args, "settings": (
        {"paper": "A4", "copies": 2, "duplex": False},)}
    result = create_print_evidence_v1(**changed_settings)
    assert result["status"] == "NEEDS_HUMAN"
    assert result["reason_code"] == "PDF_REQUEST_SETTINGS_MISMATCH"
    assert result["allowed_to_print"] is False

    # The artifact locator is validated against the private source anchor after
    # a valid canonical hash has been re-established across the synthetic tuple.
    wrong_source = _reanchor_native_pdf_request(args, {
        "documents": [{"artifact_name": "bundle-1/other.pdf", "copies": 1,
                       "duplex": False, "paper": "A4"}]})
    result = create_print_evidence_v1(**wrong_source)
    assert result["status"] == "NEEDS_HUMAN"
    assert result["reason_code"] == "PDF_REQUEST_SOURCE_MISMATCH"
    assert result["allowed_to_print"] is False

    # Hashing is checked before any internal settings mapping. A modified
    # request cannot become valid merely because its settings still look sane.
    changed_request = {**args, "request_data": {
        "documents": [{"artifact_name": "bundle-1/source.pdf", "copies": 2,
                       "duplex": False, "paper": "A4"}]}}
    result = create_print_evidence_v1(**changed_request)
    assert result["status"] == "NEEDS_HUMAN"
    assert result["reason_code"] == "PDF_REQUEST_HASH_UNVERIFIED"
    assert result["allowed_to_print"] is False

    unsupported = _reanchor_native_pdf_request(args, {
        "documents": [{"artifact_name": "bundle-1/source.pdf", "copies": 1,
                       "duplex": False, "paper": "A4", "unexpected": True}]})
    result = create_print_evidence_v1(**unsupported)
    assert result["status"] == "NEEDS_HUMAN"
    assert result["reason_code"] == "PDF_REQUEST_SHAPE_UNSUPPORTED"
    assert result["allowed_to_print"] is False


def test_native_pdf_input_manifest_rejects_unsafe_private_references(tmp_path):
    args, _, _ = _native_pdf_inputs(tmp_path)
    output_manifest = json.loads(args["manifest_bytes"])
    output_manifest["source"]["artifact_ref"] = "bundle-1/../source.pdf"
    args["manifest_bytes"] = json.dumps(
        output_manifest, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()
    result = create_print_evidence_v1(**args)
    assert result["status"] == "NEEDS_HUMAN"
    assert result["reason_code"] == "PDF_SOURCE_ANCHOR_UNVERIFIED"
    assert result["allowed_to_print"] is False


def test_native_pdf_renderer_paper_plan_and_core_counts_are_bound(tmp_path):
    args, _, _ = _native_pdf_inputs(tmp_path)

    changed_renderer = dict(args)
    renderer_manifest = json.loads(args["manifest_bytes"])
    renderer_manifest["renderer_versions"] = {"pymupdf": "0.0.0"}
    changed_renderer["manifest_bytes"] = json.dumps(
        renderer_manifest, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()
    changed_renderer["renderer_identity"] = renderer_manifest["renderer_versions"]
    result = create_print_evidence_v1(**changed_renderer)
    assert result["status"] == "NEEDS_HUMAN"
    assert result["reason_code"] == "PDF_RENDERER_CHANGED"
    assert result["allowed_to_print"] is False

    changed_plan = dict(args)
    plan_manifest = json.loads(args["manifest_bytes"])
    plan_manifest["paper_plan"][0]["physical_sheets"] += 1
    changed_plan["manifest_bytes"] = json.dumps(
        plan_manifest, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()
    result = create_print_evidence_v1(**changed_plan)
    assert result["status"] == "NEEDS_HUMAN"
    assert result["reason_code"] == "PRINT_PLAN_CHANGED"
    assert result["allowed_to_print"] is False

    changed_core = {**args, "trusted_core_plan": {
        **args["trusted_core_plan"], "physical_sheets": args["trusted_core_plan"]["physical_sheets"] + 1}}
    result = create_print_evidence_v1(**changed_core)
    assert result["status"] == "NEEDS_HUMAN"
    assert result["reason_code"] == "CORE_PLAN_COUNT_MISMATCH"
    assert result["allowed_to_print"] is False


def test_native_pdf_evidence_requires_unambiguous_input_manifest_json(tmp_path):
    args, _, input_manifest_bytes = _native_pdf_inputs(tmp_path)
    duplicate = input_manifest_bytes.replace(
        b'"schema":', b'"schema":"ai0.pdf_review_manifest.v1","schema":', 1)
    output_manifest = json.loads(args["manifest_bytes"])
    output_manifest["input_manifest"]["sha256"] = sha(duplicate)
    args["manifest_bytes"] = json.dumps(
        output_manifest, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()
    args["input_manifest_bytes"] = duplicate
    result = create_print_evidence_v1(**args)
    assert result["status"] == "NEEDS_HUMAN"
    assert result["reason_code"] == "MANIFEST_UNVERIFIED"
    assert result["allowed_to_print"] is False


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
    "missing_receipt", "old_digest", "wrong_order", "missing_actor",
    "browser_actor_object",
    "bad_decision", "client_approval_fields", "changed_preview",
    "verifier_print_claim", "unknown", "sending", "mode_production",
    "changed_job_scope",
])
def test_simulation_admission_requires_same_staff_review_and_unsent_job(tmp_path, mutation):
    args, trusted, job, snapshot, verified = _approved_snapshot(tmp_path)
    receipt = _review_receipt(trusted, snapshot)
    current_job = _job(job, snapshot)
    if mutation == "missing_receipt":
        receipt = None
    elif mutation == "old_digest":
        receipt["evidence_sha256"] = "0" * 64
    elif mutation == "wrong_order":
        receipt["order_id"] = "other-order"
    elif mutation == "missing_actor":
        receipt["reviewer_id"] = ""
    elif mutation == "browser_actor_object":
        receipt = SimpleNamespace(**{**receipt, "reviewer_id": "browser-attacker"})
    elif mutation == "bad_decision":
        receipt["decision"] = "approved"
    elif mutation == "client_approval_fields":
        # Browser flags/approval identifiers are not part of the Core tuple.
        receipt["approval_id"] = "client-controlled"
        receipt["reviewer_role"] = "owner"
    elif mutation == "changed_preview":
        snapshot["previews"][0]["sha256"] = "0" * 64
    elif mutation == "verifier_print_claim":
        verified["allowed_to_print"] = True
    elif mutation == "unknown":
        current_job["state"] = "UNKNOWN"
    elif mutation == "sending":
        current_job["state"] = "SENDING"
    elif mutation == "mode_production":
        current_job["mode"] = "production"
    elif mutation == "changed_job_scope":
        current_job["shop_id"] = "other-shop"
    result = review_simulation_only(
        verified_evidence=verified, snapshot=snapshot,
        review_receipt=receipt, trusted_job=current_job)
    assert result["status"] == "NEEDS_HUMAN", (mutation, result)
    assert result["allowed_to_simulate"] is False
    assert result["queue_submission_enabled"] is False
    assert result["allowed_to_print"] is False
    assert result["physical_print_verified"] is False


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
    args["trusted_core_plan"] = _core_plan(args["context"], manifest["counts"])
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
    receipt = {
        "receipt_id": "synthetic-word-review-receipt",
        "shop_id": snap["shop_id"], "order_id": snap["order_id"],
        "revision": 3, "request_hash": snap["request_hash"],
        "evidence_sha256": snap["evidence_sha256"],
        "reviewer_id": "synthetic-staff-reviewer",
        "reviewed_at": "2026-10-17T10:00:00Z", "decision": "checked",
    }
    job = {"shop_id": snap["shop_id"], "order_id": snap["order_id"],
           "revision": 3, "request_hash": snap["request_hash"],
           "evidence_sha256": snap["evidence_sha256"], "printer_id": "RMP7000",
           "mode": "simulation", "state": "NOT_SENT"}
    missing_receipt = review_simulation_only(
        verified_evidence=verify, snapshot=snap, review_receipt=None, trusted_job=job)
    assert missing_receipt["status"] == "NEEDS_HUMAN"
    stale_word_snapshot = {
        **snap,
        "previews": [{**snap["previews"][0], "sha256": "0" * 64},
                     *snap["previews"][1:]],
    }
    stale_preview = review_simulation_only(
        verified_evidence=verify, snapshot=stale_word_snapshot,
        review_receipt=receipt, trusted_job=job)
    assert stale_preview["status"] == "NEEDS_HUMAN"
    simulation = review_simulation_only(
        verified_evidence=verify, snapshot=snap, review_receipt=receipt, trusted_job=job)
    assert simulation["status"] == "PREPARED_NOT_SENT", simulation
    assert simulation["review_status"] == "EVIDENCE_REVIEWED"
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
