"""Fail-closed adapter from AI0's private PDF snapshot to a review preview.

The original PDF bytes remain the print source. PyMuPDF output is a private
technical preview for staff only; this module never creates print authority,
reads a Core database/API, follows a browser-supplied path, or calls a printer.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re
from typing import Any

from .bridge import _canonical
from .native_pdf_artifacts import make_pdf_review_artifacts

SOURCE_SCHEMA = "ai0.pdf_review_source.v1"
INPUT_MANIFEST_SCHEMA = "ai0.pdf_review_manifest.v1"


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _pairs_no_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("DUPLICATE_JSON_KEY")
        result[key] = value
    return result


def _no_nonfinite_json(value: str) -> None:
    raise ValueError("NONFINITE_JSON_NUMBER")


def _ref(value: Any) -> tuple[str, ...]:
    if type(value) is not str or not value or len(value) > 512 or value != value.strip():
        raise ValueError("UNSAFE_PRIVATE_REF")
    if re.search(r"[\x00-\x20\\:?#\[\]]", value):
        raise ValueError("UNSAFE_PRIVATE_REF")
    parts = value.split("/")
    if (len(parts) != 2 or not re.fullmatch(r"[A-Za-z0-9_-]+", parts[0])
            or not re.fullmatch(r"[A-Za-z0-9._-]+", parts[1])
            or parts[1] in (".", "..")):
        raise ValueError("UNSAFE_PRIVATE_REF")
    return parts


def _digest(value: Any) -> bool:
    return type(value) is str and re.fullmatch(r"[0-9a-f]{64}", value) is not None


def _private_bytes(value: Any) -> bytes:
    """Map an in-process Uint8Array view to an immutable Python byte snapshot."""
    if type(value) is bytes:
        return value
    if type(value) is bytearray or type(value) is memoryview:
        return bytes(value)
    raise ValueError("SOURCE_BYTES_UNAVAILABLE")


def _verify_snapshot(snapshot: Any) -> tuple[dict[str, Any], bytes, Any]:
    required = {"schema", "shop_id", "order_id", "active_revision", "request_hash",
                "request_data", "source", "manifest", "private_bytes"}
    if type(snapshot) is not dict or set(snapshot) != required or snapshot["schema"] != SOURCE_SCHEMA:
        raise ValueError("SOURCE_SNAPSHOT_SHAPE_INVALID")
    shop, order, revision, request_hash = (snapshot[key] for key in
        ("shop_id", "order_id", "active_revision", "request_hash"))
    if (type(shop) is not str or not shop or len(shop) > 256 or
            any(ord(char) < 0x20 for char in shop) or
            type(order) is not str or not order or len(order) > 256 or
            any(ord(char) < 0x20 for char in order) or
            type(revision) is not int or revision < 1 or not _digest(request_hash)):
        raise ValueError("SOURCE_SCOPE_INVALID")

    source, manifest, private = snapshot["source"], snapshot["manifest"], snapshot["private_bytes"]
    if (type(source) is not dict or set(source) != {"format", "artifact_ref", "sha256", "size_bytes"}
            or type(manifest) is not dict or set(manifest) != {"ref", "sha256"}
            or type(private) is not dict or set(private) != {"source", "manifest"}):
        raise ValueError("SOURCE_SNAPSHOT_SHAPE_INVALID")
    if (source["format"] != "PDF" or not _digest(source["sha256"])
            or not _digest(manifest["sha256"]) or type(source["size_bytes"]) is not int
            or source["size_bytes"] < 1):
        raise ValueError("SOURCE_FACTS_INVALID")

    source_parts, manifest_parts = _ref(source["artifact_ref"]), _ref(manifest["ref"])
    if source_parts[0] != manifest_parts[0]:
        raise ValueError("SOURCE_MANIFEST_BUNDLE_MISMATCH")
    source_bytes, manifest_bytes = (_private_bytes(private["source"]),
                                    _private_bytes(private["manifest"]))
    if not source_bytes:
        raise ValueError("SOURCE_BYTES_UNAVAILABLE")
    from . import processor
    if (len(source_bytes) > processor.MAX_FILE or not 2 <= len(manifest_bytes) <= 256 * 1024
            or not source_bytes.startswith(b"%PDF-")):
        raise ValueError("SOURCE_BYTES_SIZE_OR_FORMAT_INVALID")
    if (source["size_bytes"] != len(source_bytes) or _sha(source_bytes) != source["sha256"]
            or _sha(manifest_bytes) != manifest["sha256"]):
        raise ValueError("SOURCE_BYTES_HASH_MISMATCH")

    # Bounds match the existing trusted document bridge and Core evidence port.
    try:
        parsed = json.loads(manifest_bytes.decode("utf-8"),
                            object_pairs_hook=_pairs_no_duplicates,
                            parse_constant=_no_nonfinite_json)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError, TypeError) as exc:
        raise ValueError("INPUT_MANIFEST_INVALID") from exc
    if type(parsed) is not dict or set(parsed) != {
        "schema", "manifest_ref", "shop_id", "order_id", "active_revision", "request_hash", "source"
    }:
        raise ValueError("INPUT_MANIFEST_SHAPE_INVALID")
    manifest_source = parsed["source"]
    if (type(manifest_source) is not dict or
            set(manifest_source) != {"format", "artifact_ref", "sha256", "size_bytes"}):
        raise ValueError("INPUT_MANIFEST_SHAPE_INVALID")
    if (type(parsed["shop_id"]) is not str or type(parsed["order_id"]) is not str
            or type(parsed["active_revision"]) is not int or parsed["active_revision"] < 1
            or not _digest(parsed["request_hash"]) or type(parsed["manifest_ref"]) is not str
            or manifest_source.get("format") != "PDF"
            or type(manifest_source.get("artifact_ref")) is not str
            or not _digest(manifest_source.get("sha256"))
            or type(manifest_source.get("size_bytes")) is not int
            or manifest_source.get("size_bytes", 0) < 1):
        raise ValueError("INPUT_MANIFEST_FACTS_INVALID")
    if (parsed["schema"] != INPUT_MANIFEST_SCHEMA or parsed["manifest_ref"] != manifest["ref"]
            or parsed["shop_id"] != shop or parsed["order_id"] != order
            or parsed["active_revision"] != revision or parsed["request_hash"] != request_hash
            or manifest_source != source):
        raise ValueError("INPUT_MANIFEST_BINDING_MISMATCH")

    if _sha(_canonical(snapshot["request_data"]).encode("utf-8")) != request_hash:
        raise ValueError("REQUEST_HASH_MISMATCH")
    anchors = {"shop_id": shop, "order_id": order, "active_revision": revision,
        "request_hash": request_hash,
        "source": {"format": "PDF", "artifact_ref": source["artifact_ref"],
                   "sha256": source["sha256"], "size_bytes": source["size_bytes"]},
        "input_manifest": {"ref": manifest["ref"], "sha256": manifest["sha256"]}}
    return anchors, source_bytes, snapshot["request_data"]


def prepare_native_pdf_review_from_snapshot(*, snapshot: Any,
                                            artifact_root: str | Path) -> dict[str, Any]:
    """Validate a private Core snapshot and return a staff-only PDF preview."""
    try:
        anchors, source, request_data = _verify_snapshot(snapshot)
    except Exception:
        return {"schema": "ai3.native_pdf_preview.v1", "status": "NEEDS_HUMAN",
                "reason_code": "PDF_SOURCE_SNAPSHOT_UNVERIFIED", "ready": False,
                "allowed_to_print": False, "requires_staff_review": True,
                "physical_print_verified": False, "source_format": "PDF",
                "print_source_format": "PDF"}
    try:
        return make_pdf_review_artifacts(source=source, request_data=request_data,
                                         anchors=anchors, artifact_root=artifact_root)
    except Exception:
        # No exception text, source bytes, locator, or client name crosses this boundary.
        return {"schema": "ai3.native_pdf_preview.v1", "status": "NEEDS_HUMAN",
                "reason_code": "PDF_NATIVE_ARTIFACT_UNVERIFIED", "ready": False,
                "allowed_to_print": False, "requires_staff_review": True,
                "physical_print_verified": False, "source_format": "PDF",
                "print_source_format": "PDF", **anchors}
