"""Private PDF source/preview bundle that always requires staff review."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import tempfile
from typing import Any

from . import processor
from .bridge import _canonical, _pdf_font_reliable

SCHEMA = "ai3.native_pdf_preview.v1"
_DIGEST = re.compile(r"[0-9a-f]{64}")


def _sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _hold(code: str, anchors: dict[str, Any] | None = None) -> dict[str, Any]:
    result = {"schema": SCHEMA, "status": "NEEDS_HUMAN", "reason_code": code,
        "ready": False, "allowed_to_print": False, "requires_staff_review": True,
        "physical_print_verified": False, "source_format": "PDF", "print_source_format": "PDF"}
    if anchors:
        result.update(anchors)
    return result


def _safe_ref(value: Any) -> bool:
    if type(value) is not str or not value or len(value) > 512 or value != value.strip():
        return False
    if re.search(r"[\x00-\x20\\:?#\[\]]", value):
        return False
    parts = value.split("/")
    return (len(parts) == 2
            and re.fullmatch(r"[A-Za-z0-9_-]+", parts[0]) is not None
            and re.fullmatch(r"[A-Za-z0-9._-]+", parts[1]) is not None
            and parts[1] not in (".", ".."))


def _request_settings(request_data: Any, verified_source_ref: str
                      ) -> tuple[dict[str, Any] | None, str | None]:
    """Map Core's unchanged single-source request to native preview settings.

    Core hashes and stores ``documents[].artifact_name`` as part of the request.
    It must equal the already-verified private source ref; it is never used to
    locate or open a file here.
    """
    if type(request_data) is not dict or set(request_data) != {"documents"}:
        return None, "PDF_REQUEST_SHAPE_UNSUPPORTED"
    documents = request_data["documents"]
    if type(documents) is not list or len(documents) != 1:
        return None, "PDF_REQUEST_SHAPE_UNSUPPORTED"
    document = documents[0]
    if (type(document) is not dict or
            set(document) != {"artifact_name", "copies", "duplex", "paper"} or
            type(document.get("artifact_name")) is not str):
        return None, "PDF_REQUEST_SHAPE_UNSUPPORTED"
    if document["artifact_name"] != verified_source_ref:
        return None, "PDF_REQUEST_SOURCE_MISMATCH"
    if (type(document.get("copies")) is not int or not 1 <= document["copies"] <= 999 or
            type(document.get("duplex")) is not bool or
            type(document.get("paper")) is not str or document["paper"] not in ("A4", "A3")):
        return None, "PDF_REQUEST_SETTINGS_INVALID"
    return ({"copies": document["copies"], "duplex": document["duplex"],
             "paper": document["paper"]}, None)


def make_pdf_review_artifacts(*, source: bytes, request_data: Any,
                              anchors: dict[str, Any], artifact_root: str | Path) -> dict[str, Any]:
    """Render one original PDF into an immutable private source/preview bundle.

    The preview raster is for staff inspection only. The frozen original PDF is
    retained as the print source, and the returned object never grants print
    readiness or physical-print authority.
    """
    folder: Path | None = None
    try:
        expected_anchor_keys = {"shop_id", "order_id", "active_revision", "request_hash",
                                "source", "input_manifest"}
        if type(anchors) is not dict or set(anchors) != expected_anchor_keys:
            return _hold("SOURCE_ANCHORS_UNVERIFIED")
        revision, request_hash = anchors["active_revision"], anchors["request_hash"]
        source_anchor, input_manifest = anchors["source"], anchors["input_manifest"]
        if (type(anchors["shop_id"]) is not str or not anchors["shop_id"]
                or type(anchors["order_id"]) is not str or not anchors["order_id"]
                or type(revision) is not int or revision < 1
                or type(request_hash) is not str or not _DIGEST.fullmatch(request_hash)
                or type(source_anchor) is not dict
                or set(source_anchor) != {"format", "artifact_ref", "sha256", "size_bytes"}
                or source_anchor.get("format") != "PDF"
                or not _safe_ref(source_anchor.get("artifact_ref"))
                or type(source_anchor.get("sha256")) is not str
                or not _DIGEST.fullmatch(source_anchor["sha256"])
                or type(source_anchor.get("size_bytes")) is not int
                or source_anchor["size_bytes"] < 1
                or type(input_manifest) is not dict
                or set(input_manifest) != {"ref", "sha256"}
                or not _safe_ref(input_manifest.get("ref"))
                or type(input_manifest.get("sha256")) is not str
                or not _DIGEST.fullmatch(input_manifest["sha256"])):
            return _hold("SOURCE_ANCHORS_UNVERIFIED")
        source_parts = PurePosixPath(source_anchor["artifact_ref"]).parts
        manifest_parts = PurePosixPath(input_manifest["ref"]).parts
        if source_parts[0] != manifest_parts[0]:
            return _hold("SOURCE_MANIFEST_BUNDLE_MISMATCH", anchors)
        if (type(source) is not bytes or not 0 < len(source) <= processor.MAX_FILE
                or source_anchor["size_bytes"] != len(source)
                or source_anchor["sha256"] != _sha(source)
                or not source.startswith(b"%PDF-")):
            return _hold("SOURCE_BYTES_UNVERIFIED", anchors)
        # Preserve and verify the exact Core request before deriving settings.
        # Never rewrite request_data to fit the worker's internal plan shape.
        if _sha(_canonical(request_data).encode("utf-8")) != request_hash:
            return _hold("REQUEST_HASH_MISMATCH", anchors)
        settings, request_error = _request_settings(request_data, source_anchor["artifact_ref"])
        if request_error is not None or settings is None:
            return _hold(request_error or "PDF_REQUEST_SHAPE_UNSUPPORTED", anchors)
        if not source_anchor["artifact_ref"].lower().endswith(".pdf"):
            return _hold("SOURCE_FORMAT_UNVERIFIED", anchors)

        # Unembedded/unverified fonts and encrypted PDFs require manual review.
        if not _pdf_font_reliable(source):
            return _hold("PDF_FONT_OR_ENCRYPTION_UNVERIFIED", anchors)
        root = Path(artifact_root)
        if not root.is_dir() or root.is_symlink():
            return _hold("ARTIFACT_ROOT_UNVERIFIED", anchors)
        folder = Path(tempfile.mkdtemp(prefix="doc-", dir=root))
        os.chmod(folder, 0o700)
        source_hash = _sha(source)
        source_name = f"source-000-{source_hash}.pdf"
        source_path = folder / source_name
        with source_path.open("xb") as output:
            output.write(source)
            output.flush()
            os.fsync(output.fileno())
        os.chmod(source_path, 0o400)
        if _sha(source_path.read_bytes()) != source_hash:
            raise ValueError("SOURCE_SNAPSHOT_MISMATCH")

        render = processor._inspect_data(source_parts[-1], source, folder,
                                         f"{source_hash[:16]}-0")
        if (render.get("status") != "READY" or render.get("file_sha256") != source_hash
                or render.get("render_method", "").split("-", 1)[0] != "pymupdf"
                or not render.get("preview_files")):
            raise ValueError("PDF_RENDER_UNVERIFIED")
        counted = processor.plan([{**render, **settings}])
        page_plan = counted["files"][0]
        preview_records: list[dict[str, Any]] = []
        for name in render["preview_files"]:
            if Path(name).name != name:
                raise ValueError("UNSAFE_PREVIEW_NAME")
            preview_path = folder / name
            if not preview_path.is_file() or preview_path.is_symlink():
                raise ValueError("PREVIEW_NOT_FOUND")
            preview_bytes = preview_path.read_bytes()
            if not preview_bytes.startswith(b"\x89PNG\r\n\x1a\n") or not 0 < len(preview_bytes) <= 10 * 1024 * 1024:
                raise ValueError("PREVIEW_UNVERIFIED")
            preview_records.append({"ref": f"{folder.name}/{name}",
                "sha256": _sha(preview_bytes), "bytes": len(preview_bytes)})

        settings_hash = _sha(_canonical(settings).encode("utf-8"))
        file_row = {
            "source_artifact_ref": f"{folder.name}/{source_name}",
            "file_sha256": source_hash, "size_bytes": len(source),
            "settings_sha256": settings_hash,
            "render_method": render["render_method"],
            "document_pages": render["document_pages"],
            "printed_faces": page_plan["printed_faces"],
            "physical_sheets": page_plan["physical_sheets"],
            "warnings": render.get("warnings", []),
        }
        import fitz
        manifest = {
            "schema": SCHEMA, "status": "REVIEW_REQUIRED",
            "shop_id": anchors["shop_id"], "order_id": anchors["order_id"],
            "active_revision": revision, "request_hash": request_hash,
            "source": source_anchor, "input_manifest": input_manifest,
            "files": [file_row], "previews": preview_records,
            "paper_plan": counted["files"],
            "counts": {key: counted[key] for key in ("document_pages", "printed_faces",
                "physical_sheets", "requires_price_confirmation")},
            "renderer_versions": {"pymupdf": fitz.VersionBind},
            "evidence_kind": "pymupdf_pdf_preview_only",
            "settings_sha256": settings_hash,
            "ready": False, "allowed_to_print": False,
            "requires_staff_review": True, "physical_print_verified": False,
        }
        manifest_path = folder / "manifest.json"
        with manifest_path.open("x", encoding="utf-8") as output:
            json.dump(manifest, output, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
            output.flush()
            os.fsync(output.fileno())
        manifest_bytes = manifest_path.read_bytes()
        return {
            "schema": SCHEMA, "status": "REVIEW_REQUIRED",
            "shop_id": anchors["shop_id"], "order_id": anchors["order_id"],
            "active_revision": revision, "request_hash": request_hash,
            "reason_code": "PDF_PREVIEW_REQUIRES_STAFF_REVIEW",
            "ready": False, "allowed_to_print": False,
            "requires_staff_review": True, "physical_print_verified": False,
            "source_format": "PDF", "print_source_format": "PDF",
            "artifact_ref": f"{folder.name}/manifest.json",
            "manifest_sha256": _sha(manifest_bytes),
            "source": source_anchor, "input_manifest": input_manifest,
            "source_sha256": source_hash, "settings_sha256": settings_hash,
            "preview_artifacts": preview_records,
            "document_pages": counted["document_pages"],
            "printed_faces": counted["printed_faces"],
            "physical_sheets": counted["physical_sheets"],
            "requires_price_confirmation": counted["requires_price_confirmation"],
            "renderer_versions": manifest["renderer_versions"],
        }
    except Exception:
        if folder is not None:
            try:
                shutil.rmtree(folder)
            except OSError:
                pass
        return _hold("PDF_NATIVE_ARTIFACT_UNVERIFIED", anchors if type(anchors) is dict else None)
