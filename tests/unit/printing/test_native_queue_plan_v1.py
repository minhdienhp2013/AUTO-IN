"""No Ricoh I/O; fake Windows inventory and sealed evidence metadata only."""
import pytest
from agents.windows.native_queue_plan import ObservedQueue, plan_native_ricoh


def _args():
    queue = ObservedQueue(
        queue_name="RMP7000", printer_id="RMP7000",
        printer_model="Ricoh IM7000", driver_name="Ricoh PCL6 V4",
        port_name="IP_192.168.1.195")
    job = {"printer_id": "RMP7000", "mode": "simulation"}
    evidence = {"status": "EVIDENCE_VERIFIED", "allowed_to_print": False,
                "native_format": "PDF"}
    settings = {"paper": "A4", "copies": 2, "duplex": True,
                "orientation": "landscape", "binding": "short_edge"}
    return queue, job, evidence, settings


def test_missing_real_windows_inventory_blocks():
    q, j, e, s = _args()
    out = plan_native_ricoh(observed=q, sealed_job=j, verified_evidence=e,
                            file_format="PDF", settings=s)
    assert out["status"] == "NEEDS_HUMAN"
    assert out["reason_code"] == "WINDOWS_INVENTORY_NOT_VERIFIED"
    assert out["queue_submission_enabled"] is False


def test_synthetic_windows_inventory_produces_only_unsent_plan():
    q, j, e, s = _args()
    out = plan_native_ricoh(
        observed=q, sealed_job=j, verified_evidence=e, file_format="PDF",
        settings=s, host_windows_verified=True)
    assert out["status"] == "PREPARED_NOT_SENT"
    assert out["queue_submission_enabled"] is False
    assert out["paper_verified"] is False
    assert out["native_application"] == "PDF_NATIVE"
    assert out["binding"] == "short_edge"
    assert out["scale_mode"] == "shrink_to_printable_area_only"


@pytest.mark.parametrize("field,changed", [
    ("queue_name", "Other"), ("printer_id", "Canon"), ("printer_model", "unknown"),
    ("driver_name", "Generic"), ("port_name", ""),
])
def test_unverified_ricoh_queue_never_falls_back(field, changed):
    from dataclasses import replace
    q, j, e, s = _args()
    q = replace(q, **{field: changed})
    out = plan_native_ricoh(
        observed=q, sealed_job=j, verified_evidence=e,
        file_format="PDF", settings=s, host_windows_verified=True)
    assert out["status"] == "NEEDS_HUMAN"
    assert out["queue_submission_enabled"] is False


def test_word_requires_more_than_preview():
    q, j, e, s = _args()
    e["native_format"] = "DOCX"
    e["status"] = "REVIEW_REQUIRED"
    out = plan_native_ricoh(
        observed=q, sealed_job=j, verified_evidence=e,
        file_format="DOCX", settings=s, host_windows_verified=True)
    assert out["status"] == "NEEDS_HUMAN"
    assert out["reason_code"] == "MANIFEST_OR_STAFF_REVIEW_INCOMPLETE"


def test_driver_not_called_and_uncertain_job_not_resubmitted():
    q, j, e, s = _args()
    j["mode"] = "production"
    out = plan_native_ricoh(
        observed=q, sealed_job=j, verified_evidence=e,
        file_format="PDF", settings=s, host_windows_verified=True)
    assert out["status"] == "NEEDS_HUMAN"
    assert out["queue_submission_enabled"] is False
