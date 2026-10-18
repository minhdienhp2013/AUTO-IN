"""Bounded JSON bridge for private native Word review previews.

stdin is one ``ai0.word_review_source.v1`` snapshot. Its only byte fields are
strict base64 values at ``private_bytes.source_base64`` and
``private_bytes.manifest_base64``. The private artifact root comes only from
the server/operator CLI configuration ``--artifact-root``. Word COM launch is
disabled by default and requires the separate ``--allow-word-launch`` CLI
flag; neither option can be supplied in request JSON.

stdout is one bounded, allowlisted metadata DTO. It contains no source bytes,
request data, source locator, absolute filesystem path, or exception text.
Preview artifact refs are private relative refs for the authenticated server
to retain; strip them before any HTTP/browser response. DOCX remains the print
source. This adapter only creates a staff-review preview and has no print,
spooler, OA, network, or customer-contact behavior.
"""
from __future__ import annotations

import argparse
import base64
import binascii
import json
import re
import sys
from typing import Any

from agents.windows.native_word_document import MAX_DOCX_BYTES
from .native_word_review import (
    NativeWordReviewConfig,
    SOURCE_SCHEMA,
    prepare_native_word_review_from_snapshot,
)

CLI_SCHEMA = "ai3.native_word_review_cli.v1"
PREVIEW_SCHEMA = "ai3.native_word_preview.v1"
MAX_SOURCE_BYTES = MAX_DOCX_BYTES
MAX_MANIFEST_BYTES = 256 * 1024
MAX_SOURCE_BASE64_CHARS = 4 * ((MAX_SOURCE_BYTES + 2) // 3)
MAX_MANIFEST_BASE64_CHARS = 4 * ((MAX_MANIFEST_BYTES + 2) // 3)
MAX_REQUEST_METADATA_BYTES = 512 * 1024
MAX_REQUEST_JSON_BYTES = (MAX_SOURCE_BASE64_CHARS + MAX_MANIFEST_BASE64_CHARS +
                          MAX_REQUEST_METADATA_BYTES)
MAX_OUTPUT_JSON_BYTES = 16 * 1024
MAX_PREVIEWS = 3
MAX_PAGE_COUNT = 500
MAX_COUNT = 1_000_000

_HEX = re.compile(r"^[0-9a-f]{64}$")
_REASON = re.compile(r"^[A-Z0-9_]{1,80}$")
_REF_COMPONENT = re.compile(r"^[A-Za-z0-9_-]+$")
_REF_FILENAME = re.compile(r"^[A-Za-z0-9._-]+$")
_WORD_VERSION = re.compile(r"^[A-Za-z0-9._+-]{1,64}$")

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


class _CliConfigError(ValueError):
    pass


class _QuietArgumentParser(argparse.ArgumentParser):
    """Keep invalid CLI configuration from printing paths or usage to stderr."""
    def error(self, _message: str) -> None:
        raise _CliConfigError("CLI_CONFIGURATION_INVALID")

    def exit(self, _status: int = 0, _message: str | None = None) -> None:
        raise _CliConfigError("CLI_CONFIGURATION_INVALID")


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise _RequestError("REQUEST_JSON_INVALID")
        result[key] = value
    return result


def _reject_nonfinite(_value: str) -> None:
    raise _RequestError("REQUEST_JSON_INVALID")


def _safe_ref(value: Any) -> bool:
    if (type(value) is not str or not value or len(value) > 512 or
            value != value.strip() or re.search(r"[\x00-\x20\\:?#\[\]]", value)):
        return False
    parts = value.split("/")
    return (len(parts) == 2 and _REF_COMPONENT.fullmatch(parts[0]) is not None and
            _REF_FILENAME.fullmatch(parts[1]) is not None and parts[1] not in (".", ".."))


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
    """Fixed-key, parseable response for invalid, unavailable or uncertain input."""
    return {
        "schema": CLI_SCHEMA,
        "preview_schema": PREVIEW_SCHEMA,
        "status": "NEEDS_HUMAN",
        "reason_code": reason if _REASON.fullmatch(reason) else "WORD_PREVIEW_UNVERIFIED",
        "source_format": "DOCX",
        "print_source_format": "DOCX",
        "shop_id": None,
        "order_id": None,
        "active_revision": None,
        "request_hash": None,
        "source_sha256": None,
        "source_size_bytes": None,
        "input_manifest_sha256": None,
        "artifact_ref": None,
        "manifest_sha256": None,
        "settings_sha256": None,
        "preview_artifacts": [],
        "document_pages": None,
        "printed_faces": None,
        "physical_sheets": None,
        "requires_price_confirmation": None,
        "renderer_identity": None,
        "native_word_verified": False,
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


def _validated_snapshot_anchors(result: dict[str, Any], snapshot: dict[str, Any]
                                 ) -> tuple[bool, dict[str, Any]]:
    """Echo only the exact scope/source anchors validated by the worker."""
    source = snapshot.get("source")
    manifest = snapshot.get("manifest")
    if (type(source) is not dict or set(source) != _SOURCE_KEYS or
            type(manifest) is not dict or set(manifest) != _MANIFEST_KEYS):
        return False, {}
    scope = {
        "shop_id": snapshot.get("shop_id"),
        "order_id": snapshot.get("order_id"),
        "active_revision": snapshot.get("active_revision"),
        "request_hash": snapshot.get("request_hash"),
    }
    if (not _bounded_text(scope["shop_id"], 256) or
            not _bounded_text(scope["order_id"], 256) or
            not _positive_int(scope["active_revision"], 2**53 - 1) or
            type(scope["request_hash"]) is not str or
            _HEX.fullmatch(scope["request_hash"]) is None or
            any(result.get(key) != value for key, value in scope.items())):
        return False, {}
    if (source.get("format") != "DOCX" or not _safe_ref(source.get("artifact_ref")) or
            not _safe_ref(manifest.get("ref")) or
            source["artifact_ref"].split("/", 1)[0] != manifest["ref"].split("/", 1)[0] or
            type(source.get("sha256")) is not str or _HEX.fullmatch(source["sha256"]) is None or
            not _positive_int(source.get("size_bytes"), MAX_SOURCE_BYTES) or
            type(manifest.get("sha256")) is not str or _HEX.fullmatch(manifest["sha256"]) is None or
            result.get("source") != source or
            result.get("input_manifest") != manifest):
        return False, {}
    anchors = {
        **scope,
        "source_sha256": source["sha256"],
        "source_size_bytes": source["size_bytes"],
        "input_manifest_sha256": manifest["sha256"],
    }
    return True, anchors


def _metadata_dto(result: Any, snapshot: dict[str, Any]) -> dict[str, Any]:
    if type(result) is not dict or result.get("schema") != PREVIEW_SCHEMA:
        return _hold("WORD_PREVIEW_RESULT_UNVERIFIED")
    status = result.get("status")
    if status not in ("REVIEW_REQUIRED", "NEEDS_HUMAN"):
        return _hold("WORD_PREVIEW_RESULT_UNVERIFIED")
    if (result.get("ready") is not False or
            result.get("allowed_to_print") is not False or
            result.get("requires_staff_review") is not True or
            result.get("physical_print_verified") is not False or
            result.get("source_format") != "DOCX" or
            result.get("print_source_format") != "DOCX"):
        return _hold("WORD_PREVIEW_SAFETY_FLAGS_UNVERIFIED")

    reason = result.get("reason_code")
    if type(reason) is not str or _REASON.fullmatch(reason) is None:
        reason = "WORD_PREVIEW_RESULT_UNVERIFIED"
    output = _hold(reason)
    output["status"] = status
    anchors_ok, anchors = _validated_snapshot_anchors(result, snapshot)
    if anchors_ok:
        output.update(anchors)
    if status == "NEEDS_HUMAN":
        return output

    source = snapshot.get("source")
    manifest = snapshot.get("manifest")
    previews = result.get("preview_artifacts")
    identity = result.get("renderer_identity")
    if (not anchors_ok or result.get("evidence_kind") != "windows_word_com_preview_only" or
            result.get("native_word_verified") is not True or
            result.get("source_sha256") != source.get("sha256") or
            not _safe_ref(result.get("artifact_ref")) or
            type(result.get("manifest_sha256")) is not str or
            _HEX.fullmatch(result["manifest_sha256"]) is None or
            type(result.get("settings_sha256")) is not str or
            _HEX.fullmatch(result["settings_sha256"]) is None or
            type(identity) is not dict or set(identity) != {"engine", "version"} or
            identity.get("engine") != "microsoft_word_com" or
            type(identity.get("version")) is not str or
            _WORD_VERSION.fullmatch(identity["version"]) is None or
            type(previews) is not list or not 1 <= len(previews) <= MAX_PREVIEWS or
            type(result.get("source")) is not dict or result["source"] != source or
            type(result.get("input_manifest")) is not dict or result["input_manifest"] != manifest):
        return _hold("WORD_PREVIEW_METADATA_UNVERIFIED")

    safe_previews: list[dict[str, Any]] = []
    for preview in previews:
        if (type(preview) is not dict or set(preview) != {"ref", "sha256", "bytes"} or
                not _safe_ref(preview.get("ref")) or
                preview["ref"].split("/", 1)[0] != result["artifact_ref"].split("/", 1)[0] or
                type(preview.get("sha256")) is not str or
                _HEX.fullmatch(preview["sha256"]) is None or
                not _positive_int(preview.get("bytes"), 10 * 1024 * 1024)):
            return _hold("WORD_PREVIEW_METADATA_UNVERIFIED")
        safe_previews.append({
            "artifact_ref": preview["ref"],
            "sha256": preview["sha256"],
            "size_bytes": preview["bytes"],
        })
    for key in ("document_pages", "printed_faces", "physical_sheets"):
        maximum = MAX_PAGE_COUNT if key == "document_pages" else MAX_COUNT
        if not _positive_int(result.get(key), maximum):
            return _hold("WORD_PREVIEW_METADATA_UNVERIFIED")
    if type(result.get("requires_price_confirmation")) is not bool:
        return _hold("WORD_PREVIEW_METADATA_UNVERIFIED")

    output.update({
        "status": "REVIEW_REQUIRED",
        "artifact_ref": result["artifact_ref"],
        "manifest_sha256": result["manifest_sha256"],
        "settings_sha256": result["settings_sha256"],
        "preview_artifacts": safe_previews,
        "document_pages": result["document_pages"],
        "printed_faces": result["printed_faces"],
        "physical_sheets": result["physical_sheets"],
        "requires_price_confirmation": result["requires_price_confirmation"],
        "renderer_identity": {"engine": "microsoft_word_com",
                              "version": identity["version"]},
        "native_word_verified": True,
    })
    return output


def process_request(value: Any, *, artifact_root: str, allow_word_launch: bool = False
                    ) -> dict[str, Any]:
    """Decode a strict source DTO and call the existing Word review adapter."""
    if type(allow_word_launch) is not bool:
        return _hold("WORD_LAUNCH_CONFIGURATION_INVALID")
    if not isinstance(artifact_root, str) or not artifact_root:
        return _hold("ARTIFACT_ROOT_CONFIGURATION_REQUIRED")
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
    if (source.get("format") != "DOCX" or
            not _safe_ref(source.get("artifact_ref")) or
            not _safe_ref(manifest.get("ref"))):
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
        result = prepare_native_word_review_from_snapshot(
            snapshot=snapshot,
            artifact_root=artifact_root,
            config=NativeWordReviewConfig(allow_word_launch=allow_word_launch),
        )
        return _metadata_dto(result, snapshot)
    except _RequestError as exc:
        return _hold(exc.reason)
    except Exception:
        # COM, filesystem and parser exception text can reveal paths or content.
        return _hold("WORD_PREVIEW_UNVERIFIED")


def run_json_stream(input_stream: Any, *, artifact_root: str,
                    allow_word_launch: bool = False) -> dict[str, Any]:
    """Read exactly one bounded UTF-8 JSON request and return a safe DTO."""
    try:
        raw = input_stream.read(MAX_REQUEST_JSON_BYTES + 1)
        if not isinstance(raw, bytes) or len(raw) > MAX_REQUEST_JSON_BYTES:
            return _hold("INPUT_TOO_LARGE")
        request = json.loads(raw.decode("utf-8"),
                             object_pairs_hook=_reject_duplicate_keys,
                             parse_constant=_reject_nonfinite)
    except (UnicodeDecodeError, json.JSONDecodeError, _RequestError, TypeError, ValueError):
        return _hold("REQUEST_JSON_INVALID")
    except Exception:
        return _hold("REQUEST_JSON_INVALID")
    return process_request(request, artifact_root=artifact_root,
                          allow_word_launch=allow_word_launch)


def main(argv: list[str] | None = None) -> int:
    parser = _QuietArgumentParser(
        description="AUTO-IN native Word review preview (NO PRINT)", add_help=False)
    parser.add_argument("--artifact-root",
                        help="Server-owned private root; never accepted from JSON")
    parser.add_argument("--allow-word-launch", action="store_true",
                        help="Explicit operator/server configuration to permit Word COM preview")
    try:
        args = parser.parse_args(argv)
        if not args.artifact_root:
            output = _hold("ARTIFACT_ROOT_CONFIGURATION_REQUIRED")
        else:
            output = run_json_stream(sys.stdin.buffer, artifact_root=args.artifact_root,
                                     allow_word_launch=args.allow_word_launch)
        encoded = json.dumps(output, ensure_ascii=True, separators=(",", ":"))
        if len(encoded.encode("utf-8")) > MAX_OUTPUT_JSON_BYTES:
            output = _hold("WORD_PREVIEW_OUTPUT_TOO_LARGE")
            encoded = json.dumps(output, ensure_ascii=True, separators=(",", ":"))
    except _CliConfigError:
        output = _hold("CLI_CONFIGURATION_INVALID")
        encoded = json.dumps(output, ensure_ascii=True, separators=(",", ":"))
    except Exception:
        output = _hold("WORD_PREVIEW_UNVERIFIED")
        encoded = json.dumps(output, ensure_ascii=True, separators=(",", ":"))
    sys.stdout.write(encoded + "\n")
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
