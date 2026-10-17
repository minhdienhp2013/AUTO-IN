"""Compact Core review-ticket gate; synthetic only, no physical printing."""
from copy import deepcopy

import pytest

from agents.windows.native_simulation_review import (
    PREFLIGHT_RESULT_FIELDS,
    is_safe_preflight_review_result,
    review_preflight_ticket_simulation_only,
)


def _claimed_job():
    return {
        "job_id": "job-ticket-1", "order_id": "order-ticket-1",
        "revision": 4, "request_hash": "a" * 64,
        "approval_id": "approval-ticket-1", "lease_token": "lease-ticket-1",
        "printer_id": "RMP7000", "mode": "simulation",
    }


def _ticket(job=None):
    job = job or _claimed_job()
    evidence_sha = "e" * 64
    return {
        "allowed": True, "job_id": job["job_id"],
        "revision": job["revision"], "mode": job["mode"],
        "approval_id": job["approval_id"], "document_evidence_verified": True,
        "review_receipt": {
            "receipt_id": "receipt-ticket-1", "shop_id": "shop-ticket-1",
            "order_id": job["order_id"], "revision": job["revision"],
            "request_hash": job["request_hash"], "evidence_sha256": evidence_sha,
            "reviewer_id": "different-staff-reviewer", "reviewed_at": "2026-10-18T10:00:00Z",
            "decision": "checked",
        },
        "trusted_evidence": {
            "schema": "ai0.print_evidence.v1", "shop_id": "shop-ticket-1",
            "order_id": job["order_id"], "revision": job["revision"],
            "request_hash": job["request_hash"], "evidence_sha256": evidence_sha,
            "settings_sha256": "1" * 64, "renderer_sha256": "2" * 64,
            "printer_capability_sha256": "3" * 64,
            "preview_sha256": ["4" * 64, "5" * 64],
            "printer_id": job["printer_id"],
        },
        "trusted_job": {
            "job_id": job["job_id"], "shop_id": "shop-ticket-1",
            "order_id": job["order_id"], "revision": job["revision"],
            "request_hash": job["request_hash"],
            "approval_id": job["approval_id"], "printer_id": job["printer_id"],
            "evidence_sha256": evidence_sha, "mode": job["mode"],
            "state": "NOT_SENT",
        },
    }


def test_exact_core_ticket_advances_only_to_simulation_prepared_not_sent():
    job = _claimed_job()
    ticket = _ticket(job)
    result = review_preflight_ticket_simulation_only(
        preflight_ticket=ticket, claimed_job=job)
    assert set(result) == PREFLIGHT_RESULT_FIELDS
    assert result == {
        "schema": "ai3.core_preflight_review_simulation.v1",
        "status": "PREPARED_NOT_SENT",
        "review_status": "EVIDENCE_REVIEWED",
        "reason_code": "CORE_REVIEW_RECEIPT_MATCHED",
        "receipt_id": "receipt-ticket-1",
        "evidence_sha256": "e" * 64,
        "mode": "simulation", "allowed_to_simulate": True,
        "allowed_to_print": False, "queue_submission_enabled": False,
        "physical_print_verified": False,
    }
    assert is_safe_preflight_review_result(result, preflight_ticket=ticket)
    assert not is_safe_preflight_review_result(
        {**result, "allowed_to_print": 0}, preflight_ticket=ticket)


@pytest.mark.parametrize("mutation", [
    "missing_receipt", "receipt_extra_field", "bad_digest", "stale_hash",
    "cross_order", "wrong_revision", "unknown", "sending",
    "empty_preview_hashes", "bad_preview_hash", "missing_composition_flag",
    "extra_print_claim", "production_mode",
])
def test_bad_ticket_fails_closed_without_any_print_claim(mutation):
    job = _claimed_job()
    ticket = deepcopy(_ticket(job))
    if mutation == "missing_receipt":
        ticket.pop("review_receipt")
    elif mutation == "receipt_extra_field":
        ticket["review_receipt"]["approval_id"] = "browser-controlled"
    elif mutation == "bad_digest":
        ticket["trusted_evidence"]["renderer_sha256"] = "not-a-digest"
    elif mutation == "stale_hash":
        ticket["trusted_job"]["evidence_sha256"] = "f" * 64
    elif mutation == "cross_order":
        ticket["trusted_evidence"]["order_id"] = "another-order"
    elif mutation == "wrong_revision":
        ticket["review_receipt"]["revision"] = True
    elif mutation == "unknown":
        ticket["trusted_job"]["state"] = "UNKNOWN"
    elif mutation == "sending":
        ticket["trusted_job"]["state"] = "SENDING"
    elif mutation == "empty_preview_hashes":
        ticket["trusted_evidence"]["preview_sha256"] = []
    elif mutation == "bad_preview_hash":
        ticket["trusted_evidence"]["preview_sha256"] = ["bad"]
    elif mutation == "missing_composition_flag":
        ticket.pop("document_evidence_verified")
    elif mutation == "extra_print_claim":
        ticket["allowed_to_print"] = True
    elif mutation == "production_mode":
        ticket["trusted_job"]["mode"] = "production"

    result = review_preflight_ticket_simulation_only(
        preflight_ticket=ticket, claimed_job=job)
    assert result["status"] == "NEEDS_HUMAN", (mutation, result)
    assert result["allowed_to_simulate"] is False
    assert result["allowed_to_print"] is False
    assert result["queue_submission_enabled"] is False
    assert result["physical_print_verified"] is False
    assert not is_safe_preflight_review_result(result, preflight_ticket=ticket)
