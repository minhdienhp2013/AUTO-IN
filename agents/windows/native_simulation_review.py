"""Core-receipt-gated, simulation-only review of native print evidence.

This module performs no driver, COM, spooler, network, queue mutation, print
job creation or retry. The preflight envelope must come from AI1 over the
authenticated agent HTTPS session; a browser DTO or a client-built review
object is never accepted as authority. A passing result remains unsent.
"""
from __future__ import annotations

import hashlib
from typing import Any

from workers.documents.bridge import _canonical
from workers.documents.native_job_binding import (
    is_safe_core_preflight_result,
    validate_core_preflight_ticket,
)

SCHEMA = "ai3.staff_review_simulation.v1"
HEX = frozenset("0123456789abcdef")


def _is_sha256(value: Any) -> bool:
    return (type(value) is str and len(value) == 64 and
            all(char in HEX for char in value))


def review_simulation_only(*, verified_evidence: dict[str, Any],
                           snapshot: dict[str, Any],
                           preflight_ticket: dict[str, Any] | None,
                           claimed_job: dict[str, Any]) -> dict[str, Any]:
    """Require the current Core review receipt before a no-print simulation.

    The receipt, evidence and job projections are checked together by
    ``validate_core_preflight_ticket``. Staff identity/authorization is
    established when Core persists the receipt, not by a caller-supplied role
    flag. This function only confirms the exact current evidence digest and
    preview list, then returns PREPARED_NOT_SENT.
    """
    def hold(reason: str) -> dict[str, Any]:
        return {"schema": SCHEMA, "status": "NEEDS_HUMAN",
                "reason_code": reason, "allowed_to_simulate": False,
                "allowed_to_print": False, "queue_submission_enabled": False,
                "physical_print_verified": False}

    if (type(verified_evidence) is not dict or
            verified_evidence.get("schema") not in
            ("ai0.print_evidence.v1", "ai3.native_job_binding.v1") or
            verified_evidence.get("status") != "EVIDENCE_VERIFIED" or
            verified_evidence.get("allowed_to_print") is not False or
            verified_evidence.get("allowed_to_simulate") is not False or
            verified_evidence.get("physical_print_verified") is not False or
            type(snapshot) is not dict or
            snapshot.get("schema") != "ai0.print_evidence.v1" or
            not _is_sha256(snapshot.get("evidence_sha256")) or
            verified_evidence.get("evidence_sha256") != snapshot.get("evidence_sha256")):
        return hold("CORE_EVIDENCE_NOT_VERIFIED")

    try:
        body = {key: value for key, value in snapshot.items()
                if key != "evidence_sha256"}
        digest = hashlib.sha256(_canonical(body).encode("utf-8")).hexdigest()
    except Exception:
        return hold("SNAPSHOT_OR_PREVIEW_CHANGED")
    if digest != snapshot["evidence_sha256"]:
        return hold("SNAPSHOT_OR_PREVIEW_CHANGED")

    result = validate_core_preflight_ticket(
        preflight_ticket=preflight_ticket, claimed_job=claimed_job)
    if (result.get("status") != "PREPARED_NOT_SENT" or
            not is_safe_core_preflight_result(
                result, preflight_ticket=preflight_ticket)):
        return hold(result.get("reason_code", "CORE_REVIEW_RECEIPT_REQUIRED"))

    evidence = preflight_ticket["trusted_evidence"]
    previews = snapshot.get("previews")
    sources = snapshot.get("sources")
    if (snapshot["evidence_sha256"] != evidence.get("evidence_sha256") or
            snapshot.get("shop_id") != evidence.get("shop_id") or
            snapshot.get("order_id") != evidence.get("order_id") or
            snapshot.get("revision") != evidence.get("revision") or
            snapshot.get("request_hash") != evidence.get("request_hash") or
            snapshot.get("settings_sha256") != evidence.get("settings_sha256") or
            snapshot.get("renderer_sha256") != evidence.get("renderer_sha256") or
            snapshot.get("printer_capability_sha256") != evidence.get("printer_capability_sha256") or
            snapshot.get("printer_id") != "RMP7000" or
            type(previews) is not list or not previews or
            any(type(item) is not dict or not _is_sha256(item.get("sha256"))
                for item in previews) or
            [item["sha256"] for item in previews] != evidence.get("preview_sha256") or
            type(sources) is not list or not sources or
            any(type(item) is not dict or item.get("format") not in ("PDF", "DOCX")
                for item in sources) or
            len({item["format"] for item in sources}) != 1):
        return hold("STAFF_REVIEW_OR_PREVIEW_UNVERIFIED")

    trusted_job = preflight_ticket["trusted_job"]
    return {**result, "schema": SCHEMA,
            "source_formats": tuple(item["format"] for item in sources),
            "settings_sha256": snapshot["settings_sha256"],
            "renderer_sha256": snapshot["renderer_sha256"],
            "printer_capability_sha256": snapshot["printer_capability_sha256"],
            "preview_sha256": tuple(item["sha256"] for item in previews),
            "shop_id": trusted_job["shop_id"],
            "order_id": trusted_job["order_id"],
            "job_id": trusted_job["job_id"],
            "revision": trusted_job["revision"],
            "request_hash": trusted_job["request_hash"],
            "approval_id": trusted_job["approval_id"],
            "printer_id": trusted_job["printer_id"]}
