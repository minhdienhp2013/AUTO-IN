"""AI3 CODE-203: fail-closed, JSON-only bridge for AI0's trusted processor Port.

Only the backend selects the two roots. The request supplies *relative* artifact
names; customer-provided counts, hashes, or absolute paths never become evidence.
This bridge DOES NOT approve orders, publish plans, or invoke a printer.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import sys
import tempfile
from typing import Any

from . import processor

SCHEMA = "ai3.document_bridge.v1"
MAX_REQUEST = 256 * 1024
MAX_SAFE_JSON_INTEGER = 9007199254740991
DOCUMENT_KEYS = frozenset({
    "artifact_name", "copies", "duplex", "paper", "orientation", "binding", "page_range"
})


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _canonical(value: Any) -> str:
    """Match AI1 canonical() for supported JSON: no floats/unsafe JS numbers."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if type(value) is int and abs(value) <= MAX_SAFE_JSON_INTEGER:
        return str(value)
    if isinstance(value, list):
        return "[" + ",".join(_canonical(v) for v in value) + "]"
    if isinstance(value, dict) and all(isinstance(k, str) for k in value):
        return "{" + ",".join(
            _canonical(k) + ":" + _canonical(value[k]) for k in sorted(value)
        ) + "}"
    raise ValueError("UNSAFE_CANONICAL_REQUEST_DATA")


def _human(reason: str) -> dict[str, Any]:
    return {"schema": SCHEMA, "status": "NEEDS_HUMAN",
            "reason_code": reason, "ready": False}


def _read_scoped(root: Path, relative: str) -> bytes:
    """Use dirfd + O_NOFOLLOW on every segment, not resolve()-then-open()."""
    if (not isinstance(relative, str) or not relative or "\\" in relative
            or "\x00" in relative):
        raise ValueError("UNSAFE_ARTIFACT_NAME")
    path = PurePosixPath(relative)
    parts = path.parts
    if (path.is_absolute() or not parts or
            any(p in ("", ".", "..") for p in parts) or
            ":" in parts[0] or relative.startswith("./")):
        raise ValueError("UNSAFE_ARTIFACT_NAME")
    # This worker only supports POSIX secure directory-relative opens. Never
    # silently downgrade to a symlink-following Windows file open.
    if not hasattr(os, "O_NOFOLLOW") or not hasattr(os, "O_DIRECTORY"):
        raise ValueError("SCOPED_OPEN_UNAVAILABLE")
    directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                            dir_fd=directory)
            os.close(directory)
            directory = child
        fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_size <= 0 or info.st_size > processor.MAX_FILE:
                raise ValueError("INVALID_FILE_SIZE")
            with os.fdopen(fd, "rb", closefd=False) as source:
                data = source.read(processor.MAX_FILE + 1)
            if not data or len(data) > processor.MAX_FILE:
                raise ValueError("INVALID_FILE_SIZE")
            return data
        finally:
            os.close(fd)
    finally:
        os.close(directory)


def _pdf_font_reliable(data: bytes) -> bool:
    """Unembedded PDF fonts can be substituted on Windows; require human review."""
    import fitz
    try:
        with fitz.open(stream=data, filetype="pdf") as pdf:
            if pdf.needs_pass or pdf.is_encrypted:
                return False
            for page in pdf:
                for font in page.get_fonts(full=True):
                    xref = font[0]
                    if not isinstance(xref, int) or xref <= 0:
                        return False
                    extracted = pdf.extract_font(xref)
                    if not extracted or not extracted[-1]:
                        return False
        return True
    except Exception:
        return False


def _pieces(name: str, raw: bytes) -> list[tuple[str, bytes]]:
    if Path(name).suffix.lower() != ".zip":
        return [(name, raw)]
    entries, error = processor._check_archive(raw)
    if error:
        raise ValueError(error)
    if not entries:
        raise ValueError("ZIP_NO_DOCUMENTS")
    return entries


def process_request(value: dict[str, Any], *, input_root: str | Path,
                    artifact_root: str | Path) -> dict[str, Any]:
    """Return READY with an AI1 publishVerifiedPlan-shaped plan or NEEDS_HUMAN.

    input: {"request_data":{"documents":[{"artifact_name":"incoming/a.pdf",
            "copies":2,"duplex":true,"paper":"A4"}]},
            "expected_request_hash":"sha256 of AI1 canonical(request_data)"}
    Roots are a trusted server-side Port configuration, NEVER read from input JSON.
    """
    output_dir: Path | None = None
    try:
        if not isinstance(value, dict) or set(value) != {"request_data", "expected_request_hash"}:
            raise ValueError("INVALID_BRIDGE_INPUT")
        request_data = value["request_data"]
        expected_hash = value["expected_request_hash"]
        if not isinstance(request_data, dict) or not isinstance(expected_hash, str):
            raise ValueError("INVALID_BRIDGE_INPUT")
        request_hash = _sha(_canonical(request_data).encode("utf-8"))
        if expected_hash != request_hash:
            raise ValueError("REQUEST_HASH_MISMATCH")
        if set(request_data) != {"documents"}:
            raise ValueError("UNMAPPED_REQUEST_FIELDS")
        documents = request_data["documents"]
        if not isinstance(documents, list) or not 1 <= len(documents) <= processor.MAX_DOCS:
            raise ValueError("INVALID_DOCUMENT_COUNT")
        source_root = Path(input_root)
        target_root = Path(artifact_root)
        if (not source_root.is_dir() or source_root.is_symlink() or
                not target_root.is_dir() or target_root.is_symlink()):
            raise ValueError("UNVERIFIED_ARTIFACT_ROOT")

        # Make output private before any previews are rendered.
        output_dir = Path(tempfile.mkdtemp(prefix="doc-", dir=target_root))
        os.chmod(output_dir, 0o700)
        inspected: list[dict[str, Any]] = []
        evidence_files: list[dict[str, Any]] = []
        preview_records: list[dict[str, Any]] = []
        for index, item in enumerate(documents):
            if (not isinstance(item, dict) or
                    not {"artifact_name"} <= set(item) or
                    not set(item) <= DOCUMENT_KEYS):
                raise ValueError("UNMAPPED_DOCUMENT_FIELDS")
            name = item["artifact_name"]
            payload = _read_scoped(source_root, name)
            pieces = _pieces(name, payload)
            if len(inspected) + len(pieces) > processor.MAX_DOCS:
                raise ValueError("OVER_FIVE_DOCUMENTS")
            settings = {k: v for k, v in item.items() if k != "artifact_name"}
            for part_name, data in pieces:
                if Path(part_name).suffix.lower() == ".pdf" and not _pdf_font_reliable(data):
                    raise ValueError("PDF_FONT_NOT_EMBEDDED_OR_UNVERIFIED")
                result = processor._inspect_data(part_name, data, output_dir,
                                                 f"{_sha(data)[:16]}-{len(inspected)}")
                if result.get("status") != "READY":
                    raise ValueError(result.get("reason_code", "RENDER_NOT_VERIFIED"))
                if not result.get("preview_files") or not result.get("render_method"):
                    raise ValueError("MISSING_RENDERED_PREVIEW")
                candidate = {**result, **settings}
                # All count/hash/status fields come from processor, never from caller.
                counted = processor.plan([candidate])["files"][0]
                inspected.append(candidate)
                evidence_files.append({
                    "file_sha256": _sha(data),
                    "settings_sha256": _sha(_canonical(settings).encode("utf-8")),
                    "render_method": result["render_method"],
                    "document_pages": result["document_pages"],
                    "printed_faces": counted["printed_faces"],
                    "physical_sheets": counted["physical_sheets"],
                    "warnings": result.get("warnings", []),
                })
                for filename in result["preview_files"]:
                    if Path(filename).name != filename:
                        raise ValueError("UNSAFE_PREVIEW_NAME")
                    preview_path = output_dir / filename
                    if not preview_path.is_file() or preview_path.is_symlink():
                        raise ValueError("PREVIEW_NOT_FOUND")
                    preview_records.append({
                        "ref": f"{output_dir.name}/{filename}",
                        "sha256": _sha(preview_path.read_bytes()),
                        "bytes": preview_path.stat().st_size,
                    })
        final = processor.plan(inspected)
        if not evidence_files or not preview_records or final["physical_sheets"] < 1:
            raise ValueError("UNVERIFIED_DOCUMENT_PLAN")
        import fitz
        import PIL
        manifest = {
            "schema": SCHEMA,
            "request_hash": request_hash,
            "renderer_versions": {"pymupdf": fitz.VersionBind, "pillow": PIL.__version__},
            "files": evidence_files,
            "previews": preview_records,
            "counts": {
                "document_pages": final["document_pages"],
                "printed_faces": final["printed_faces"],
                "physical_sheets": final["physical_sheets"],
                "requires_price_confirmation": final["requires_price_confirmation"],
            },
            "paper_plan": final["files"],
            "evidence_kind": "local_render_verified_artifacts",
        }
        manifest["content_settings_sha256"] = _sha(_canonical(manifest).encode("utf-8"))
        manifest_path = output_dir / "manifest.json"
        with manifest_path.open("x", encoding="utf-8") as out:
            json.dump(manifest, out, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
            out.flush()
            os.fsync(out.fileno())
        plan = {
            "request_hash": request_hash,
            "physical_sheets": final["physical_sheets"],
            "document_pages": final["document_pages"],
            "printed_faces": final["printed_faces"],
            "ready": True,
            "printer_id": "RMP7000",
            "artifact_ref": f"{output_dir.name}/manifest.json",
            "verified_by": "ai3.processor.v1",
        }
        return {"schema": SCHEMA, "status": "READY", "plan": plan,
                "evidence_kind": "local_render_verified_artifacts",
                "content_settings_sha256": manifest["content_settings_sha256"],
                "renderer_versions": manifest["renderer_versions"],
                "preview_artifacts": preview_records,
                "requires_price_confirmation": final["requires_price_confirmation"]}
    except (ValueError, TypeError, OSError, UnicodeError, KeyError, OverflowError) as exc:
        if output_dir:
            shutil.rmtree(output_dir)
        reason = str(exc)
        # Never leak paths, filenames or exception bodies back to an API caller.
        if reason not in {
            "INVALID_BRIDGE_INPUT", "UNSAFE_CANONICAL_REQUEST_DATA", "REQUEST_HASH_MISMATCH",
            "UNMAPPED_REQUEST_FIELDS", "INVALID_DOCUMENT_COUNT",
            "UNVERIFIED_ARTIFACT_ROOT", "UNMAPPED_DOCUMENT_FIELDS", "OVER_FIVE_DOCUMENTS",
            "PDF_FONT_NOT_EMBEDDED_OR_UNVERIFIED", "MISSING_RENDERED_PREVIEW",
            "UNSAFE_PREVIEW_NAME", "PREVIEW_NOT_FOUND", "UNVERIFIED_DOCUMENT_PLAN",
            "UNSAFE_ARTIFACT_NAME", "SCOPED_OPEN_UNAVAILABLE", "INVALID_FILE_SIZE",
            "ZIP_NO_DOCUMENTS", "ZIP_PATH_TRAVERSAL", "ZIP_SYMLINK", "ZIP_ENCRYPTED",
            "ZIP_ENTRY_TOO_LARGE", "ZIP_COMPRESSION_RATIO", "ZIP_TOO_MANY_ENTRIES",
            "ZIP_EXPANSION_LIMIT", "ZIP_UNKNOWN_ENTRY", "ZIP_CORRUPT",
            "NESTED_ZIP_REQUIRES_HUMAN", "OVER_FIVE_DOCUMENTS", "ZIP_LENGTH_MISMATCH",
            "WORD_RENDER_PATH_NOT_VERIFIED", "FORMAT_REQUIRES_HUMAN", "DOCX_CORRUPT",
            "DOCX_EXPANSION_LIMIT", "UNSUPPORTED_FORMAT", "PDF_RENDER_FAILED",
            "IMAGE_DECODE_FAILED", "EXTENSION_CONTENT_MISMATCH", "INVALID_PAGE_COUNT",
            "IMAGE_TOO_LARGE", "PASSWORD_PROTECTED",
        }:
            reason = "PROCESSOR_UNVERIFIED"
        return _human(reason)


def main() -> int:
    import argparse
    parser = argparse.ArgumentParser(description="AUTO-IN document bridge; no print")
    parser.add_argument("--input-root", required=True)
    parser.add_argument("--artifact-root", required=True)
    args = parser.parse_args()
    body = sys.stdin.buffer.read(MAX_REQUEST + 1)
    if len(body) > MAX_REQUEST:
        result = _human("INPUT_TOO_LARGE")
    else:
        try:
            value = json.loads(body)
            result = process_request(value, input_root=args.input_root,
                                     artifact_root=args.artifact_root)
        except (ValueError, UnicodeDecodeError):
            result = _human("INVALID_JSON")
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    return 0 if result["status"] == "READY" else 2


if __name__ == "__main__":
    raise SystemExit(main())
