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
PREFLIGHT_SCHEMA = "ai3.core_preflight_review_simulation.v1"
RECEIPT_FIELDS = frozenset({
    "receipt_id", "shop_id", "order_id", "revision", "request_hash",
    "evidence_sha256", "reviewer_id", "reviewed_at", "decision",
})
PREFLIGHT_FIELDS = frozenset({
    "allowed", "job_id", "revision", "mode", "approval_id",
    "document_evidence_verified", "review_receipt", "trusted_evidence",
    "trusted_job",
})
TRUSTED_EVIDENCE_FIELDS = frozenset({
    "schema", "shop_id", "order_id", "revision", "request_hash",
    "evidence_sha256", "settings_sha256", "renderer_sha256",
    "printer_capability_sha256", "preview_sha256", "printer_id",
})
TRUSTED_JOB_FIELDS = frozenset({
    "job_id", "shop_id", "order_id", "revision", "request_hash",
    "approval_id", "printer_id", "evidence_sha256", "mode", "state",
})
PREFLIGHT_RESULT_FIELDS = frozenset({
    "schema", "status", "review_status", "reason_code", "receipt_id",
    "evidence_sha256", "mode", "allowed_to_simulate", "allowed_to_print",
    "queue_submission_enabled", "physical_print_verified",
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


def review_preflight_ticket_simulation_only(*, preflight_ticket: dict[str, Any] | None,
                                           claimed_job: dict[str, Any]) -> dict[str, Any]:
    """Validate AI1's authenticated HTTPS preflight envelope for simulation.

    The server builds this compact ticket after checking the private evidence
    Port and DB receipt. This function cross-checks its fields against the
    claimed job; HttpBackendClient separately binds it to the exact lease. It
    cannot authenticate a dict supplied outside HTTPS and never accepts
    browser approval/role/print flags.
    """
    def hold(reason: str) -> dict[str, Any]:
        return {"schema": PREFLIGHT_SCHEMA, "status": "NEEDS_HUMAN",
                "review_status": "NOT_REVIEWED", "reason_code": reason,
                "receipt_id": None, "evidence_sha256": None, "mode": None,
                "allowed_to_simulate": False, "allowed_to_print": False,
                "queue_submission_enabled": False, "physical_print_verified": False}

    if (type(preflight_ticket) is not dict or
            set(preflight_ticket) != PREFLIGHT_FIELDS or
            type(claimed_job) is not dict):
        return hold("CORE_PREFLIGHT_TICKET_MISSING_OR_MALFORMED")
    if preflight_ticket.get("document_evidence_verified") is not True:
        return hold("COMPOSITION_EVIDENCE_UNVERIFIED")

    job_fields = ("job_id", "order_id", "approval_id", "lease_token", "printer_id")
    if (not all(type(claimed_job.get(name)) is str and claimed_job[name].strip()
                for name in job_fields) or
            type(claimed_job.get("revision")) is not int or
            claimed_job["revision"] < 1 or
            not _is_sha256(claimed_job.get("request_hash")) or
            claimed_job.get("mode") != "simulation" or
            claimed_job.get("printer_id") != "RMP7000"):
        return hold("CLAIMED_JOB_SCOPE_INVALID")

    if (preflight_ticket.get("allowed") is not True or
            preflight_ticket.get("job_id") != claimed_job.get("job_id") or
            type(preflight_ticket.get("revision")) is not int or
            preflight_ticket.get("revision") != claimed_job.get("revision") or
            preflight_ticket.get("approval_id") != claimed_job.get("approval_id") or
            preflight_ticket.get("mode") != claimed_job.get("mode")):
        return hold("CORE_PREFLIGHT_DENIED_OR_STALE")

    receipt = preflight_ticket.get("review_receipt")
    evidence = preflight_ticket.get("trusted_evidence")
    trusted_job = preflight_ticket.get("trusted_job")
    if (type(receipt) is not dict or set(receipt) != RECEIPT_FIELDS or
            type(evidence) is not dict or set(evidence) != TRUSTED_EVIDENCE_FIELDS or
            type(trusted_job) is not dict or set(trusted_job) != TRUSTED_JOB_FIELDS):
        return hold("CORE_PREFLIGHT_PROOF_MALFORMED")

    if (not all(type(receipt.get(name)) is str and receipt[name].strip()
                for name in ("receipt_id", "shop_id", "order_id", "reviewer_id")) or
            type(receipt.get("revision")) is not int or receipt["revision"] < 1 or
            not _is_sha256(receipt.get("request_hash")) or
            not _is_sha256(receipt.get("evidence_sha256")) or
            not _valid_review_time(receipt.get("reviewed_at")) or
            receipt.get("decision") != "checked"):
        return hold("CORE_REVIEW_RECEIPT_UNVERIFIED")

    evidence_ids = ("shop_id", "order_id", "printer_id")
    evidence_hashes = ("request_hash", "evidence_sha256", "settings_sha256",
                       "renderer_sha256", "printer_capability_sha256")
    previews = evidence.get("preview_sha256")
    if (evidence.get("schema") != "ai0.print_evidence.v1" or
            not all(type(evidence.get(name)) is str and evidence[name].strip()
                    for name in evidence_ids) or
            not all(_is_sha256(evidence.get(name)) for name in evidence_hashes) or
            type(evidence.get("revision")) is not int or evidence["revision"] < 1 or
            type(previews) is not list or not previews or
            any(not _is_sha256(digest) for digest in previews) or
            evidence.get("printer_id") != "RMP7000"):
        return hold("CORE_TRUSTED_EVIDENCE_UNVERIFIED")

    trusted_job_strings = ("job_id", "shop_id", "order_id", "approval_id", "printer_id")
    if (not all(type(trusted_job.get(name)) is str and trusted_job[name].strip()
                for name in trusted_job_strings) or
            type(trusted_job.get("revision")) is not int or trusted_job["revision"] < 1 or
            not _is_sha256(trusted_job.get("request_hash")) or
            not _is_sha256(trusted_job.get("evidence_sha256")) or
            trusted_job.get("mode") != "simulation" or
            trusted_job.get("state") != "NOT_SENT" or
            trusted_job.get("printer_id") != "RMP7000"):
        return hold("CORE_TRUSTED_JOB_UNVERIFIED")

    scope_names = ("shop_id", "order_id", "revision", "request_hash", "evidence_sha256")
    sources = (receipt, evidence, trusted_job)
    if (any(any(source.get(name) != receipt.get(name) for name in scope_names)
            for source in sources[1:]) or
            trusted_job.get("job_id") != claimed_job.get("job_id") or
            trusted_job.get("order_id") != claimed_job.get("order_id") or
            trusted_job.get("revision") != claimed_job.get("revision") or
            trusted_job.get("request_hash") != claimed_job.get("request_hash") or
            trusted_job.get("approval_id") != claimed_job.get("approval_id") or
            trusted_job.get("printer_id") != claimed_job.get("printer_id") or
            trusted_job.get("mode") != claimed_job.get("mode")):
        return hold("CORE_REVIEW_SCOPE_OR_EVIDENCE_STALE")

    return {"schema": PREFLIGHT_SCHEMA, "status": "PREPARED_NOT_SENT",
            "review_status": "EVIDENCE_REVIEWED",
            "reason_code": "CORE_REVIEW_RECEIPT_MATCHED",
            "receipt_id": receipt["receipt_id"],
            "evidence_sha256": evidence["evidence_sha256"],
            "mode": "simulation", "allowed_to_simulate": True,
            "allowed_to_print": False, "queue_submission_enabled": False,
            "physical_print_verified": False}


def is_safe_preflight_review_result(result: Any, *,
                                    preflight_ticket: dict[str, Any] | None) -> bool:
    """Accept only this gate's exact no-print simulation outcome."""
    if (type(result) is not dict or set(result) != PREFLIGHT_RESULT_FIELDS or
            type(preflight_ticket) is not dict or
            type(preflight_ticket.get("review_receipt")) is not dict or
            type(preflight_ticket.get("trusted_evidence")) is not dict):
        return False
    receipt = preflight_ticket["review_receipt"]
    evidence = preflight_ticket["trusted_evidence"]
    expected = {
        "schema": PREFLIGHT_SCHEMA,
        "status": "PREPARED_NOT_SENT",
        "review_status": "EVIDENCE_REVIEWED",
        "reason_code": "CORE_REVIEW_RECEIPT_MATCHED",
        "receipt_id": receipt.get("receipt_id"),
        "evidence_sha256": evidence.get("evidence_sha256"),
        "mode": "simulation",
        "allowed_to_simulate": True,
        "allowed_to_print": False,
        "queue_submission_enabled": False,
        "physical_print_verified": False,
    }
    boolean_fields = ("allowed_to_simulate", "allowed_to_print",
                      "queue_submission_enabled", "physical_print_verified")
    return (all(type(result.get(field)) is bool and result[field] is expected[field]
                for field in boolean_fields) and
            all(result.get(field) == value for field, value in expected.items()
                if field not in boolean_fields))


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
