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

SCHEMA = "ai3.native_job_binding.v1"
HEX = re.compile(r"^[a-f0-9]{64}$")
REF = re.compile(r"^doc-[A-Za-z0-9_-]{6,64}/manifest\.json$")
SOURCE = re.compile(r"^doc-[A-Za-z0-9_-]{6,64}/source-\d{3}-[a-f0-9]{64}\.(?:pdf|docx)$")
PNG = re.compile(r"^doc-[A-Za-z0-9_-]{6,64}/[A-Za-z0-9_-]+-p[1-9]\d*\.png$")


def _hash(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


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


def verify_native_job(job: dict[str, Any], trusted: TrustedNativeJob, *,
                      manifest_bytes: bytes, source_bytes: bytes,
                      previews: tuple[bytes, ...],
                      verified_settings: dict[str, Any]) -> dict[str, Any]:
    """Fail closed before printer selection, journal or native Word execution.

    Checks file hashes and the manifest's plan against a DB-bound job. Does not
    infer Word rendering or paper from the presence of a COM registry entry.
    """
    def block(code: str) -> dict[str, Any]:
        return {"schema": SCHEMA, "status": "NEEDS_HUMAN",
                "reason_code": code, "allowed_to_print": False,
                "physical_print_verified": False}

    try:
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
        # Word native's rendered page count must come from a separate trusted
        # Windows COM validation. A manifest alone never proves Word render.
        if ext == "docx":
            return block("WORD_NATIVE_RENDER_AND_STAFF_REVIEW_REQUIRED")
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
        if not isinstance(source.get("render_method"), str) or not source["render_method"].startswith("pymupdf-"):
            return block("PDF_RENDER_NOT_VERIFIED")
        # Still only evidence verified; no printer activation, paper count or send.
        return {"schema": SCHEMA, "status": "EVIDENCE_VERIFIED",
                "reason_code": "NONE", "allowed_to_print": False,
                "native_format": "PDF", "document_pages": counted_again["document_pages"],
                "printed_faces": counted_again["printed_faces"],
                "physical_sheets": counted_again["physical_sheets"],
                "requires_price_confirmation": counted_again["requires_price_confirmation"],
                "physical_print_verified": False}
    except Exception:
        # Errors, filenames and untrusted content never leave the gate.
        return block("UNVERIFIED_NATIVE_EVIDENCE")
