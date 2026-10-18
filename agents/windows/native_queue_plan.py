"""Ricoh IM7000/RMP7000 queue *planning only* (no Windows spooler I/O).

An observed queue is NOT proof of the physical printer or paper. Even when all
metadata matches, printing remains forbidden until separately authorized,
job-scoped backend CAS + durable journal + supervised device acceptance.
"""
from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Any

SCHEMA = "ai3.native_queue_plan.v1"
HEX = re.compile(r"^[0-9a-f]{64}$")


@dataclass(frozen=True)
class ObservedQueue:
    # Values must come from privileged Windows print-inventory probe, never job.
    queue_name: str
    printer_model: str
    driver_name: str
    port_name: str
    printer_id: str


def plan_native_ricoh(*, observed: ObservedQueue | None, sealed_job: dict[str, Any],
                      verified_evidence: dict[str, Any], file_format: str,
                      settings: dict[str, Any],
                      host_windows_verified: bool = False) -> dict[str, Any]:
    def block(reason: str) -> dict[str, Any]:
        return {"schema": SCHEMA, "status": "NEEDS_HUMAN",
                "reason_code": reason, "allowed_to_simulate": False,
                "allowed_to_print": False, "queue_submission_enabled": False,
                "paper_verified": False, "physical_print_verified": False}
    if not host_windows_verified:
        return block("WINDOWS_INVENTORY_NOT_VERIFIED")
    if not isinstance(observed, ObservedQueue):
        return block("PRINTER_INVENTORY_UNAVAILABLE")
    if not isinstance(sealed_job, dict) or not isinstance(verified_evidence, dict):
        return block("JOB_EVIDENCE_UNVERIFIED")
    if (sealed_job.get("state") != "NOT_SENT" or
            any(sealed_job.get(key) != verified_evidence.get(key) for key in (
                "shop_id", "order_id", "job_id", "revision", "request_hash",
                "approval_id", "printer_id", "evidence_sha256", "mode"))):
        return block("JOB_REVIEW_SCOPE_OR_REPLAY")
    # No default printer or fallback to Canon. Serial identity and actual tray
    # verification require owner-controlled device acceptance, not this seam.
    if (observed.queue_name != "RMP7000" or
            observed.printer_id != "RMP7000" or
            "Ricoh" not in observed.printer_model or
            "IM7000" not in observed.printer_model.replace(" ", "") or
            "PCL6" not in observed.driver_name.upper() or
            not observed.port_name or
            sealed_job.get("printer_id") != observed.printer_id):
        return block("RICOH_QUEUE_OR_DRIVER_CHANGED")
    if sealed_job.get("mode") != "simulation":
        return block("MODE_UNAUTHORIZED")
    if file_format not in ("PDF", "DOCX"):
        return block("NATIVE_FORMAT_UNSUPPORTED")
    # The input is the reviewed no-print result from Core's exact ticket gate.
    # An evidence digest by itself, or a client review flag, is insufficient.
    if (verified_evidence.get("status") != "PREPARED_NOT_SENT" or
            verified_evidence.get("mode") != "simulation" or
            verified_evidence.get("allowed_to_simulate") is not True or
            verified_evidence.get("allowed_to_print") is not False or
            verified_evidence.get("queue_submission_enabled") is not False or
            verified_evidence.get("physical_print_verified") is not False or
            verified_evidence.get("printer_id") != "RMP7000" or
            not isinstance(verified_evidence.get("receipt_id"), str) or
            not verified_evidence["receipt_id"].strip() or
            not isinstance(verified_evidence.get("evidence_sha256"), str) or
            HEX.fullmatch(verified_evidence["evidence_sha256"]) is None or
            type(verified_evidence.get("source_formats")) not in (tuple, list) or
            file_format not in verified_evidence["source_formats"]):
        return block("MANIFEST_OR_STAFF_REVIEW_INCOMPLETE")
    if not isinstance(settings, dict) or settings.get("paper") not in ("A4", "A3"):
        return block("PAPER_SETTING_UNVERIFIED")
    if (type(settings.get("copies")) is not int or
            not 1 <= settings["copies"] <= 999 or
            type(settings.get("duplex")) is not bool or
            settings.get("orientation") not in ("portrait", "landscape") or
            settings.get("binding") not in ("long_edge", "short_edge")):
        return block("PRINT_SETTINGS_UNVERIFIED")
    return {"schema": SCHEMA, "status": "PREPARED_NOT_SENT",
            "reason_code": "PHYSICAL_DEVICE_AND_STAFF_ACCEPTANCE_PENDING",
            "printer_id": "RMP7000", "queue_name": "RMP7000",
            "native_application": "Word.Application" if file_format == "DOCX" else "PDF_NATIVE",
            "print_source_format": file_format,
            "paper": settings["paper"], "copies": settings["copies"],
            "duplex": settings["duplex"], "orientation": settings["orientation"],
            "binding": settings["binding"],
            "scale_mode": "shrink_to_printable_area_only",
            "allowed_to_simulate": True, "allowed_to_print": False,
            "queue_submission_enabled": False, "paper_verified": False,
            "physical_print_verified": False}
