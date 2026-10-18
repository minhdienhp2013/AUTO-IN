"""Fail-closed adapter from AI0's verified Word snapshot to review preview.

No Core/DB/API or printer access is performed here. Source DOCX bytes remain
the intended print source; Word's temporary PDF is only an internal preview
input. Every successful result is REVIEW_REQUIRED and never print-ready.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
from typing import Any
import zipfile
import io

from agents.windows.native_word_document import preview_word_native
from .bridge import _canonical
from .native_word_artifacts import make_word_review_artifacts

SOURCE_SCHEMA = "ai0.word_review_source.v1"
INPUT_MANIFEST_SCHEMA = "ai0.word_review_manifest.v1"


@dataclass(frozen=True)
class NativeWordReviewConfig:
    """Trusted in-process configuration; never deserialize from a request."""
    allow_word_launch: bool = False


def _held(reason: str, anchors: dict[str, Any] | None = None) -> dict[str, Any]:
    result = {"schema": "ai3.native_word_preview.v1", "status": "NEEDS_HUMAN",
        "reason_code": reason, "ready": False, "allowed_to_print": False,
        "requires_staff_review": True, "physical_print_verified": False,
        "source_format": "DOCX", "print_source_format": "DOCX"}
    if anchors:
        result.update(anchors)
    return result


def _safe_reason(value: Any, fallback: str) -> str:
    return value if type(value) is str and re.fullmatch(r"[A-Z0-9_]{1,80}", value) else fallback


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _pairs_no_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("DUPLICATE_JSON_KEY")
        result[key] = value
    return result


def _ref(value: Any) -> tuple[str, ...]:
    if (type(value) is not str or not value or len(value) > 512 or "\\" in value
            or "\x00" in value or any(ord(c) < 0x20 for c in value)):
        raise ValueError("UNSAFE_PRIVATE_REF")
    path = PurePosixPath(value)
    parts = path.parts
    if (path.is_absolute() or len(parts) < 2 or value.startswith("./")
            or value.startswith("/") or value.endswith("/")
            or any(part in ("", ".", "..") for part in value.split("/"))
            or ":" in parts[0]):
        raise ValueError("UNSAFE_PRIVATE_REF")
    return parts


def _digest(value: Any) -> bool:
    return type(value) is str and re.fullmatch(r"[0-9a-f]{64}", value) is not None


def _request_binds_docx(request_data: Any, artifact_ref: str) -> bool:
    """Check Core's current request shape without transforming the payload.

    Core's existing TN005/customer-choice contracts use documents[]. Since no
    other registered-document schema is defined, unsupported shapes are held
    instead of guessed from filename/content.
    """
    if type(request_data) is not dict or set(request_data) != {"documents"}:
        return False
    docs = request_data.get("documents")
    if type(docs) is not list or len(docs) != 1:
        return False
    item = docs[0]
    allowed = {"artifact_name", "copies", "duplex", "paper", "orientation", "binding", "page_range"}
    if type(item) is not dict or set(item) - allowed or type(item.get("artifact_name")) is not str:
        return False
    try:
        parts = _ref(artifact_ref)
    except ValueError:
        return False
    registered = item["artifact_name"]
    if not parts[-1].lower().endswith(".docx"):
        return False
    return (registered == artifact_ref or
            (len(parts) >= 2 and registered == parts[-1] and registered.lower().endswith(".docx")))


def _verify_snapshot(snapshot: Any) -> tuple[dict[str, Any], bytes, Any]:
    required = {"schema", "shop_id", "order_id", "active_revision", "request_hash",
                "request_data", "source", "manifest", "private_bytes"}
    if type(snapshot) is not dict or set(snapshot) != required or snapshot["schema"] != SOURCE_SCHEMA:
        raise ValueError("SOURCE_SNAPSHOT_SHAPE_INVALID")
    shop, order, revision, request_hash = (snapshot[k] for k in
        ("shop_id", "order_id", "active_revision", "request_hash"))
    if (type(shop) is not str or not shop or type(order) is not str or not order
            or type(revision) is not int or revision < 1 or not _digest(request_hash)):
        raise ValueError("SOURCE_SCOPE_INVALID")
    source, manifest, private = snapshot["source"], snapshot["manifest"], snapshot["private_bytes"]
    if (type(source) is not dict or set(source) != {"format", "artifact_ref", "sha256", "size_bytes"}
            or type(manifest) is not dict or set(manifest) != {"ref", "sha256"}
            or type(private) is not dict or set(private) != {"source", "manifest"}):
        raise ValueError("SOURCE_SNAPSHOT_SHAPE_INVALID")
    if (source["format"] != "DOCX" or not _digest(source["sha256"])
            or not _digest(manifest["sha256"]) or type(source["size_bytes"]) is not int
            or source["size_bytes"] < 1):
        raise ValueError("SOURCE_FACTS_INVALID")
    source_parts, manifest_parts = _ref(source["artifact_ref"]), _ref(manifest["ref"])
    if source_parts[0] != manifest_parts[0]:
        raise ValueError("SOURCE_MANIFEST_BUNDLE_MISMATCH")
    source_bytes, manifest_bytes = private["source"], private["manifest"]
    if type(source_bytes) is not bytes or not source_bytes or type(manifest_bytes) is not bytes:
        raise ValueError("SOURCE_BYTES_UNAVAILABLE")
    if (type(source["size_bytes"]) is not int or source["size_bytes"] != len(source_bytes)
            or _sha(source_bytes) != source["sha256"] or _sha(manifest_bytes) != manifest["sha256"]):
        raise ValueError("SOURCE_BYTES_HASH_MISMATCH")
    if len(source_bytes) > 100 * 1024 * 1024:
        raise ValueError("SOURCE_TOO_LARGE")
    try:
        with zipfile.ZipFile(io.BytesIO(source_bytes)) as archive:
            names = set(archive.namelist())
            if "[Content_Types].xml" not in names or "word/document.xml" not in names:
                raise ValueError("NOT_A_DOCX_PACKAGE")
    except (zipfile.BadZipFile, OSError) as exc:
        raise ValueError("NOT_A_DOCX_PACKAGE") from exc
    parsed = json.loads(manifest_bytes.decode("utf-8"), object_pairs_hook=_pairs_no_duplicates)
    if type(parsed) is not dict or set(parsed) != {
        "schema", "manifest_ref", "shop_id", "order_id", "active_revision", "request_hash", "source"
    }:
        raise ValueError("INPUT_MANIFEST_SHAPE_INVALID")
    msource = parsed["source"]
    if type(msource) is not dict or set(msource) != {"format", "artifact_ref", "sha256", "size_bytes"}:
        raise ValueError("INPUT_MANIFEST_SHAPE_INVALID")
    if (type(parsed["shop_id"]) is not str or type(parsed["order_id"]) is not str
            or type(parsed["active_revision"]) is not int or parsed["active_revision"] < 1
            or not _digest(parsed["request_hash"]) or type(parsed["manifest_ref"]) is not str
            or msource.get("format") != "DOCX" or type(msource.get("artifact_ref")) is not str
            or not _digest(msource.get("sha256")) or type(msource.get("size_bytes")) is not int
            or msource.get("size_bytes", 0) < 1):
        raise ValueError("INPUT_MANIFEST_FACTS_INVALID")
    if (parsed["schema"] != INPUT_MANIFEST_SCHEMA or parsed["manifest_ref"] != manifest["ref"]
            or parsed["shop_id"] != shop or parsed["order_id"] != order
            or parsed["active_revision"] != revision or parsed["request_hash"] != request_hash
            or msource != source):
        raise ValueError("INPUT_MANIFEST_BINDING_MISMATCH")
    if not _request_binds_docx(snapshot["request_data"], source["artifact_ref"]):
        raise ValueError("REQUEST_DOCX_NOT_REGISTERED")
    if _sha(_canonical(snapshot["request_data"]).encode("utf-8")) != request_hash:
        raise ValueError("REQUEST_HASH_MISMATCH")
    anchors = {"shop_id": shop, "order_id": order, "active_revision": revision,
        "request_hash": request_hash,
        "source": {"format": "DOCX", "artifact_ref": source["artifact_ref"],
                   "sha256": source["sha256"], "size_bytes": source["size_bytes"]},
        "input_manifest": {"ref": manifest["ref"], "sha256": manifest["sha256"]}}
    return anchors, source_bytes, snapshot["request_data"]


def prepare_native_word_review_from_snapshot(*, snapshot: Any, artifact_root: str | Path,
                                             config: NativeWordReviewConfig | None = None) -> dict[str, Any]:
    """Validate the exact AI0 snapshot and produce only a review bundle."""
    try:
        anchors, source, request_data = _verify_snapshot(snapshot)
    except Exception:
        return _held("WORD_SOURCE_SNAPSHOT_UNVERIFIED")
    selected = config if config is not None else NativeWordReviewConfig()
    if type(selected) is not NativeWordReviewConfig or type(selected.allow_word_launch) is not bool:
        return _held("WORD_LAUNCH_CONFIGURATION_INVALID", anchors)
    if not selected.allow_word_launch:
        return _held("WORD_LAUNCH_NOT_AUTHORIZED", anchors)
    try:
        observation = preview_word_native(source, expected_sha256=anchors["source"]["sha256"],
                                          allow_word_launch=selected.allow_word_launch)
    except Exception:
        return _held("WORD_PREVIEW_UNAVAILABLE", anchors)
    if not isinstance(observation, dict):
        return _held("WORD_PREVIEW_UNVERIFIED", anchors)
    if observation.get("status") == "NEEDS_HUMAN":
        return _held(_safe_reason(observation.get("reason_code"), "WORD_PREVIEW_UNVERIFIED"), anchors)
    if (observation.get("status") != "REVIEW_REQUIRED"
            or observation.get("schema") != "ai3.word_native_preview.v1"
            or observation.get("evidence_kind") != "windows_word_com_preview_only"
            or observation.get("native_word_verified") is not True
            or observation.get("physical_print_verified") is not False
            or observation.get("allowed_to_print") is not False
            or observation.get("source_format") != "DOCX"
            or observation.get("print_source_format") != "DOCX"
            or observation.get("source_sha256") != anchors["source"]["sha256"]):
        return _held("WORD_NATIVE_EVIDENCE_UNVERIFIED", anchors)
    try:
        bundle = make_word_review_artifacts(source=source, request_data=request_data,
            anchors=anchors, observation=observation, artifact_root=artifact_root)
    except Exception:
        return _held("WORD_NATIVE_ARTIFACT_UNVERIFIED", anchors)
    if (not isinstance(bundle, dict) or bundle.get("status") != "REVIEW_REQUIRED"
            or bundle.get("ready") is not False or bundle.get("allowed_to_print") is not False
            or bundle.get("requires_staff_review") is not True
            or bundle.get("physical_print_verified") is not False):
        return _held("WORD_NATIVE_ARTIFACT_UNVERIFIED", anchors)
    return bundle
