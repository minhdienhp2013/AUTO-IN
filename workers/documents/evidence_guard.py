"""CODE-403: verify sealed document bytes, raster previews and paper plan together.

This is a SERVER-ONLY evidence gate, not a print authorization. AI0/AI1
must resolve every argument from the authenticated shop/order/revision row.
Never populate this structure from webhook/client-controlled JSON or paths.

No Windows driver or actual print side effect exists in this module.
"""
from __future__ import annotations

import hashlib
import io
import json
from pathlib import Path
import re
from typing import Any

from . import bridge, processor

SCHEMA = "ai3.approved_evidence.v1"
_HASH = re.compile(r"^[0-9a-f]{64}$")
_REF = re.compile(r"^(doc-[a-zA-Z0-9_-]{6,64})/manifest\.json$")
_SOURCE = re.compile(
    r"^doc-[a-zA-Z0-9_-]{6,64}/source-[0-9]{3}-([0-9a-f]{64})\."
    r"(pdf|png|jpg|jpeg|tif|tiff|webp|bmp)$"
)
_PREVIEW = re.compile(r"^doc-[a-zA-Z0-9_-]{6,64}/[0-9a-f]{16}-[0-4]-p[1-9][0-9]*\.png$")
_MAX_PREVIEWS = processor.MAX_DOCS * 3


class _Untrusted(Exception):
    def __init__(self, code: str = "UNVERIFIED_EVIDENCE"):
        self.code = code


def _fail(code: str) -> dict[str, Any]:
    return {"schema": SCHEMA, "status": "NEEDS_HUMAN",
            "ready": False, "reason_code": code}


def _require(condition: bool, reason: str = "UNVERIFIED_EVIDENCE") -> None:
    if not condition:
        raise _Untrusted(reason)


def _hex(value: Any) -> bool:
    return isinstance(value, str) and _HASH.fullmatch(value) is not None


def _positive(value: Any, limit: int) -> bool:
    return type(value) is int and 0 < value <= limit


def _read(root: Path, ref: str, limit: int) -> bytes:
    # bridge._read_scoped guards every path segment with openat/O_NOFOLLOW
    # and caps read length; verify expected bounds AFTER reading.
    try:
        raw = bridge._read_scoped(root, ref)
    except Exception as exc:
        raise _Untrusted("EVIDENCE_STORAGE_UNAVAILABLE") from exc
    _require(0 < len(raw) <= limit, "EVIDENCE_SIZE_INVALID")
    return raw


def verify_approved_evidence(trusted: dict[str, Any], *,
                             artifact_root: str | Path) -> dict[str, Any]:
    """Check immutable processor evidence against AI0's DB-anchored context.

    Required trusted fields: active_revision, approval_revision, request_hash,
    approval_id, manifest_ref, manifest_sha256, plan. Approval/customer identity,
    quote requirements, shop scope and job lease must be checked in AI1 PG.
    Nothing here can create confirmation/approval, or prove printed paper.
    """
    try:
        _require(isinstance(trusted, dict) and set(trusted) == {
            "active_revision", "approval_revision", "request_hash", "approval_id",
            "manifest_ref", "manifest_sha256", "plan"})
        a = trusted["active_revision"]
        b = trusted["approval_revision"]
        _require(_positive(a, 2**31 - 1) and _positive(b, 2**31 - 1) and a == b,
                 "STALE_REVISION")
        _require(_hex(trusted["request_hash"]) and _hex(trusted["manifest_sha256"]))
        _require(isinstance(trusted["approval_id"], str) and bool(trusted["approval_id"]))
        ref = trusted["manifest_ref"]
        _require(isinstance(ref, str) and _REF.fullmatch(ref) is not None)
        prefix = ref.split("/")[0]
        root = Path(artifact_root)
        _require(root.is_dir() and not root.is_symlink(), "EVIDENCE_STORAGE_UNAVAILABLE")
        raw_manifest = _read(root, ref, 256 * 1024)
        _require(hashlib.sha256(raw_manifest).hexdigest() == trusted["manifest_sha256"],
                 "MANIFEST_CHANGED")
        try:
            manifest = json.loads(raw_manifest.decode("utf-8"),
                                  object_pairs_hook=bridge._no_duplicate_keys,
                                  parse_constant=bridge._no_nonfinite_json)
        except (UnicodeError, ValueError, TypeError) as exc:
            raise _Untrusted("UNVERIFIED_EVIDENCE") from exc
        _require(isinstance(manifest, dict) and manifest.get("schema") == bridge.SCHEMA)
        plan = trusted["plan"]
        _require(isinstance(plan, dict) and plan.get("ready") is True and
                 plan.get("artifact_ref") == ref and
                 plan.get("request_hash") == trusted["request_hash"] and
                 plan.get("printer_id") == "RMP7000")
        _require(manifest.get("request_hash") == trusted["request_hash"],
                 "REQUEST_HASH_CHANGED")
        files = manifest.get("files")
        papers = manifest.get("paper_plan")
        images = manifest.get("previews")
        counts = manifest.get("counts")
        _require(isinstance(files, list) and 1 <= len(files) <= processor.MAX_DOCS
                 and isinstance(papers, list) and len(papers) == len(files)
                 and isinstance(images, list) and 1 <= len(images) <= _MAX_PREVIEWS
                 and isinstance(counts, dict))
        used_refs: set[str] = set()
        verified_sources = []
        recalculated = []
        for index, (f, paper) in enumerate(zip(files, papers)):
            _require(isinstance(f, dict) and isinstance(paper, dict))
            source_ref = f.get("source_artifact_ref")
            match = _SOURCE.fullmatch(source_ref) if isinstance(source_ref, str) else None
            _require(bool(match) and source_ref.startswith(prefix + "/") and
                     source_ref.split("/")[1].startswith(f"source-{index:03d}-") and
                     source_ref not in used_refs and _hex(f.get("file_sha256")) and
                     match.group(1) == f["file_sha256"])
            used_refs.add(source_ref)
            _require(_positive(f.get("size_bytes"), processor.MAX_FILE))
            raw_source = _read(root, source_ref, processor.MAX_FILE)
            _require(len(raw_source) == f["size_bytes"] and
                     hashlib.sha256(raw_source).hexdigest() == f["file_sha256"],
                     "SOURCE_CHANGED")
            _require(_positive(f.get("document_pages"), processor.MAX_PAGES))
            selected = paper.get("selected_pages")
            _require(isinstance(selected, list) and 1 <= len(selected) <= processor.MAX_PAGES
                     and all(_positive(p, f["document_pages"]) for p in selected)
                     and len(set(selected)) == len(selected) and
                     _positive(paper.get("copies"), 999))
            _require(paper.get("duplex") in (True, False) and
                     type(paper["duplex"]) is bool and
                     paper.get("paper") in ("A4", "A3") and
                     paper.get("orientation") in ("portrait", "landscape") and
                     paper.get("binding") in ("long_edge", "short_edge"))
            # Count from verified page selection, not caller-provided totals.
            computed = processor.plan([{
                "status": "READY", "file_sha256": f["file_sha256"],
                "document_pages": f["document_pages"],
                "page_range": ",".join(map(str, selected)),
                "copies": paper["copies"], "duplex": paper["duplex"],
                "paper": paper["paper"], "orientation": paper["orientation"],
                "binding": paper["binding"],
            }])["files"][0]
            _require(paper == computed and
                     f.get("printed_faces") == computed["printed_faces"] and
                     f.get("physical_sheets") == computed["physical_sheets"],
                     "COUNTS_MISMATCH")
            _require(_hex(f.get("settings_sha256")) and
                     isinstance(f.get("render_method"), str) and f["render_method"])
            verified_sources.append(f["file_sha256"])
            recalculated.append(computed)

        # Each preview must belong to its matching file and be a decodable
        # real PNG, not a forged PNG signature or an arbitrary document path.
        image_hashes = []
        images_for_source = [0] * len(files)
        for entry in images:
            _require(isinstance(entry, dict))
            image_ref = entry.get("ref")
            _require(isinstance(image_ref, str) and _PREVIEW.fullmatch(image_ref) is not None
                     and image_ref.startswith(prefix + "/") and image_ref not in used_refs
                     and _hex(entry.get("sha256")) and
                     _positive(entry.get("bytes"), 8 * 1024 * 1024))
            used_refs.add(image_ref)
            matching = [i for i, digest in enumerate(verified_sources)
                        if image_ref.split("/")[1].startswith(digest[:16] + f"-{i}-p")]
            _require(len(matching) == 1)
            images_for_source[matching[0]] += 1
            raw_image = _read(root, image_ref, 8 * 1024 * 1024)
            _require(len(raw_image) == entry["bytes"] and
                     hashlib.sha256(raw_image).hexdigest() == entry["sha256"],
                     "PREVIEW_CHANGED")
            _require(raw_image.startswith(b"\x89PNG\r\n\x1a\n"), "PREVIEW_CHANGED")
            try:
                from PIL import Image
                with Image.open(io.BytesIO(raw_image)) as picture:
                    _require(picture.format == "PNG" and
                             0 < picture.width * picture.height <= 40_000_000,
                             "PREVIEW_CHANGED")
                    picture.verify()
            except Exception as exc:
                raise _Untrusted("PREVIEW_CHANGED") from exc
            image_hashes.append(entry["sha256"])
        _require(all(1 <= n <= 3 for n in images_for_source), "PREVIEW_CHANGED")

        expected_pages = sum(f["document_pages"] for f in files)
        expected_faces = sum(p["printed_faces"] for p in recalculated)
        expected_sheets = sum(p["physical_sheets"] for p in recalculated)
        _require(expected_pages == counts.get("document_pages") ==
                 plan.get("document_pages") and
                 expected_faces == counts.get("printed_faces") ==
                 plan.get("printed_faces") and
                 expected_sheets == counts.get("physical_sheets") ==
                 plan.get("physical_sheets") and
                 counts.get("requires_price_confirmation") is (expected_sheets > 150),
                 "COUNTS_MISMATCH")
        _require(isinstance(manifest.get("renderer_versions"), dict) and
                 manifest.get("evidence_kind") == "local_render_verified_artifacts")
        stable = {
            "request_hash": trusted["request_hash"],
            "renderer_versions": manifest["renderer_versions"],
            "files": [{k: v for k, v in f.items() if k != "source_artifact_ref"}
                      for f in files],
            "preview_sha256": image_hashes,
            "counts": counts,
            "paper_plan": papers,
        }
        _require(hashlib.sha256(bridge._canonical(stable).encode("utf-8")).hexdigest()
                 == manifest.get("content_settings_sha256"), "MANIFEST_CHANGED")
        return {
            "schema": SCHEMA, "status": "READY", "ready": True,
            "metadata": {
                "revision": a, "request_hash": trusted["request_hash"],
                "manifest_sha256": trusted["manifest_sha256"],
                "content_settings_sha256": manifest["content_settings_sha256"],
                "source_sha256": verified_sources, "preview_sha256": image_hashes,
                "document_count": len(files), "preview_count": len(images),
                "document_pages": expected_pages, "printed_faces": expected_faces,
                "physical_sheets": expected_sheets,
                "requires_price_confirmation": expected_sheets > 150,
                "paper_verified": False, "print_evidence_kind": "pre_send_document_only",
            }
        }
    except _Untrusted as err:
        return _fail(err.code)
    except Exception:
        # Never leak raw customer content, file names, paths or exception text.
        return _fail("UNVERIFIED_EVIDENCE")
