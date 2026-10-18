"""Synthetic AI1 WordReviewSourceV1 inputs for isolated AI3 unit tests."""
from __future__ import annotations

import hashlib
import json
from typing import Any

from workers.documents.bridge import _canonical


def sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def request_data() -> dict[str, Any]:
    return {"documents": [{
        "artifact_name": "customer-original.docx",
        "copies": 1,
        "paper": "A4",
        "duplex": False,
        "orientation": "portrait",
        "binding": "long_edge",
    }]}


def source_snapshot(source: bytes, request: dict[str, Any] | None = None, *,
                    shop_id: str = "synthetic-shop", order_id: str = "synthetic-order",
                    revision: int = 3, manifest_order_id: str | None = None) -> dict[str, Any]:
    trusted_request = request if request is not None else request_data()
    request_hash = sha(_canonical(trusted_request).encode("utf-8"))
    source_meta = {
        "format": "DOCX", "artifact_ref": "bundle-synthetic/source.docx",
        "sha256": sha(source), "size_bytes": len(source),
    }
    manifest_ref = "bundle-synthetic/manifest.json"
    manifest = {
        "schema": "ai0.word_review_manifest.v1",
        "manifest_ref": manifest_ref,
        "shop_id": shop_id,
        "order_id": manifest_order_id if manifest_order_id is not None else order_id,
        "active_revision": revision,
        "request_hash": request_hash,
        "source": source_meta,
    }
    manifest_bytes = json.dumps(
        manifest, sort_keys=True, ensure_ascii=False, separators=(",", ":")
    ).encode("utf-8")
    return {
        "schema": "ai0.word_review_source.v1",
        "shop_id": shop_id,
        "order_id": order_id,
        "active_revision": revision,
        "request_hash": request_hash,
        "request_data": trusted_request,
        "source": source_meta,
        "manifest": {"ref": manifest_ref, "sha256": sha(manifest_bytes)},
        "private_bytes": {"source": source, "manifest": manifest_bytes},
    }


def synthetic_observation(source: bytes) -> dict[str, Any]:
    # TEST-ONLY preview bytes and renderer label; never Windows/Word evidence.
    png = b"\x89PNG\r\n\x1a\nsynthetic-preview"
    return {
        "schema": "ai3.word_native_preview.v1",
        "status": "REVIEW_REQUIRED",
        "evidence_kind": "windows_word_com_preview_only",
        "native_word_verified": True,
        "print_source_format": "DOCX",
        "source_sha256": sha(source),
        "allowed_to_print": False,
        "renderer_identity": {
            "engine": "microsoft_word_com", "version": "SYNTHETIC-NOT-REAL",
        },
        "document_pages": 1,
        "preview_png": (png,),
        "preview_sha256": (sha(png),),
    }
