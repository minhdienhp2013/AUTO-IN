"""Core-receipt-gated, simulation-only review of native print evidence.

This module performs no driver, COM, spooler, network, queue mutation, print
job creation or retry. ``review_receipt`` must be the exact tuple projected by
AI0/AI1 from its authenticated DB-built server ticket after staff authorization;
never pass browser fields or a client-constructed dataclass here. This module
checks that tuple against the already verified current evidence and job scope.
It cannot authenticate a receipt on its own.
"""
from __future__ import annotations

from datetime import datetime
import hashlib
from typing import Any

from workers.documents.bridge import _canonical

SCHEMA = "ai3.staff_review_simulation.v1"
RECEIPT_FIELDS = frozenset({
    "receipt_id", "shop_id", "order_id", "revision", "request_hash",
    "evidence_sha256", "reviewer_id", "reviewed_at", "decision",
})
HEX = frozenset("0123456789abcdef")


def _is_sha256(value: Any) -> bool:
    return (type(value) is str and len(value) == 64 and
            all(char in HEX for char in value))


def _digest(value: Any) -> str:
    return hashlib.sha256(_canonical(value).encode("utf-8")).hexdigest()


def _valid_review_time(value: Any) -> bool:
    if type(value) is not str or not value:
        return False
    try:
        parsed = datetime.fromisoformat(value[:-1] + "+00:00" if value.endswith("Z") else value)
    except ValueError:
        return False
    return parsed.tzinfo is not None and parsed.utcoffset() is not None


def review_simulation_only(*, verified_evidence: dict[str, Any],
                           snapshot: dict[str, Any],
                           review_receipt: dict[str, Any] | None,
                           trusted_job: dict[str, Any]) -> dict[str, Any]:
    """Require a matching server receipt before advancing a simulation state.

    A passing result is only ``PREPARED_NOT_SENT``. It never permits sending,
    SENDING, PrintOut, spooler access, physical printing or UNKNOWN replay.
    Staff authorization is performed by AI1 when it creates the DB receipt; a
    non-empty reviewer ID is checked here but is not treated as authorization.
    """
    def hold(reason: str) -> dict[str, Any]:
        return {"schema": SCHEMA, "status": "NEEDS_HUMAN",
                "reason_code": reason, "allowed_to_simulate": False,
                "allowed_to_print": False, "queue_submission_enabled": False,
                "physical_print_verified": False}

    if (type(verified_evidence) is not dict or
            verified_evidence.get("schema") != "ai0.print_evidence.v1" or
            verified_evidence.get("status") != "EVIDENCE_VERIFIED" or
            verified_evidence.get("allowed_to_print") is not False or
            verified_evidence.get("allowed_to_simulate") is not False or
            verified_evidence.get("physical_print_verified") is not False or
            type(snapshot) is not dict or
            snapshot.get("schema") != "ai0.print_evidence.v1" or
            not _is_sha256(snapshot.get("evidence_sha256")) or
            verified_evidence.get("evidence_sha256") != snapshot.get("evidence_sha256")):
        return hold("CORE_EVIDENCE_NOT_VERIFIED")

    # The evidence digest includes the ordered preview byte digests. Recompute
    # it here too, so a caller cannot pair a valid verifier result with a
    # subsequently changed snapshot or preview list.
    try:
        body = {key: value for key, value in snapshot.items() if key != "evidence_sha256"}
        if _digest(body) != snapshot["evidence_sha256"]:
            return hold("SNAPSHOT_OR_PREVIEW_CHANGED")
    except Exception:
        return hold("SNAPSHOT_OR_PREVIEW_CHANGED")

    if type(trusted_job) is not dict or trusted_job.get("mode") != "simulation":
        return hold("SIMULATION_MODE_REQUIRED")
    if trusted_job.get("state") != "NOT_SENT":
        return hold("JOB_UNCERTAIN_OR_ALREADY_SENT")
    if type(review_receipt) is not dict:
        return hold("CORE_STAFF_REVIEW_RECEIPT_MISSING")
    # AI0/AI1 project this exact tuple from the DB ticket. Reject extra fields
    # so browser approval IDs, role flags and other claims cannot be consumed.
    if set(review_receipt) != RECEIPT_FIELDS:
        return hold("CORE_STAFF_REVIEW_RECEIPT_UNVERIFIED")

    if (not all(type(review_receipt.get(key)) is str and review_receipt[key].strip()
                for key in ("receipt_id", "shop_id", "order_id", "reviewer_id")) or
            type(review_receipt.get("revision")) is not int or
            review_receipt["revision"] < 1 or
            not _is_sha256(review_receipt.get("request_hash")) or
            not _is_sha256(review_receipt.get("evidence_sha256")) or
            not _valid_review_time(review_receipt.get("reviewed_at")) or
            review_receipt.get("decision") != "checked"):
        return hold("CORE_STAFF_REVIEW_RECEIPT_UNVERIFIED")

    scope_fields = ("shop_id", "order_id", "revision", "request_hash", "evidence_sha256")
    if (any(review_receipt.get(name) != snapshot.get(name) for name in scope_fields) or
            any(trusted_job.get(name) != snapshot.get(name) for name in scope_fields) or
            type(snapshot.get("revision")) is not int or snapshot["revision"] < 1):
        return hold("STAFF_REVIEW_STALE_EVIDENCE")

    sources = snapshot.get("sources")
    previews = snapshot.get("previews")
    if (type(sources) is not list or not sources or
            any(type(row) is not dict or row.get("format") not in ("PDF", "DOCX")
                for row in sources) or
            len({row["format"] for row in sources}) != 1 or
            type(previews) is not list or not previews or
            any(type(row) is not dict or not _is_sha256(row.get("sha256"))
                for row in previews) or
            snapshot.get("printer_id") != "RMP7000" or
            trusted_job.get("printer_id") != "RMP7000"):
        return hold("STAFF_REVIEW_OR_PREVIEW_UNVERIFIED")

    return {"schema": SCHEMA, "status": "PREPARED_NOT_SENT",
            "review_status": "EVIDENCE_REVIEWED",
            "reason_code": "CORE_REVIEW_RECEIPT_MATCHED",
            "receipt_id": review_receipt["receipt_id"],
            "evidence_sha256": snapshot["evidence_sha256"],
            "source_formats": tuple(source["format"] for source in sources),
            "mode": "simulation", "allowed_to_simulate": True,
            "allowed_to_print": False, "queue_submission_enabled": False,
            "physical_print_verified": False}
