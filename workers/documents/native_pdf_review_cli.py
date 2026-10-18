"""Bounded JSON bridge for the local PDF review-preview worker.

stdin is one ``ai0.pdf_review_source.v1`` object with the allowlisted scope,
request, source and manifest fields. Its only byte fields are
``private_bytes.source_base64`` and ``private_bytes.manifest_base64``. The
private artifact root comes exclusively from the server-owned
``--artifact-root`` CLI argument, never from stdin JSON.

stdout is one bounded JSON metadata object: status/reason, order/revision/
request hash, input source and manifest digests, print counts, safe flags, and
internal preview ``artifact_ref``/SHA/size records. It contains no bytes or
filesystem paths. Callers must keep artifact refs server-side and strip them
before returning any HTTP response. This route only creates
``REVIEW_REQUIRED``/``NEEDS_HUMAN`` previews; it has no print, driver, spooler,
network, or simulation authority.
"""
from __future__ import annotations

import argparse
import base64
import binascii
import json
import re
import sys
from typing import Any

from . import processor
from .native_pdf_review import prepare_native_pdf_review_from_snapshot

CLI_SCHEMA = "ai3.native_pdf_review_cli.v1"
SOURCE_SCHEMA = "ai0.pdf_review_source.v1"
PREVIEW_SCHEMA = "ai3.native_pdf_preview.v1"
MAX_SOURCE_BYTES = processor.MAX_FILE
MAX_MANIFEST_BYTES = 256 * 1024
MAX_SOURCE_BASE64_CHARS = 4 * ((MAX_SOURCE_BYTES + 2) // 3)
MAX_MANIFEST_BASE64_CHARS = 4 * ((MAX_MANIFEST_BYTES + 2) // 3)
MAX_REQUEST_METADATA_BYTES = 512 * 1024
MAX_REQUEST_JSON_BYTES = (MAX_SOURCE_BASE64_CHARS + MAX_MANIFEST_BASE64_CHARS +
                          MAX_REQUEST_METADATA_BYTES)
MAX_OUTPUT_JSON_BYTES = 16 * 1024
MAX_PREVIEWS = 3
MAX_COUNT = 1_000_000
_HEX = re.compile(r"^[0-9a-f]{64}$")
_REASON = re.compile(r"^[A-Z0-9_]{1,64}$")
_REF_PART = re.compile(r"^[A-Za-z0-9_-]+$")
_REF_NAME = re.compile(r"^[A-Za-z0-9._-]+$")

_SNAPSHOT_KEYS = {
    "schema", "shop_id", "order_id", "active_revision", "request_hash",
    "request_data", "source", "manifest", "private_bytes",
}
_SOURCE_KEYS = {"format", "artifact_ref", "sha256", "size_bytes"}
_MANIFEST_KEYS = {"ref", "sha256"}
_PRIVATE_JSON_KEYS = {"source_base64", "manifest_base64"}


class _RequestError(ValueError):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise _RequestError("REQUEST_JSON_INVALID")
        result[key] = value
    return result


def _reject_nonfinite(value: str) -> None:
    raise _RequestError("REQUEST_JSON_INVALID")


def _is_safe_ref(value: Any) -> bool:
    if (type(value) is not str or not value or len(value) > 512 or
            value != value.strip() or re.search(r"[\x00-\x20\\:?#\[\]]", value)):
        return False
    parts = value.split("/")
    return (len(parts) == 2 and _REF_PART.fullmatch(parts[0]) is not None and
            _REF_NAME.fullmatch(parts[1]) is not None and parts[1] not in (".", ".."))


def _decode_base64(value: Any, *, maximum_bytes: int, reason: str) -> bytes:
    if type(value) is not str:
        raise _RequestError(reason)
    maximum_chars = 4 * ((maximum_bytes + 2) // 3)
    if len(value) > maximum_chars:
        raise _RequestError("PRIVATE_BYTES_TOO_LARGE")
    try:
        encoded = value.encode("ascii")
        decoded = base64.b64decode(encoded, validate=True)
    except (UnicodeEncodeError, binascii.Error, ValueError):
        raise _RequestError(reason) from None
    if (not decoded or len(decoded) > maximum_bytes or
            base64.b64encode(decoded).decode("ascii") != value):
        raise _RequestError("PRIVATE_BYTES_TOO_LARGE" if len(decoded) > maximum_bytes else reason)
    return decoded


def _hold(reason: str) -> dict[str, Any]:
    """Small parseable response used for every rejected or uncertain input."""
    return {
        "schema": CLI_SCHEMA,
        "preview_schema": PREVIEW_SCHEMA,
        "status": "NEEDS_HUMAN",
        "reason_code": reason if _REASON.fullmatch(reason) else "PDF_PREVIEW_UNVERIFIED",
        "source_format": "PDF",
        "print_source_format": "PDF",
        "shop_id": None,
        "order_id": None,
        "active_revision": None,
        "request_hash": None,
        "source_sha256": None,
        "source_size_bytes": None,
        "input_manifest_sha256": None,
        "artifact_ref": None,
        "manifest_sha256": None,
        "preview_artifacts": [],
        "document_pages": None,
        "printed_faces": None,
        "physical_sheets": None,
        "requires_price_confirmation": None,
        "ready": False,
        "allowed_to_print": False,
        "allowed_to_simulate": False,
        "requires_staff_review": True,
        "physical_print_verified": False,
    }


def _bounded_text(value: Any, maximum: int) -> bool:
    return (type(value) is str and 0 < len(value) <= maximum and
            not any(ord(char) < 0x20 for char in value))


def _positive_int(value: Any, maximum: int = MAX_COUNT) -> bool:
    return type(value) is int and 1 <= value <= maximum


def _metadata_dto(result: Any, snapshot: dict[str, Any]) -> dict[str, Any]:
    if type(result) is not dict or result.get("schema") != PREVIEW_SCHEMA:
        return _hold("PDF_PREVIEW_RESULT_UNVERIFIED")
    status = result.get("status")
    if status not in ("REVIEW_REQUIRED", "NEEDS_HUMAN"):
        return _hold("PDF_PREVIEW_RESULT_UNVERIFIED")
    if (result.get("ready") is not False or
            result.get("allowed_to_print") is not False or
            result.get("requires_staff_review") is not True or
            result.get("physical_print_verified") is not False):
        return _hold("PDF_PREVIEW_SAFETY_FLAGS_UNVERIFIED")

    reason = result.get("reason_code")
    if type(reason) is not str or _REASON.fullmatch(reason) is None:
        reason = "PDF_PREVIEW_RESULT_UNVERIFIED"
    output = _hold(reason)
    output["status"] = status

    # Echo only bounded, allowlisted source/order metadata. It remains a
    # correlation DTO; the route must use its independent Core snapshot.
    if (_bounded_text(snapshot.get("shop_id"), 256) and
            _bounded_text(snapshot.get("order_id"), 256) and
            _positive_int(snapshot.get("active_revision"), 2**53 - 1) and
            type(snapshot.get("request_hash")) is str and
            _HEX.fullmatch(snapshot["request_hash"]) is not None):
        output.update({
            "shop_id": snapshot["shop_id"],
            "order_id": snapshot["order_id"],
            "active_revision": snapshot["active_revision"],
            "request_hash": snapshot["request_hash"],
        })
    source = snapshot.get("source")
    manifest = snapshot.get("manifest")
    if (type(source) is dict and set(source) == _SOURCE_KEYS and
            source.get("format") == "PDF" and
            type(source.get("sha256")) is str and _HEX.fullmatch(source["sha256"]) and
            _positive_int(source.get("size_bytes"), MAX_SOURCE_BYTES) and
            type(manifest) is dict and set(manifest) == _MANIFEST_KEYS and
            type(manifest.get("sha256")) is str and _HEX.fullmatch(manifest["sha256"])):
        output.update({
            "source_sha256": source["sha256"],
            "source_size_bytes": source["size_bytes"],
            "input_manifest_sha256": manifest["sha256"],
        })

    if status == "NEEDS_HUMAN":
        return output

    # REVIEW_REQUIRED is emitted only when the worker output is still anchored
    # to precisely this snapshot and every artifact locator is a safe ref.
    source_result = result.get("source")
    manifest_result = result.get("input_manifest")
    previews = result.get("preview_artifacts")
    if (not isinstance(source, dict) or source_result != source or
            not isinstance(manifest, dict) or manifest_result != manifest or
            any(result.get(key) != snapshot.get(source_key) for key, source_key in (
                ("shop_id", "shop_id"), ("order_id", "order_id"),
                ("active_revision", "active_revision"), ("request_hash", "request_hash"))) or
            not _is_safe_ref(result.get("artifact_ref")) or
            type(result.get("manifest_sha256")) is not str or
            _HEX.fullmatch(result["manifest_sha256"]) is None or
            type(previews) is not list or not 1 <= len(previews) <= MAX_PREVIEWS):
        return _hold("PDF_PREVIEW_METADATA_UNVERIFIED")
    safe_previews: list[dict[str, Any]] = []
    for preview in previews:
        if (type(preview) is not dict or not _is_safe_ref(preview.get("ref")) or
                type(preview.get("sha256")) is not str or
                _HEX.fullmatch(preview["sha256"]) is None or
                not _positive_int(preview.get("bytes"), 10 * 1024 * 1024)):
            return _hold("PDF_PREVIEW_METADATA_UNVERIFIED")
        safe_previews.append({
            "artifact_ref": preview["ref"],
            "sha256": preview["sha256"],
            "size_bytes": preview["bytes"],
        })
    output.update({
        "artifact_ref": result["artifact_ref"],
        "manifest_sha256": result["manifest_sha256"],
        "preview_artifacts": safe_previews,
    })
    for key in ("document_pages", "printed_faces", "physical_sheets"):
        if not _positive_int(result.get(key)):
            return _hold("PDF_PREVIEW_METADATA_UNVERIFIED")
        output[key] = result[key]
    if type(result.get("requires_price_confirmation")) is not bool:
        return _hold("PDF_PREVIEW_METADATA_UNVERIFIED")
    output["requires_price_confirmation"] = result["requires_price_confirmation"]
    return output


def process_request(value: Any, *, artifact_root: str) -> dict[str, Any]:
    """Decode a strict source DTO and call the existing review-only adapter."""
    if (type(value) is not dict or set(value) != _SNAPSHOT_KEYS or
            value.get("schema") != SOURCE_SCHEMA):
        return _hold("SOURCE_SNAPSHOT_SHAPE_INVALID")
    source = value.get("source")
    manifest = value.get("manifest")
    private = value.get("private_bytes")
    if (type(source) is not dict or set(source) != _SOURCE_KEYS or
            type(manifest) is not dict or set(manifest) != _MANIFEST_KEYS or
            type(private) is not dict or set(private) != _PRIVATE_JSON_KEYS):
        return _hold("SOURCE_SNAPSHOT_SHAPE_INVALID")
    try:
        source_bytes = _decode_base64(
            private["source_base64"], maximum_bytes=MAX_SOURCE_BYTES,
            reason="SOURCE_BASE64_INVALID")
        manifest_bytes = _decode_base64(
            private["manifest_base64"], maximum_bytes=MAX_MANIFEST_BYTES,
            reason="MANIFEST_BASE64_INVALID")
        snapshot = {key: item for key, item in value.items() if key != "private_bytes"}
        snapshot["private_bytes"] = {"source": source_bytes, "manifest": manifest_bytes}
        result = prepare_native_pdf_review_from_snapshot(
            snapshot=snapshot, artifact_root=artifact_root)
        return _metadata_dto(result, snapshot)
    except _RequestError as exc:
        return _hold(exc.reason)
    except Exception:
        return _hold("PDF_PREVIEW_UNVERIFIED")


def run_json_stream(input_stream: Any, *, artifact_root: str) -> dict[str, Any]:
    """Read exactly one bounded UTF-8 JSON object and return one DTO."""
    raw = input_stream.read(MAX_REQUEST_JSON_BYTES + 1)
    if len(raw) > MAX_REQUEST_JSON_BYTES:
        return _hold("INPUT_TOO_LARGE")
    try:
        request = json.loads(raw.decode("utf-8"),
                             object_pairs_hook=_reject_duplicate_keys,
                             parse_constant=_reject_nonfinite)
    except (UnicodeDecodeError, json.JSONDecodeError, _RequestError, TypeError, ValueError):
        return _hold("REQUEST_JSON_INVALID")
    return process_request(request, artifact_root=artifact_root)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="AUTO-IN native PDF review preview (NO PRINT)")
    parser.add_argument("--artifact-root", required=True,
                        help="Server-owned private root; never accepted from stdin JSON")
    args = parser.parse_args(argv)
    try:
        output = run_json_stream(sys.stdin.buffer, artifact_root=args.artifact_root)
        encoded = json.dumps(output, ensure_ascii=False, separators=(",", ":"))
        if len(encoded.encode("utf-8")) > MAX_OUTPUT_JSON_BYTES:
            output = _hold("PDF_PREVIEW_OUTPUT_TOO_LARGE")
            encoded = json.dumps(output, ensure_ascii=False, separators=(",", ":"))
    except Exception:
        output = _hold("PDF_PREVIEW_UNVERIFIED")
        encoded = json.dumps(output, ensure_ascii=False, separators=(",", ":"))
    sys.stdout.write(encoded + "\n")
    sys.stdout.flush()
    # NEEDS_HUMAN is a valid protocol response; status, not process failure,
    # tells the caller whether the review preview could be prepared.
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
