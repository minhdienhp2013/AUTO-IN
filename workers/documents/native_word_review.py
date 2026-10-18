"""Internal Word preview-to-review-artifact orchestration; never print-ready.

The caller must supply source bytes and request/revision anchors resolved from
trusted server records. This library has no HTTP, Core persistence, or printer
integration. Real Word launch is off unless an internal privileged caller
explicitly supplies ``NativeWordReviewConfig(allow_word_launch=True)``.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
from pathlib import Path
import re
from typing import Any

from agents.windows.native_word_document import preview_word_native
from .bridge import _canonical
from .native_word_artifacts import make_word_review_artifacts


@dataclass(frozen=True)
class NativeWordReviewConfig:
    """Trusted in-process configuration; never deserialize from a request."""

    allow_word_launch: bool = False


def _held(reason: str) -> dict[str, Any]:
    return {
        "schema": "ai3.native_word_preview.v1",
        "status": "NEEDS_HUMAN",
        "reason_code": reason,
        "ready": False,
        "allowed_to_print": False,
        "requires_staff_review": True,
        "physical_print_verified": False,
        "source_format": "DOCX",
        "print_source_format": "DOCX",
    }


def _safe_reason(value: Any, fallback: str) -> str:
    return value if type(value) is str and re.fullmatch(r"[A-Z0-9_]{1,80}", value) else fallback


def prepare_native_word_review(*, source: bytes, expected_source_sha256: str,
                               trusted_request_data: dict[str, Any],
                               expected_request_hash: str, revision: int,
                               artifact_root: str | Path,
                               config: NativeWordReviewConfig | None = None
                               ) -> dict[str, Any]:
    """Create an immutable Word preview bundle for staff review only.

    ``source`` must remain available to the caller regardless of result. This
    function neither rewrites the source nor converts it into a print PDF. The
    watchdog's PDF export is only a temporary preview rasterization input.
    """
    selected = config if config is not None else NativeWordReviewConfig()
    if type(selected) is not NativeWordReviewConfig or type(selected.allow_word_launch) is not bool:
        return _held("WORD_LAUNCH_CONFIGURATION_INVALID")
    if type(source) is not bytes or not source:
        return _held("SOURCE_UNVERIFIED")
    if (type(expected_source_sha256) is not str or len(expected_source_sha256) != 64 or
            any(char not in "0123456789abcdef" for char in expected_source_sha256) or
            hashlib.sha256(source).hexdigest() != expected_source_sha256):
        return _held("SOURCE_HASH_MISMATCH")
    if (type(revision) is not int or revision < 1 or
            not isinstance(trusted_request_data, dict) or
            type(trusted_request_data.get("documents")) is not list or
            len(trusted_request_data["documents"]) != 1):
        return _held("REQUEST_UNVERIFIED")
    try:
        calculated_request_hash = hashlib.sha256(
            _canonical(trusted_request_data).encode("utf-8")).hexdigest()
    except Exception:
        return _held("REQUEST_UNVERIFIED")
    if (type(expected_request_hash) is not str or
            calculated_request_hash != expected_request_hash):
        return _held("REQUEST_HASH_MISMATCH")

    try:
        # The public entry delegates real COM to the bounded watchdog. The
        # only launch control comes from the internal config object above.
        observation = preview_word_native(
            source, expected_sha256=expected_source_sha256,
            allow_word_launch=selected.allow_word_launch)
    except Exception:
        return _held("WORD_PREVIEW_UNAVAILABLE")
    if not isinstance(observation, dict):
        return _held("WORD_PREVIEW_UNVERIFIED")
    if observation.get("status") == "NEEDS_HUMAN":
        return _held(_safe_reason(observation.get("reason_code"), "WORD_PREVIEW_UNVERIFIED"))
    if observation.get("status") != "REVIEW_REQUIRED":
        return _held("WORD_PREVIEW_UNVERIFIED")
    if (observation.get("schema") != "ai3.word_native_preview.v1" or
            observation.get("evidence_kind") != "windows_word_com_preview_only" or
            observation.get("native_word_verified") is not True or
            observation.get("physical_print_verified") is not False or
            observation.get("allowed_to_print") is not False or
            observation.get("source_format") != "DOCX" or
            observation.get("print_source_format") != "DOCX" or
            observation.get("source_sha256") != expected_source_sha256):
        return _held("WORD_NATIVE_EVIDENCE_UNVERIFIED")

    try:
        bundle = make_word_review_artifacts(
            source=source,
            trusted_request_data=trusted_request_data,
            expected_request_hash=expected_request_hash,
            revision=revision,
            observation=observation,
            artifact_root=artifact_root,
        )
    except Exception:
        return _held("WORD_NATIVE_ARTIFACT_UNVERIFIED")
    if not isinstance(bundle, dict):
        return _held("WORD_NATIVE_ARTIFACT_UNVERIFIED")
    if bundle.get("status") != "REVIEW_REQUIRED":
        return _held(_safe_reason(bundle.get("reason_code"), "WORD_NATIVE_ARTIFACT_UNVERIFIED"))
    if (bundle.get("ready") is not False or bundle.get("allowed_to_print") is not False or
            bundle.get("requires_staff_review") is not True or
            bundle.get("physical_print_verified") is not False or
            bundle.get("source_sha256") != expected_source_sha256):
        return _held("WORD_NATIVE_ARTIFACT_UNVERIFIED")
    return bundle
