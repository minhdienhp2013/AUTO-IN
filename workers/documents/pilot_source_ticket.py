"""AI3 validation for the owner-approved pilot source/job contract in PR #163.

This module verifies a Core-produced in-memory ticket and the exact source bytes.
It does not fetch artifacts, authorize a job, or contact a printer.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
import hashlib
import re
from pathlib import PurePosixPath
from typing import Any

from .bridge import _canonical
from . import processor

SHA256 = re.compile(r"^[a-f0-9]{64}$")
MAX_PUBLIC_SOURCE_BYTES = processor.MAX_FILE


class PilotTicketInvalid(ValueError):
    """A Core pilot ticket or its source bytes do not bind exactly."""


@dataclass(frozen=True)
class VerifiedPilotSource:
    job_id: str
    order_id: str
    revision: int
    request_hash: str
    printer_id: str
    source_format: str
    artifact_ref: str
    source_sha256: str
    source_size_bytes: int
    settings: dict[str, Any]
    settings_sha256: str
    evidence_sha256: str
    ticket_sha256: str
    source_bytes: bytes


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _is_sha256(value: object) -> bool:
    return type(value) is str and SHA256.fullmatch(value) is not None


def _contains_raw_code(value: Any) -> bool:
    if isinstance(value, dict):
        return any(key == "code" or _contains_raw_code(item)
                   for key, item in value.items())
    if isinstance(value, (list, tuple)):
        return any(_contains_raw_code(item) for item in value)
    return False


def _valid_artifact_ref(value: object) -> bool:
    if (type(value) is not str or not value or len(value) > 512 or
            "\\" in value or "\x00" in value or ":" in value):
        return False
    path = PurePosixPath(value)
    return (not path.is_absolute() and bool(path.parts) and
            all(part not in ("", ".", "..") for part in path.parts))


def _settings_digest(settings: dict[str, Any]) -> str:
    return _sha256(_canonical(settings).encode("utf-8"))


def _check_settings(settings: object) -> dict[str, Any]:
    if not isinstance(settings, dict) or set(settings) != {
            "copies", "duplex", "paper", "color"}:
        raise PilotTicketInvalid("PILOT_SETTINGS_SHAPE_INVALID")
    if (type(settings["copies"]) is not int or not 1 <= settings["copies"] <= 99 or
            type(settings["duplex"]) is not bool or settings["paper"] != "A4" or
            settings["color"] != "black_white"):
        raise PilotTicketInvalid("PILOT_SETTINGS_UNSUPPORTED")
    # Locked AI0 wire meaning: A4 duplex=True is long-edge, False is simplex.
    return dict(settings)


def _validate_format(source_format: object, source_bytes: object) -> str:
    if type(source_bytes) is not bytes or not 0 < len(source_bytes) <= MAX_PUBLIC_SOURCE_BYTES:
        raise PilotTicketInvalid("SOURCE_SIZE_INVALID")
    if source_format == "PDF":
        if not source_bytes.startswith(b"%PDF-"):
            raise PilotTicketInvalid("SOURCE_FORMAT_MISMATCH")
        try:
            import fitz
            with fitz.open(stream=source_bytes, filetype="pdf") as document:
                if not document.is_pdf or not 1 <= document.page_count <= 10000:
                    raise PilotTicketInvalid("PDF_PAGE_COUNT_INVALID")
        except PilotTicketInvalid:
            raise
        except Exception as exc:
            raise PilotTicketInvalid("PDF_SOURCE_UNREADABLE") from exc
        return "PDF"
    if source_format == "DOCX":
        from agents.windows.native_word_document import _validate_docx
        if not _validate_docx(source_bytes):
            raise PilotTicketInvalid("DOCX_SOURCE_INVALID")
        return "DOCX"
    raise PilotTicketInvalid("PILOT_FORMAT_UNSUPPORTED")


def verify_pilot_source_ticket(*, job: dict[str, Any], candidate: dict[str, Any],
                               authorization: dict[str, Any], source_bytes: bytes,
                               configured_printer_id: str) -> VerifiedPilotSource:
    """Verify the exact #163 Core ticket tuple before journal/driver activity.

    The caller must obtain these objects from the authenticated Core adapter;
    this pure function does not turn arbitrary caller JSON into authorization.
    """
    candidate_fields = {
        "shop_id", "oa_id", "customer_id", "conversation_id", "order_id",
        "revision", "request_hash", "source", "settings", "settings_sha256",
        "printer_id",
    }
    source_fields = {"format", "artifact_ref", "sha256", "size_bytes", "provider_event_id"}
    authorization_fields = {
        "schema", "shop_id", "oa_id", "customer_id", "order_id", "revision",
        "request_hash", "source_sha256", "settings_sha256", "evidence_sha256",
        "printer_id", "code_window_id", "provider_event_id", "authorized_at", "job_id",
    }
    if not all(isinstance(x, dict) for x in (job, candidate, authorization)):
        raise PilotTicketInvalid("PILOT_TICKET_SHAPE_INVALID")
    if _contains_raw_code((job, candidate, authorization)):
        raise PilotTicketInvalid("RAW_CODE_MUST_NOT_REACH_AGENT")
    if set(candidate) != candidate_fields:
        raise PilotTicketInvalid("PILOT_CANDIDATE_SHAPE_INVALID")
    source = candidate.get("source")
    if not isinstance(source, dict) or set(source) != source_fields:
        raise PilotTicketInvalid("PILOT_SOURCE_SHAPE_INVALID")
    if set(authorization) != authorization_fields:
        raise PilotTicketInvalid("PILOT_AUTHORIZATION_SHAPE_INVALID")
    if authorization.get("schema") != "ai0.pilot_print_authorization.v1":
        raise PilotTicketInvalid("PILOT_AUTHORIZATION_SCHEMA_INVALID")

    for field in ("shop_id", "oa_id", "customer_id", "conversation_id", "order_id"):
        if type(candidate.get(field)) is not str or not candidate[field]:
            raise PilotTicketInvalid("PILOT_IDENTITY_INVALID")
    for field in ("job_id", "order_id", "request_hash", "printer_id", "lease_token"):
        if type(job.get(field)) is not str or not job[field]:
            raise PilotTicketInvalid("PILOT_JOB_IDENTITY_INVALID")
    if type(job.get("revision")) is not int:
        raise PilotTicketInvalid("PILOT_JOB_IDENTITY_INVALID")
    # Pilot authorization is a distinct path. A legacy staff approval ticket
    # must never be silently repurposed as a shop-code pilot grant.
    if "approval_id" in job:
        raise PilotTicketInvalid("LEGACY_APPROVAL_TICKET_NOT_PILOT_AUTHORIZATION")
    if (type(candidate["revision"]) is not int or candidate["revision"] < 1 or
            type(job["revision"]) is not int or
            type(authorization["revision"]) is not int or
            candidate["revision"] != job["revision"] or
            candidate["revision"] != authorization["revision"]):
        raise PilotTicketInvalid("PILOT_REVISION_MISMATCH")
    for field in ("job_id", "order_id", "revision", "request_hash", "printer_id"):
        auth_field = "job_id" if field == "job_id" else field
        if authorization.get(auth_field) != job.get(field):
            raise PilotTicketInvalid("PILOT_JOB_AUTHORIZATION_MISMATCH")
    for field in ("shop_id", "oa_id", "customer_id", "order_id", "revision",
                  "request_hash", "printer_id"):
        if authorization.get(field) != candidate.get(field):
            raise PilotTicketInvalid("PILOT_CANDIDATE_AUTHORIZATION_MISMATCH")
    if candidate.get("printer_id") != configured_printer_id:
        raise PilotTicketInvalid("PILOT_PRINTER_ID_MISMATCH")

    for field in ("request_hash", "settings_sha256"):
        if not _is_sha256(candidate.get(field)):
            raise PilotTicketInvalid("PILOT_DIGEST_INVALID")
    for field in ("request_hash", "source_sha256", "settings_sha256", "evidence_sha256"):
        if not _is_sha256(authorization.get(field)):
            raise PilotTicketInvalid("PILOT_AUTHORIZATION_DIGEST_INVALID")
    if not _is_sha256(source.get("sha256")):
        raise PilotTicketInvalid("PILOT_SOURCE_DIGEST_INVALID")
    if (type(source.get("size_bytes")) is not int or
            source["size_bytes"] != len(source_bytes) or
            _sha256(source_bytes) != source["sha256"]):
        raise PilotTicketInvalid("PILOT_SOURCE_BYTES_MISMATCH")
    if not _valid_artifact_ref(source.get("artifact_ref")):
        raise PilotTicketInvalid("PILOT_ARTIFACT_REF_INVALID")
    if type(source.get("provider_event_id")) is not str or not source["provider_event_id"]:
        raise PilotTicketInvalid("PILOT_PROVIDER_EVENT_INVALID")
    for field in ("code_window_id", "provider_event_id", "job_id"):
        if type(authorization.get(field)) is not str or not authorization[field]:
            raise PilotTicketInvalid("PILOT_AUTHORIZATION_IDENTITY_INVALID")
    if authorization.get("provider_event_id") != source.get("provider_event_id"):
        raise PilotTicketInvalid("PILOT_PROVIDER_EVENT_MISMATCH")
    if type(authorization.get("authorized_at")) is not str:
        raise PilotTicketInvalid("PILOT_AUTHORIZATION_TIME_INVALID")
    try:
        datetime.fromisoformat(authorization["authorized_at"].replace("Z", "+00:00"))
    except ValueError as exc:
        raise PilotTicketInvalid("PILOT_AUTHORIZATION_TIME_INVALID") from exc

    settings = _check_settings(candidate.get("settings"))
    settings_sha256 = _settings_digest(settings)
    if (settings_sha256 != candidate.get("settings_sha256") or
            settings_sha256 != authorization.get("settings_sha256")):
        raise PilotTicketInvalid("PILOT_SETTINGS_DIGEST_MISMATCH")
    if authorization.get("source_sha256") != source.get("sha256"):
        raise PilotTicketInvalid("PILOT_AUTHORIZATION_SOURCE_MISMATCH")
    if job.get("request_hash") != candidate.get("request_hash"):
        raise PilotTicketInvalid("PILOT_REQUEST_HASH_MISMATCH")
    if job.get("printer_id") != candidate.get("printer_id"):
        raise PilotTicketInvalid("PILOT_JOB_PRINTER_MISMATCH")

    source_format = _validate_format(source.get("format"), source_bytes)
    ticket_record = {
        "job": {key: job[key] for key in ("job_id", "order_id", "revision", "request_hash", "printer_id")},
        "candidate": candidate,
        "authorization": authorization,
        "source_sha256": source["sha256"],
        "settings_sha256": settings_sha256,
    }
    ticket_sha256 = _sha256(_canonical(ticket_record).encode("utf-8"))
    return VerifiedPilotSource(
        job_id=job["job_id"], order_id=job["order_id"], revision=job["revision"],
        request_hash=job["request_hash"], printer_id=job["printer_id"],
        source_format=source_format, artifact_ref=source["artifact_ref"],
        source_sha256=source["sha256"], source_size_bytes=len(source_bytes),
        settings=settings, settings_sha256=settings_sha256,
        evidence_sha256=authorization["evidence_sha256"], ticket_sha256=ticket_sha256,
        source_bytes=source_bytes,
    )
