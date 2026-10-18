"""No Ricoh I/O; fake Windows inventory and sealed evidence metadata only."""
from dataclasses import replace
import hashlib

import pytest

from agents.windows.native_queue_plan import ObservedQueue, plan_native_ricoh
from workers.documents.bridge import _canonical

RENDERER = {"engine": "synthetic-pymupdf", "version": "fixture"}
CAPS = {
    "printer_id": "RMP7000", "queue_name": "RMP7000",
    "driver": "Ricoh PCL6 V4", "port": "IP_192.168.1.195",
    "supports": ["A4", "A3", "duplex", "monochrome"],
}


def _sha(value):
    return hashlib.sha256(_canonical(value).encode("utf-8")).hexdigest()


def _args():
    queue = ObservedQueue(
        queue_name="RMP7000", printer_id="RMP7000",
        printer_model="Ricoh IM7000", driver_name="Ricoh PCL6 V4",
        port_name="IP_192.168.1.195")
    job = {
        "shop_id": "synthetic-shop", "order_id": "synthetic-order",
        "job_id": "synthetic-job", "revision": 2,
        "request_hash": "b" * 64, "approval_id": "synthetic-approval",
        "evidence_sha256": "a" * 64, "printer_id": "RMP7000",
        "mode": "simulation", "state": "NOT_SENT",
    }
    settings = {"paper": "A4", "copies": 2, "duplex": True,
                "orientation": "landscape", "binding": "short_edge"}
    evidence = {
        **{key: value for key, value in job.items() if key != "state"},
        "status": "PREPARED_NOT_SENT", "review_status": "EVIDENCE_REVIEWED",
        "reason_code": "CORE_REVIEW_RECEIPT_MATCHED",
        "receipt_id": "synthetic-receipt", "source_formats": ("PDF",),
        "settings_sha256": _sha([settings]), "renderer_sha256": _sha(RENDERER),
        "printer_capability_sha256": _sha(CAPS),
        "allowed_to_simulate": True, "allowed_to_print": False,
        "queue_submission_enabled": False, "physical_print_verified": False,
    }
    return queue, job, evidence, settings


def _plan(q, j, e, s, *, file_format="PDF", renderer=RENDERER, capabilities=CAPS,
          host_windows_verified=False):
    return plan_native_ricoh(
        observed=q, sealed_job=j, verified_evidence=e, file_format=file_format,
        settings=s, renderer_identity=renderer,
        printer_capabilities=capabilities,
        host_windows_verified=host_windows_verified)


def test_missing_real_windows_inventory_blocks():
    q, j, e, s = _args()
    out = _plan(q, j, e, s)
    assert out["status"] == "NEEDS_HUMAN"
    assert out["reason_code"] == "WINDOWS_INVENTORY_NOT_VERIFIED"
    assert out["queue_submission_enabled"] is False


def test_synthetic_windows_inventory_produces_only_unsent_plan():
    q, j, e, s = _args()
    out = _plan(q, j, e, s, host_windows_verified=True)
    assert out["status"] == "PREPARED_NOT_SENT"
    assert out["allowed_to_print"] is False
    assert out["queue_submission_enabled"] is False
    assert out["paper_verified"] is False
    assert out["native_application"] == "PDF_NATIVE"
    assert out["binding"] == "short_edge"
    assert out["scale_mode"] == "shrink_to_printable_area_only"


@pytest.mark.parametrize("field,changed", [
    ("queue_name", "Other"), ("printer_id", "Canon"),
    ("printer_model", "unknown"), ("driver_name", "Generic"),
    ("port_name", ""),
])
def test_unverified_ricoh_queue_never_falls_back(field, changed):
    q, j, e, s = _args()
    q = replace(q, **{field: changed})
    out = _plan(q, j, e, s, host_windows_verified=True)
    assert out["status"] == "NEEDS_HUMAN"
    assert out["queue_submission_enabled"] is False


def test_word_requires_more_than_preview():
    q, j, e, s = _args()
    e["source_formats"] = ("DOCX",)
    e["status"] = "EVIDENCE_VERIFIED"
    out = _plan(q, j, e, s, file_format="DOCX", host_windows_verified=True)
    assert out["status"] == "NEEDS_HUMAN"
    assert out["reason_code"] == "MANIFEST_OR_STAFF_REVIEW_INCOMPLETE"


def test_reviewed_docx_prepares_without_changing_print_source():
    q, j, e, s = _args()
    e["source_formats"] = ("DOCX",)
    out = _plan(q, j, e, s, file_format="DOCX", host_windows_verified=True)
    assert out["status"] == "PREPARED_NOT_SENT", out
    assert out["print_source_format"] == "DOCX"
    assert out["native_application"] == "Word.Application"
    assert out["allowed_to_print"] is False
    assert out["queue_submission_enabled"] is False


def test_unknown_job_cannot_replay_into_prepared_plan():
    q, j, e, s = _args()
    j["state"] = "UNKNOWN"
    out = _plan(q, j, e, s, host_windows_verified=True)
    assert out["status"] == "NEEDS_HUMAN"
    assert out["reason_code"] == "JOB_REVIEW_SCOPE_OR_REPLAY"
    assert out["queue_submission_enabled"] is False


def test_driver_not_called_and_uncertain_job_not_resubmitted():
    q, j, e, s = _args()
    j["mode"] = "production"
    out = _plan(q, j, e, s, host_windows_verified=True)
    assert out["status"] == "NEEDS_HUMAN"
    assert out["queue_submission_enabled"] is False


@pytest.mark.parametrize("drift", ["settings", "renderer", "capability"])
def test_prepared_plan_rejects_post_review_drift(drift):
    q, j, e, s = _args()
    renderer, capabilities = RENDERER, CAPS
    if drift == "settings":
        s = {**s, "copies": 3}
    elif drift == "renderer":
        renderer = {**RENDERER, "version": "changed"}
    else:
        capabilities = {**CAPS, "supports": ["A4"]}
    out = _plan(q, j, e, s, renderer=renderer, capabilities=capabilities,
                host_windows_verified=True)
    assert out["status"] == "NEEDS_HUMAN", (drift, out)
    assert out["reason_code"] == "REVIEWED_SETTINGS_RENDERER_OR_CAPABILITY_CHANGED"
    assert out["allowed_to_print"] is False
