"""Word-native provisional artifact bundle (staff REVIEW_REQUIRED, never READY).

Only trusted AI0 internal code may provide DB-bound request/revision and an
in-process Windows Word observation. This does not publish a Core print plan
or provide an API endpoint. Existing PDF bridge remains the PDF renderer.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
from typing import Any

from .bridge import _canonical
from . import processor

SCHEMA = "ai3.native_word_preview.v1"


def _sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def make_word_review_artifacts(*, source: bytes, trusted_request_data: dict[str, Any],
                               expected_request_hash: str, revision: int,
                               observation: dict[str, Any],
                               artifact_root: str | Path) -> dict[str, Any]:
    """Create private immutable DOCX+PNG bundle; human review always required.

    No COM, PDF conversion, printer or Core mutation here. Fake observations,
    wrong revision/hash/settings, and untrusted previews are rejected.
    """
    def hold(code: str) -> dict[str, Any]:
        return {"schema": SCHEMA, "status": "NEEDS_HUMAN",
                "reason_code": code, "ready": False,
                "allowed_to_print": False}

    folder: Path | None = None
    try:
        if type(revision) is not int or revision < 1:
            return hold("REVISION_UNVERIFIED")
        if type(source) is not bytes or not 0 < len(source) <= processor.MAX_FILE:
            return hold("SOURCE_UNVERIFIED")
        if (not isinstance(trusted_request_data, dict) or
                set(trusted_request_data) != {"documents"} or
                type(trusted_request_data.get("documents")) is not list or
                len(trusted_request_data["documents"]) != 1):
            return hold("REQUEST_UNVERIFIED")
        request_hash = _sha(_canonical(trusted_request_data).encode("utf-8"))
        if request_hash != expected_request_hash:
            return hold("REQUEST_HASH_MISMATCH")
        doc = trusted_request_data["documents"][0]
        if not isinstance(doc, dict) or set(doc) - {
            "artifact_name", "copies", "duplex", "paper",
            "orientation", "binding", "page_range"} or "artifact_name" not in doc:
            return hold("SETTINGS_UNVERIFIED")
        if not isinstance(doc["artifact_name"], str) or not doc["artifact_name"].lower().endswith(".docx"):
            return hold("FORMAT_NOT_WORD")
        settings = {k: v for k, v in doc.items() if k != "artifact_name"}
        source_hash = _sha(source)
        if (not isinstance(observation, dict) or
                observation.get("status") != "REVIEW_REQUIRED" or
                observation.get("source_sha256") != source_hash or
                observation.get("evidence_kind") != "windows_word_com_preview_only" or
                observation.get("native_word_verified") is not True or
                observation.get("print_source_format") != "DOCX" or
                observation.get("allowed_to_print") is not False):
            return hold("WORD_NATIVE_EVIDENCE_UNVERIFIED")
        pages = observation.get("document_pages")
        if type(pages) is not int or not 1 <= pages <= processor.MAX_PAGES:
            return hold("WORD_PAGE_COUNT_UNVERIFIED")
        raw_previews = observation.get("preview_png")
        digests = observation.get("preview_sha256")
        if (type(raw_previews) is not tuple or not 1 <= len(raw_previews) <= 3 or
                type(digests) is not tuple or len(digests) != len(raw_previews)):
            return hold("WORD_PREVIEW_UNVERIFIED")
        for blob, digest in zip(raw_previews, digests):
            if (type(blob) is not bytes or not blob.startswith(b"\x89PNG\r\n\x1a\n") or
                    not 0 < len(blob) <= 10 * 1024 * 1024 or
                    _sha(blob) != digest):
                return hold("WORD_PREVIEW_UNVERIFIED")
        counted = processor.plan([{
            "status": "READY", "file_sha256": source_hash,
            "document_pages": pages, **settings,
        }])
        root = Path(artifact_root)
        if not root.is_dir() or root.is_symlink():
            return hold("ARTIFACT_ROOT_UNVERIFIED")
        folder = Path(tempfile.mkdtemp(prefix="doc-", dir=root))
        os.chmod(folder, 0o700)
        source_name = f"source-000-{source_hash}.docx"
        snapshot = folder / source_name
        with snapshot.open("xb") as f:
            f.write(source)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(snapshot, 0o400)
        if _sha(snapshot.read_bytes()) != source_hash:
            raise ValueError("snapshot hash mismatch")
        indices = sorted({0, pages // 2, pages - 1})
        if len(indices) != len(raw_previews):
            raise ValueError("preview page-index mismatch")
        entries: list[dict[str, Any]] = []
        for index, blob in zip(indices, raw_previews):
            name = f"{source_hash[:16]}-0-p{index + 1}.png"
            with (folder / name).open("xb") as f:
                f.write(blob)
                f.flush()
                os.fsync(f.fileno())
            entries.append({"ref": f"{folder.name}/{name}",
                            "sha256": _sha(blob), "bytes": len(blob)})
        file_row = {
            "source_artifact_ref": f"{folder.name}/{source_name}",
            "file_sha256": source_hash, "size_bytes": len(source),
            "settings_sha256": _sha(_canonical(settings).encode("utf-8")),
            "render_method": "word_com_native_preview_only",
            "document_pages": pages,
            "printed_faces": counted["printed_faces"],
            "physical_sheets": counted["physical_sheets"],
        }
        manifest = {
            "schema": SCHEMA, "revision": revision,
            "request_hash": request_hash, "files": [file_row],
            "previews": entries, "paper_plan": counted["files"],
            "counts": {k: counted[k] for k in ("document_pages", "printed_faces",
                                               "physical_sheets", "requires_price_confirmation")},
            "evidence_kind": "windows_word_com_preview_only",
            "ready": False, "requires_staff_review": True,
            "physical_print_verified": False,
        }
        manifest_file = folder / "manifest.json"
        with manifest_file.open("x", encoding="utf-8") as f:
            json.dump(manifest, f, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
            f.flush()
            os.fsync(f.fileno())
        return {
            "schema": SCHEMA, "status": "REVIEW_REQUIRED",
            "reason_code": "WORD_FONT_AND_RICOH_LAYOUT_UNVERIFIED",
            "ready": False, "allowed_to_print": False,
            "artifact_ref": f"{folder.name}/manifest.json",
            "manifest_sha256": _sha(manifest_file.read_bytes()),
            "source_sha256": source_hash,
            "settings_sha256": file_row["settings_sha256"],
            "preview_artifacts": entries,
            "document_pages": pages, "printed_faces": counted["printed_faces"],
            "physical_sheets": counted["physical_sheets"],
            "requires_price_confirmation": counted["requires_price_confirmation"],
        }
    except Exception:
        if folder is not None:
            try:
                shutil.rmtree(folder)
            except OSError:
                pass
        return hold("WORD_NATIVE_ARTIFACT_UNVERIFIED")
