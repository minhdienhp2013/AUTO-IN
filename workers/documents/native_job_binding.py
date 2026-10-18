"""V1-NATIVE-01: verify a server-owned, exact-revision Word/PDF print candidate.

This is a pure verification gate, never a sender or a customer-created ticket.
An approved server Port must obtain job/approval and anchor from trusted Core DB.
A successful check is *necessary*, not sufficient, for live printer access.
"""
from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from typing import Any

from . import processor
from .bridge import _canonical
from .print_evidence_v1 import verify_print_evidence_v1

SCHEMA = "ai3.native_job_binding.v1"
HEX = re.compile(r"^[a-f0-9]{64}$")
REF = re.compile(r"^doc-[A-Za-z0-9_-]{6,64}/manifest\.json$")
SOURCE = re.compile(r"^doc-[A-Za-z0-9_-]{6,64}/source-\d{3}-[a-f0-9]{64}\.(?:pdf|docx)$")
PNG = re.compile(r"^doc-[A-Za-z0-9_-]{6,64}/[A-Za-z0-9_-]+-p[1-9]\d*\.png$")
EVIDENCE_FIELDS = frozenset({
    "schema", "shop_id", "order_id", "revision", "request_hash", "sources",
    "source_set_sha256", "settings_sha256", "manifest_ref", "manifest_sha256",
    "previews", "renderer_sha256", "plan_sha256", "printer_id",
    "printer_capability_sha256", "evidence_sha256",
})
PREFLIGHT_FIELDS = frozenset({
    "allowed", "job_id", "revision", "mode", "approval_id", "review_receipt",
    "trusted_evidence", "trusted_job",
})
RECEIPT_FIELDS = frozenset({
    "receipt_id", "shop_id", "order_id", "revision", "request_hash",
    "evidence_sha256", "reviewer_id", "reviewed_at", "decision",
})
CORE_EVIDENCE_FIELDS = frozenset({
    "schema", "shop_id", "order_id", "revision", "request_hash",
    "evidence_sha256", "settings_sha256", "renderer_sha256",
    "printer_capability_sha256", "preview_sha256", "printer_id",
})
CORE_JOB_FIELDS = frozenset({
    "job_id", "shop_id", "order_id", "revision", "request_hash",
    "approval_id", "printer_id", "evidence_sha256", "mode", "state",
})
TICKET_GATE_FIELDS = frozenset({
    "schema", "status", "review_status", "reason_code", "receipt_id",
    "evidence_sha256", "mode", "allowed_to_simulate", "allowed_to_print",
    "queue_submission_enabled", "physical_print_verified",
})


def _hash(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _digest(value: Any) -> bool:
    return type(value) is str and HEX.fullmatch(value) is not None


def _review_time(value: Any) -> bool:
    if type(value) is not str or not value:
        return False
    from datetime import datetime
    try:
        parsed = datetime.fromisoformat(value[:-1] + "+00:00" if value.endswith("Z") else value)
    except ValueError:
        return False
    return parsed.tzinfo is not None and parsed.utcoffset() is not None


def validate_core_preflight_ticket(*, preflight_ticket: dict[str, Any] | None,
                                   claimed_job: dict[str, Any]) -> dict[str, Any]:
    """Validate the exact AI1 HTTPS preflight projection before native review.

    The caller must obtain this ticket from HttpBackendClient over its scoped
    HTTPS session. It is never a browser DTO. Core remains the authority for
    staff authentication, receipt persistence, active revision and approval.
    This pure check binds the server projection to the exact claimed lease.
    """
    def hold(reason: str) -> dict[str, Any]:
        return {"schema": "ai3.core_preflight_review_simulation.v1",
                "status": "NEEDS_HUMAN", "review_status": "NOT_REVIEWED",
                "reason_code": reason, "receipt_id": None, "evidence_sha256": None,
                "mode": None, "allowed_to_simulate": False,
                "allowed_to_print": False, "queue_submission_enabled": False,
                "physical_print_verified": False}

    if (type(preflight_ticket) is not dict or set(preflight_ticket) != PREFLIGHT_FIELDS or
            type(claimed_job) is not dict):
        return hold("CORE_PREFLIGHT_TICKET_MISSING_OR_MALFORMED")
    if any(name in claimed_job for name in (
            "allowed", "allowed_to_print", "document_evidence_verified",
            "review_receipt", "trusted_evidence", "trusted_job")):
        return hold("CLIENT_AUTHORITY_FIELDS_FORBIDDEN")
    # Do not read client supplied approval or evidence flags outside the signed-in
    # server projection. Even a correctly typed boolean in a job body is ignored.
    if (not all(type(claimed_job.get(name)) is str and claimed_job[name].strip()
                for name in ("job_id", "order_id", "approval_id", "lease_token", "printer_id")) or
            type(claimed_job.get("revision")) is not int or claimed_job["revision"] < 1 or
            not _digest(claimed_job.get("request_hash")) or
            claimed_job.get("mode") != "simulation" or
            claimed_job.get("printer_id") != "RMP7000"):
        return hold("CLAIMED_JOB_SCOPE_INVALID")
    if (type(preflight_ticket.get("allowed")) is not bool or
            preflight_ticket["allowed"] is not True or
            preflight_ticket.get("job_id") != claimed_job["job_id"] or
            type(preflight_ticket.get("revision")) is not int or
            preflight_ticket["revision"] != claimed_job["revision"] or
            preflight_ticket.get("approval_id") != claimed_job["approval_id"] or
            preflight_ticket.get("mode") != claimed_job["mode"]):
        return hold("CORE_PREFLIGHT_DENIED_OR_STALE")

    receipt = preflight_ticket.get("review_receipt")
    evidence = preflight_ticket.get("trusted_evidence")
    job = preflight_ticket.get("trusted_job")
    if (type(receipt) is not dict or set(receipt) != RECEIPT_FIELDS or
            type(evidence) is not dict or set(evidence) != CORE_EVIDENCE_FIELDS or
            type(job) is not dict or set(job) != CORE_JOB_FIELDS):
        return hold("CORE_PREFLIGHT_PROOF_MALFORMED")
    if (not all(type(receipt.get(name)) is str and receipt[name].strip()
                for name in ("receipt_id", "shop_id", "order_id", "reviewer_id")) or
            type(receipt.get("revision")) is not int or receipt["revision"] < 1 or
            not _digest(receipt.get("request_hash")) or
            not _digest(receipt.get("evidence_sha256")) or
            not _review_time(receipt.get("reviewed_at")) or
            receipt.get("decision") != "checked"):
        return hold("CORE_REVIEW_RECEIPT_UNVERIFIED")
    previews = evidence.get("preview_sha256")
    if (evidence.get("schema") != "ai0.print_evidence.v1" or
            not all(type(evidence.get(name)) is str and evidence[name].strip()
                    for name in ("shop_id", "order_id", "printer_id")) or
            type(evidence.get("revision")) is not int or evidence["revision"] < 1 or
            not _digest(evidence.get("request_hash")) or
            not _digest(evidence.get("evidence_sha256")) or
            not _digest(evidence.get("settings_sha256")) or
            not _digest(evidence.get("renderer_sha256")) or
            not _digest(evidence.get("printer_capability_sha256")) or
            type(previews) is not list or not previews or
            any(not _digest(value) for value in previews) or
            evidence.get("printer_id") != "RMP7000"):
        return hold("CORE_TRUSTED_EVIDENCE_UNVERIFIED")
    if (not all(type(job.get(name)) is str and job[name].strip()
                for name in ("job_id", "shop_id", "order_id", "approval_id", "printer_id")) or
            type(job.get("revision")) is not int or job["revision"] < 1 or
            not _digest(job.get("request_hash")) or
            not _digest(job.get("evidence_sha256")) or
            job.get("mode") != "simulation" or job.get("state") != "NOT_SENT" or
            job.get("printer_id") != "RMP7000"):
        return hold("CORE_TRUSTED_JOB_UNVERIFIED")

    scope = ("shop_id", "order_id", "revision", "request_hash", "evidence_sha256")
    if (any(any(source.get(name) != receipt.get(name) for name in scope)
            for source in (evidence, job)) or
            job.get("job_id") != claimed_job.get("job_id") or
            job.get("order_id") != claimed_job.get("order_id") or
            job.get("revision") != claimed_job.get("revision") or
            job.get("request_hash") != claimed_job.get("request_hash") or
            job.get("approval_id") != claimed_job.get("approval_id") or
            job.get("printer_id") != claimed_job.get("printer_id") or
            job.get("mode") != claimed_job.get("mode") or
            ("shop_id" in claimed_job and claimed_job.get("shop_id") != job.get("shop_id")) or
            ("evidence_sha256" in claimed_job and
             claimed_job.get("evidence_sha256") != job.get("evidence_sha256")) or
            ("state" in claimed_job and claimed_job.get("state") != "NOT_SENT")):
        return hold("CORE_REVIEW_SCOPE_OR_EVIDENCE_STALE")
    return {"schema": "ai3.core_preflight_review_simulation.v1",
            "status": "PREPARED_NOT_SENT", "review_status": "EVIDENCE_REVIEWED",
            "reason_code": "CORE_REVIEW_RECEIPT_MATCHED",
            "receipt_id": receipt["receipt_id"],
            "evidence_sha256": evidence["evidence_sha256"],
            "mode": "simulation", "allowed_to_simulate": True,
            "allowed_to_print": False, "queue_submission_enabled": False,
            "physical_print_verified": False}


def is_safe_core_preflight_result(result: Any, *,
                                  preflight_ticket: dict[str, Any] | None) -> bool:
    if (type(result) is not dict or set(result) != TICKET_GATE_FIELDS or
            type(preflight_ticket) is not dict or
            type(preflight_ticket.get("review_receipt")) is not dict or
            type(preflight_ticket.get("trusted_evidence")) is not dict):
        return False
    receipt = preflight_ticket["review_receipt"]
    evidence = preflight_ticket["trusted_evidence"]
    expected = {
        "schema": "ai3.core_preflight_review_simulation.v1",
        "status": "PREPARED_NOT_SENT", "review_status": "EVIDENCE_REVIEWED",
        "reason_code": "CORE_REVIEW_RECEIPT_MATCHED",
        "receipt_id": receipt.get("receipt_id"),
        "evidence_sha256": evidence.get("evidence_sha256"),
        "mode": "simulation", "allowed_to_simulate": True,
        "allowed_to_print": False, "queue_submission_enabled": False,
        "physical_print_verified": False,
    }
    booleans = ("allowed_to_simulate", "allowed_to_print",
                "queue_submission_enabled", "physical_print_verified")
    return (all(type(result.get(key)) is bool and result[key] is expected[key]
                for key in booleans) and
            all(result.get(key) == value for key, value in expected.items()
                if key not in booleans))


def _snapshot_matches_ticket(snapshot: Any, ticket: dict[str, Any]) -> bool:
    if (type(snapshot) is not dict or set(snapshot) != EVIDENCE_FIELDS or
            snapshot.get("schema") != "ai0.print_evidence.v1"):
        return False
    evidence = ticket["trusted_evidence"]
    if (snapshot.get("evidence_sha256") != evidence.get("evidence_sha256") or
            snapshot.get("shop_id") != evidence.get("shop_id") or
            snapshot.get("order_id") != evidence.get("order_id") or
            snapshot.get("revision") != evidence.get("revision") or
            snapshot.get("request_hash") != evidence.get("request_hash") or
            snapshot.get("settings_sha256") != evidence.get("settings_sha256") or
            snapshot.get("renderer_sha256") != evidence.get("renderer_sha256") or
            snapshot.get("printer_capability_sha256") != evidence.get("printer_capability_sha256") or
            snapshot.get("printer_id") != evidence.get("printer_id") or
            type(snapshot.get("previews")) is not list or
            [item.get("sha256") for item in snapshot["previews"] if type(item) is dict] !=
            evidence.get("preview_sha256") or
            len(snapshot["previews"]) != len(evidence.get("preview_sha256", []))):
        return False
    if (not _digest(snapshot.get("source_set_sha256")) or
            not _digest(snapshot.get("manifest_sha256")) or
            not _digest(snapshot.get("plan_sha256"))):
        return False
    try:
        body = {key: value for key, value in snapshot.items() if key != "evidence_sha256"}
        return _hash(_canonical(body).encode("utf-8")) == snapshot["evidence_sha256"]
    except Exception:
        return False


@dataclass(frozen=True)
class TrustedNativeJob:
    """Must be built by AI0/AI1 from authenticated DB rows, not inbound JSON."""

    shop_id: str
    order_id: str
    job_id: str
    revision: int
    request_hash: str
    approval_id: str
    printer_id: str
    manifest_ref: str
    manifest_sha256: str
    source_sha256: str
    settings_sha256: str
    preview_sha256: tuple[str, ...]
    active_revision: int
    lease_token: str
    evidence_sha256: str = ""


def verify_native_job(job: dict[str, Any], trusted: TrustedNativeJob, *,
                      manifest_bytes: bytes, source_bytes: bytes,
                      previews: tuple[bytes, ...],
                      verified_settings: dict[str, Any],
                      preflight_ticket: dict[str, Any] | None,
                      expected_evidence: dict[str, Any],
                      trusted_core_plan: dict[str, Any],
                      renderer_identity: dict[str, Any],
                      printer_capabilities: dict[str, Any]) -> dict[str, Any]:
    """Fail closed before printer selection, journal or native Word execution.

    Checks file hashes and the manifest's plan against a DB-bound job. Does not
    infer Word rendering or paper from the presence of a COM registry entry.
    """
    def block(code: str) -> dict[str, Any]:
        return {"schema": SCHEMA, "status": "NEEDS_HUMAN",
                "reason_code": code, "allowed_to_print": False,
                "allowed_to_simulate": False,
                "queue_submission_enabled": False,
                "physical_print_verified": False}

    try:
        ticket_result = validate_core_preflight_ticket(
            preflight_ticket=preflight_ticket, claimed_job=job)
        if (ticket_result.get("status") != "PREPARED_NOT_SENT" or
                not is_safe_core_preflight_result(ticket_result,
                                                  preflight_ticket=preflight_ticket)):
            return block("CORE_REVIEW_RECEIPT_REQUIRED")
        if type(job) is not dict or any(name in job for name in (
                "allowed", "allowed_to_print", "document_evidence_verified",
                "review_receipt", "trusted_evidence", "trusted_job")):
            return block("CLIENT_AUTHORITY_FIELDS_FORBIDDEN")
        ticket_job = preflight_ticket["trusted_job"]
        if (any(getattr(trusted, field) != ticket_job.get(field) for field in
                ("shop_id", "order_id", "job_id", "revision", "request_hash",
                 "approval_id", "printer_id", "evidence_sha256")) or
                trusted.revision != trusted.active_revision):
            return block("CORE_TRUSTED_JOB_MISMATCH")
        if not _snapshot_matches_ticket(expected_evidence, preflight_ticket):
            return block("CORE_EVIDENCE_OR_STAFF_REVIEW_STALE")
        core_evidence = preflight_ticket["trusted_evidence"]
        evidence_check = verify_print_evidence_v1(
            expected=expected_evidence,
            trusted_evidence_sha256=core_evidence["evidence_sha256"],
            active_revision=trusted.active_revision,
            context={"shop_id": trusted.shop_id, "order_id": trusted.order_id,
                     "revision": trusted.revision, "request_hash": trusted.request_hash,
                     "manifest_ref": trusted.manifest_ref, "printer_id": trusted.printer_id},
            manifest_bytes=manifest_bytes, originals=(source_bytes,), previews=previews,
            settings=(verified_settings,), trusted_core_plan=trusted_core_plan,
            renderer_identity=renderer_identity, printer_capabilities=printer_capabilities)
        if (evidence_check.get("status") != "EVIDENCE_VERIFIED" or
                evidence_check.get("evidence_sha256") != trusted.evidence_sha256 or
                evidence_check.get("evidence_sha256") != core_evidence.get("evidence_sha256")):
            return block("CORE_PRINT_EVIDENCE_MISMATCH")
        if (type(trusted.revision) is not int or trusted.revision < 1 or
                type(trusted.active_revision) is not int or
                trusted.revision != trusted.active_revision):
            return block("STALE_REVISION")
        fields = ("shop_id", "order_id", "job_id", "revision", "request_hash",
                  "approval_id", "printer_id", "lease_token")
        if (not isinstance(job, dict) or
                any(job.get(k) != getattr(trusted, k) for k in fields) or
                not all(type(getattr(trusted, x)) is str and getattr(trusted, x)
                        for x in ("shop_id", "order_id", "job_id", "approval_id", "lease_token"))):
            return block("JOB_IDENTITY_MISMATCH")
        if job.get("mode") not in ("simulation", "controlled_test"):
            return block("MODE_NOT_AUTHORIZED")
        if trusted.printer_id != "RMP7000":
            return block("PRINTER_REQUIRES_STAFF")
        hashes = [trusted.request_hash, trusted.manifest_sha256,
                  trusted.source_sha256, trusted.settings_sha256, *trusted.preview_sha256]
        if any(type(x) is not str or HEX.fullmatch(x) is None for x in hashes):
            return block("INVALID_EVIDENCE_SHA256")
        if (type(trusted.manifest_ref) is not str or REF.fullmatch(trusted.manifest_ref) is None or
                type(manifest_bytes) is not bytes or
                len(manifest_bytes) == 0 or len(manifest_bytes) > 256 * 1024 or
                _hash(manifest_bytes) != trusted.manifest_sha256):
            return block("MANIFEST_CHANGED")
        if (type(source_bytes) is not bytes or not 0 < len(source_bytes) <= processor.MAX_FILE or
                _hash(source_bytes) != trusted.source_sha256):
            return block("SOURCE_CHANGED")
        if not isinstance(verified_settings, dict):
            return block("SETTINGS_UNVERIFIED")
        from .bridge import _canonical
        settings_sha = _hash(_canonical(verified_settings).encode("utf-8"))
        if settings_sha != trusted.settings_sha256:
            return block("SETTINGS_CHANGED")
        if (type(previews) is not tuple or not 1 <= len(previews) <= 3 or
                len(previews) != len(trusted.preview_sha256)):
            return block("PREVIEW_UNVERIFIED")
        if any(type(p) is not bytes or not p.startswith(b"\x89PNG\r\n\x1a\n") or
               _hash(p) != h for p, h in zip(previews, trusted.preview_sha256)):
            return block("PREVIEW_CHANGED")
        payload = json.loads(manifest_bytes)
        if not isinstance(payload, dict) or payload.get("request_hash") != trusted.request_hash:
            return block("REQUEST_HASH_MISMATCH")
        if payload.get("schema") not in ("ai3.document_bridge.v1", "ai3.native_word_preview.v1"):
            return block("MANIFEST_SCHEMA_UNTRUSTED")
        files = payload.get("files")
        images = payload.get("previews")
        if (not isinstance(files, list) or len(files) != 1 or
                not isinstance(images, list) or len(images) != len(previews)):
            return block("MANIFEST_FILE_MAPPING")
        prefix = trusted.manifest_ref.split("/")[0] + "/"
        source = files[0]
        if (not isinstance(source, dict) or
                not isinstance(source.get("source_artifact_ref"), str) or
                SOURCE.fullmatch(source["source_artifact_ref"]) is None or
                not source["source_artifact_ref"].startswith(prefix) or
                source.get("file_sha256") != trusted.source_sha256 or
                source.get("size_bytes") != len(source_bytes) or
                source.get("settings_sha256") != trusted.settings_sha256):
            return block("MANIFEST_SOURCE_MISMATCH")
        # Never let a ZIP, DOC or another type use a Word/PDF native route.
        ext = source["source_artifact_ref"].rsplit(".", 1)[-1]
        if ext == "pdf" and not source_bytes.startswith(b"%PDF-"):
            return block("SOURCE_FORMAT_MISMATCH")
        if ext == "docx" and not source_bytes.startswith(b"PK"):
            return block("SOURCE_FORMAT_MISMATCH")
        for item, blob, digest in zip(images, previews, trusted.preview_sha256):
            if (not isinstance(item, dict) or
                    not isinstance(item.get("ref"), str) or
                    PNG.fullmatch(item["ref"]) is None or
                    not item["ref"].startswith(prefix) or
                    item.get("sha256") != digest or
                    item.get("bytes") != len(blob)):
                return block("MANIFEST_PREVIEW_MISMATCH")
        counted = payload.get("counts")
        paper = payload.get("paper_plan")
        if (not isinstance(counted, dict) or not isinstance(paper, list) or
                len(paper) != 1 or not isinstance(paper[0], dict)):
            return block("PAPER_PLAN_UNVERIFIED")
        counted_again = processor.plan([{
            "status": "READY", "file_sha256": trusted.source_sha256,
            "document_pages": source.get("document_pages"), **verified_settings,
        }])
        if (any(counted.get(k) != counted_again.get(k)
                for k in ("document_pages", "printed_faces", "physical_sheets",
                          "requires_price_confirmation")) or
                paper[0] != counted_again["files"][0]):
            return block("PAPER_PLAN_CHANGED")
        if ext == "pdf":
            if (not isinstance(source.get("render_method"), str) or
                    not source["render_method"].startswith("pymupdf-")):
                return block("PDF_RENDER_NOT_VERIFIED")
        elif (payload.get("ready") is not False or
              payload.get("requires_staff_review") is not True or
              source.get("render_method") != "word_com_native_preview_only" or
              not isinstance(payload.get("renderer_identity"), dict) or
              payload["renderer_identity"].get("engine") != "microsoft_word_com" or
              not isinstance(payload["renderer_identity"].get("version"), str) or
              not payload["renderer_identity"]["version"].strip()):
            return block("WORD_REVIEW_EVIDENCE_UNVERIFIED")
        # Still only evidence verified; no printer activation, paper count or send.
        return {"schema": SCHEMA, "status": "EVIDENCE_VERIFIED",
                "reason_code": "NONE", "allowed_to_print": False,
                "allowed_to_simulate": False, "queue_submission_enabled": False,
                "evidence_sha256": trusted.evidence_sha256,
                "review_receipt_id": preflight_ticket["review_receipt"]["receipt_id"],
                "native_format": ext.upper(), "document_pages": counted_again["document_pages"],
                "printed_faces": counted_again["printed_faces"],
                "physical_sheets": counted_again["physical_sheets"],
                "requires_price_confirmation": counted_again["requires_price_confirmation"],
                "physical_print_verified": False}
    except Exception:
        # Errors, filenames and untrusted content never leave the gate.
        return block("UNVERIFIED_NATIVE_EVIDENCE")
