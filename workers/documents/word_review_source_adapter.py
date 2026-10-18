"""Adapt AI1's private WordReviewSourceV1 snapshot to the AI3 native path.

This module is an internal, in-process structural adapter for the exact DTO in
V1_CORE_AGENT_EVIDENCE_CONTRACT_20261017.md §8. It does not expose an HTTP/CLI
wire format, open caller paths, or authenticate a browser payload. The caller
must obtain the snapshot from Core's authenticated server-side source port;
Core's double-read protects its current order/revision scope before this point.
"""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any

from . import processor
from .bridge import _canonical
from .native_word_artifacts import SCHEMA, make_word_review_artifacts

SOURCE_SCHEMA = "ai0.word_review_source.v1"
INPUT_MANIFEST_SCHEMA = "ai0.word_review_manifest.v1"
HEX = re.compile(r"^[0-9a-f]{64}$")
_BUNDLE = re.compile(r"^[A-Za-z0-9_-]+$")
_SOURCE_NAME = re.compile(r"^[A-Za-z0-9._-]+$")


def _sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _hold(reason: str, *, anchors: dict[str, Any] | None = None) -> dict[str, Any]:
    result: dict[str, Any] = {
        "schema": SCHEMA,
        "status": "NEEDS_HUMAN",
        "reason_code": reason,
        "ready": False,
        "allowed_to_print": False,
        "requires_staff_review": True,
        "physical_print_verified": False,
    }
    if anchors is not None:
        result.update(anchors)
    return result


def _bounded_ref(value: Any) -> bool:
    if type(value) is not str or not value or len(value) > 512 or value != value.strip():
        return False
    if any(ord(char) <= 0x20 for char in value) or "\\" in value or any(
            char in value for char in ":?#[]"):
        return False
    parts = value.split("/")
    return (len(parts) == 2 and bool(_BUNDLE.fullmatch(parts[0])) and
            bool(_SOURCE_NAME.fullmatch(parts[1])) and
            parts[1] not in (".", "..") and not value.startswith("/"))


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("DUPLICATE_JSON_KEY")
        result[key] = value
    return result


def _parse_input_manifest(raw: bytes) -> dict[str, Any]:
    text = raw.decode("utf-8", errors="strict")
    value = json.loads(
        text, object_pairs_hook=_unique_object,
        parse_constant=lambda _value: (_ for _ in ()).throw(ValueError("INVALID_JSON_NUMBER")),
    )
    if type(value) is not dict or set(value) != {
            "schema", "manifest_ref", "shop_id", "order_id", "active_revision",
            "request_hash", "source"}:
        raise ValueError("INPUT_MANIFEST_SHAPE")
    source = value.get("source")
    if type(source) is not dict or set(source) != {
            "format", "artifact_ref", "sha256", "size_bytes"}:
        raise ValueError("INPUT_MANIFEST_SOURCE_SHAPE")
    return value


def adapt_word_review_source(*, snapshot: dict[str, Any],
                             observation: dict[str, Any],
                             artifact_root: str | Path) -> dict[str, Any]:
    """Validate the complete Core snapshot, then create an anchored AI3 bundle.

    ``snapshot`` must be the in-memory result of AI1
    ``OrderService.readWordReviewSource`` with its non-enumerable private bytes
    preserved by the trusted server-to-worker caller. No JSON serialization or
    caller-supplied locator is accepted as a substitute.
    """
    try:
        if type(snapshot) is not dict or set(snapshot) != {
                "schema", "shop_id", "order_id", "active_revision", "request_hash",
                "request_data", "source", "manifest", "private_bytes"}:
            return _hold("CORE_WORD_SOURCE_SNAPSHOT_MISSING_OR_MALFORMED")
        if (snapshot.get("schema") != SOURCE_SCHEMA or
                type(snapshot.get("shop_id")) is not str or not snapshot["shop_id"].strip() or
                type(snapshot.get("order_id")) is not str or not snapshot["order_id"].strip() or
                type(snapshot.get("active_revision")) is not int or snapshot["active_revision"] < 1 or
                type(snapshot.get("request_hash")) is not str or
                HEX.fullmatch(snapshot["request_hash"]) is None):
            return _hold("CORE_WORD_SOURCE_SCOPE_UNVERIFIED")

        source = snapshot.get("source")
        input_manifest = snapshot.get("manifest")
        private_bytes = snapshot.get("private_bytes")
        if (type(source) is not dict or set(source) != {
                "format", "artifact_ref", "sha256", "size_bytes"} or
                type(input_manifest) is not dict or set(input_manifest) != {"ref", "sha256"} or
                type(private_bytes) is not dict or set(private_bytes) != {"source", "manifest"}):
            return _hold("CORE_WORD_SOURCE_SNAPSHOT_MALFORMED")
        source_bytes, manifest_bytes = private_bytes.get("source"), private_bytes.get("manifest")
        if (type(source_bytes) is not bytes or not 0 < len(source_bytes) <= processor.MAX_FILE or
                type(manifest_bytes) is not bytes or not 2 <= len(manifest_bytes) <= 256 * 1024):
            return _hold("CORE_WORD_SOURCE_PRIVATE_BYTES_UNAVAILABLE")
        if (source.get("format") != "DOCX" or
                not _bounded_ref(source.get("artifact_ref")) or
                type(source.get("sha256")) is not str or HEX.fullmatch(source["sha256"]) is None or
                type(source.get("size_bytes")) is not int or source["size_bytes"] < 1 or
                source.get("sha256") != _sha(source_bytes) or
                source.get("size_bytes") != len(source_bytes) or
                type(input_manifest.get("ref")) is not str or
                not _bounded_ref(input_manifest["ref"]) or
                input_manifest["ref"].split("/")[0] != source["artifact_ref"].split("/")[0] or
                type(input_manifest.get("sha256")) is not str or
                HEX.fullmatch(input_manifest["sha256"]) is None or
                input_manifest["sha256"] != _sha(manifest_bytes)):
            return _hold("CORE_WORD_SOURCE_HASH_OR_REFERENCE_MISMATCH")

        try:
            manifest = _parse_input_manifest(manifest_bytes)
            request_hash = _sha(_canonical(snapshot.get("request_data")).encode("utf-8"))
        except Exception:
            return _hold("CORE_WORD_SOURCE_MANIFEST_OR_REQUEST_INVALID")
        if (manifest.get("schema") != INPUT_MANIFEST_SCHEMA or
                manifest.get("manifest_ref") != input_manifest["ref"] or
                manifest.get("shop_id") != snapshot["shop_id"] or
                manifest.get("order_id") != snapshot["order_id"] or
                manifest.get("active_revision") != snapshot["active_revision"] or
                type(manifest.get("active_revision")) is not int or
                manifest.get("request_hash") != snapshot["request_hash"] or
                request_hash != snapshot["request_hash"] or
                manifest.get("source") != source):
            return _hold("CORE_WORD_SOURCE_SCOPE_OR_MANIFEST_MISMATCH")

        anchors = {
            "shop_id": snapshot["shop_id"],
            "order_id": snapshot["order_id"],
            "active_revision": snapshot["active_revision"],
            "request_hash": snapshot["request_hash"],
            "source": dict(source),
            "input_manifest": dict(input_manifest),
        }
        result = make_word_review_artifacts(
            source=source_bytes,
            trusted_request_data=snapshot["request_data"],
            expected_request_hash=snapshot["request_hash"],
            revision=snapshot["active_revision"],
            observation=observation,
            artifact_root=artifact_root,
            source_snapshot_anchors={key: anchors[key] for key in (
                "shop_id", "order_id", "active_revision", "request_hash",
                "source", "input_manifest")},
        )
        if result.get("status") != "REVIEW_REQUIRED":
            return _hold(result.get("reason_code", "WORD_REVIEW_ARTIFACT_UNVERIFIED"),
                         anchors={key: anchors[key] for key in (
                             "shop_id", "order_id", "active_revision", "request_hash",
                             "source", "input_manifest")})
        # Success means only a private preview is prepared for staff review.
        # It never authorizes a job, a send, or physical printing.
        return {
            **result,
            "schema": SCHEMA,
            "shop_id": anchors["shop_id"],
            "order_id": anchors["order_id"],
            "active_revision": anchors["active_revision"],
            "request_hash": anchors["request_hash"],
            "source": anchors["source"],
            "input_manifest": anchors["input_manifest"],
            "ready": False,
            "allowed_to_print": False,
            "requires_staff_review": True,
            "physical_print_verified": False,
        }
    except Exception:
        return _hold("CORE_WORD_SOURCE_ADAPTER_UNVERIFIED")
