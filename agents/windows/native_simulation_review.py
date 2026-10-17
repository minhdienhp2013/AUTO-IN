"""Staff-reviewed simulation-only gate for the AI0 print_evidence.v1 contract.

No driver, COM, spooler, network, queue mutation, print job creation or retry.
An external AI0/Core Port must load the review and job from an authenticated,
durable transaction; constructing a dataclass here does not grant authority.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

SCHEMA = "ai3.staff_review_simulation.v1"


@dataclass(frozen=True)
class TrustedStaffReview:
    """AI0/AI1 only: reviewed preview digest and exact approved revision."""

    shop_id: str
    order_id: str
    revision: int
    request_hash: str
    evidence_sha256: str
    settings_sha256: str
    renderer_sha256: str
    printer_capability_sha256: str
    preview_sha256: tuple[str, ...]
    approval_id: str
    job_id: str
    reviewer_id: str
    reviewer_role: str
    reviewed_at: str
    decision: str


def review_simulation_only(*, verified_evidence: dict[str, Any],
                           snapshot: dict[str, Any],
                           review: TrustedStaffReview | None,
                           trusted_job: dict[str, Any]) -> dict[str, Any]:
    """Require staff preview review *after* the anchored evidence verification.

    Returned permission is to run an isolated *simulation*, never to mark
    SENDING, invoke PrintOut, call a physical spooler, or resend UNKNOWN.
    """
    def hold(reason: str) -> dict[str, Any]:
        return {"schema": SCHEMA, "status": "NEEDS_HUMAN",
                "reason_code": reason, "allowed_to_simulate": False,
                "allowed_to_print": False, "queue_submission_enabled": False,
                "physical_print_verified": False}

    if (not isinstance(verified_evidence, dict) or
            verified_evidence.get("schema") != "ai0.print_evidence.v1" or
            verified_evidence.get("status") != "EVIDENCE_VERIFIED" or
            verified_evidence.get("allowed_to_print") is not False or
            not isinstance(snapshot, dict) or
            snapshot.get("schema") != "ai0.print_evidence.v1" or
            verified_evidence.get("evidence_sha256") != snapshot.get("evidence_sha256")):
        return hold("CORE_EVIDENCE_NOT_VERIFIED")
    if not isinstance(trusted_job, dict) or trusted_job.get("mode") != "simulation":
        return hold("SIMULATION_MODE_REQUIRED")
    if trusted_job.get("state") != "NOT_SENT":
        return hold("JOB_UNCERTAIN_OR_ALREADY_SENT")
    if not isinstance(review, TrustedStaffReview):
        return hold("STAFF_PREVIEW_REVIEW_MISSING")
    fields = ("shop_id", "order_id", "revision", "request_hash",
              "evidence_sha256", "settings_sha256", "renderer_sha256",
              "printer_capability_sha256")
    if (any(getattr(review, name) != snapshot.get(name) for name in fields) or
            type(review.revision) is not int or review.revision < 1 or
            type(snapshot.get("revision")) is not int or
            any(trusted_job.get(name) != snapshot.get(name)
                for name in ("shop_id", "order_id", "revision", "request_hash",
                             "evidence_sha256"))):
        return hold("STAFF_REVIEW_STALE_EVIDENCE")
    images = snapshot.get("previews")
    if (not isinstance(images, list) or
            tuple(x.get("sha256") for x in images if isinstance(x, dict)) != review.preview_sha256 or
            len(images) != len(review.preview_sha256)):
        return hold("STAFF_REVIEW_PREVIEW_CHANGED")
    if (review.decision != "STAFF_PREVIEW_CONFIRMED" or
            review.reviewer_role not in ("staff", "owner") or
            any(type(x) is not str or not x for x in
                (review.reviewer_id, review.reviewed_at, review.approval_id,
                 review.job_id, review.shop_id, review.order_id)) or
            trusted_job.get("approval_id") != review.approval_id or
            trusted_job.get("job_id") != review.job_id or
            trusted_job.get("printer_id") != "RMP7000" or
            snapshot.get("printer_id") != "RMP7000"):
        return hold("STAFF_REVIEW_OR_JOB_UNVERIFIED")
    return {"schema": SCHEMA, "status": "SIMULATION_ONLY_REVIEW_CONFIRMED",
            "reason_code": "NONE",
            "evidence_sha256": snapshot["evidence_sha256"],
            "source_formats": tuple(s["format"] for s in snapshot["sources"]),
            "allowed_to_simulate": True, "allowed_to_print": False,
            "queue_submission_enabled": False, "physical_print_verified": False}
