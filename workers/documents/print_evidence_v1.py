"""AI0 print_evidence.v1 tuple: byte-exact, read-only Word/PDF verifier.

The *caller* (AI0/AI1) must obtain original bytes, DB anchors, renderer and
printer capabilities independently from trusted server/Windows sources. This
module never reads an arbitrary path, authenticates staff or touches a printer.
Producing a digest is NOT an approval; verifying it against Core's independent
stored digest is necessary before simulation and any future physical action.
"""
from __future__ import annotations

import hashlib
import io
import json
import re
import zipfile
from typing import Any

from .bridge import _canonical
from . import processor

SCHEMA = "ai0.print_evidence.v1"
HEX = re.compile(r"^[0-9a-f]{64}$")
BUNDLE = re.compile(r"^doc-[A-Za-z0-9_-]{6,64}/manifest\.json$")
SOURCE = re.compile(r"^doc-[A-Za-z0-9_-]{6,64}/source-\d{3}-[a-f0-9]{64}\.(pdf|docx)$")
PNG = re.compile(r"^doc-[A-Za-z0-9_-]{6,64}/[A-Za-z0-9_-]+-p[1-9]\d*\.png$")
PDF_INPUT_REF_PART = re.compile(r"^[A-Za-z0-9_-]+$")
PDF_INPUT_REF_FILE = re.compile(r"^[A-Za-z0-9._-]+$")


def _sha(blob: bytes) -> str:
    return hashlib.sha256(blob).hexdigest()


def _canonical_hash(value: Any) -> str:
    return _sha(_canonical(value).encode("utf-8"))


def _hold(reason: str) -> dict[str, Any]:
    return {"schema": SCHEMA, "status": "NEEDS_HUMAN",
            "reason_code": reason, "allowed_to_print": False,
            "allowed_to_simulate": False, "physical_print_verified": False}


class _Invalid(Exception):
    pass


def _check(ok: bool, reason: str) -> None:
    if not ok:
        raise _Invalid(reason)


def _check_core_plan(plan: Any, *, context: dict[str, Any],
                     manifest_ref: str, counted: dict[str, Any]) -> str:
    """Hash the exact active Core PrintPlan and compare its processor counts.

    The processor's rich paper-plan object is not Core's PrintPlan. Hashing
    that object would produce a valid digest for the wrong contract. AI0 must
    supply the independently loaded plan from the active Core revision.
    """
    _check(type(plan) is dict, "CORE_PLAN_UNVERIFIED")
    _check(plan.get("request_hash") == context["request_hash"] and
           plan.get("printer_id") == context["printer_id"] == "RMP7000" and
           plan.get("artifact_ref") == manifest_ref and
           plan.get("ready") is True and
           type(plan.get("verified_by")) is str and bool(plan["verified_by"]),
           "CORE_PLAN_SCOPE_UNVERIFIED")
    for key in ("document_pages", "printed_faces", "physical_sheets"):
        value = plan.get(key)
        _check(type(value) is int and value > 0 and value == counted.get(key),
               "CORE_PLAN_COUNT_MISMATCH")
    try:
        # Preserve optional fields exactly as stored in Core. checkedEvidence
        # hashes canonical(scope.plan), including those fields when present.
        return _canonical_hash(plan)
    except Exception as exc:
        raise _Invalid("CORE_PLAN_UNVERIFIED") from exc


def _json_unique(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, val in pairs:
        if key in out:
            raise _Invalid("MANIFEST_UNVERIFIED")
        out[key] = val
    return out


def _no_nonfinite_json(value: str) -> None:
    raise _Invalid("PDF_INPUT_MANIFEST_UNVERIFIED")


def _safe_pdf_input_ref(value: Any) -> bool:
    if (type(value) is not str or not value or len(value) > 512 or
            value != value.strip() or re.search(r"[\x00-\x20\\:?#\[\]]", value)):
        return False
    parts = value.split("/")
    return (len(parts) == 2 and PDF_INPUT_REF_PART.fullmatch(parts[0]) is not None
            and PDF_INPUT_REF_FILE.fullmatch(parts[1]) is not None
            and parts[1] not in (".", ".."))


def _verify_native_pdf_request(*, request_data: Any, context: dict[str, Any],
                               settings: Any) -> None:
    """Bind the provided plan setup to AI1's exact canonical request data."""
    from .native_pdf_artifacts import _request_settings

    try:
        request_hash = _canonical_hash(request_data)
    except Exception as exc:
        raise _Invalid("PDF_REQUEST_HASH_UNVERIFIED") from exc
    _check(request_hash == context["request_hash"], "PDF_REQUEST_HASH_UNVERIFIED")
    expected_settings = _request_settings(request_data)
    _check(expected_settings is not None and type(settings) is tuple and len(settings) == 1
           and type(settings[0]) is dict
           and _canonical_hash(settings[0]) == _canonical_hash(expected_settings),
           "PDF_REQUEST_SETTINGS_MISMATCH")


def _verify_native_pdf_input_manifest(*, manifest: dict[str, Any], context: dict[str, Any],
                                      source_bytes: bytes,
                                      input_manifest_bytes: bytes | None) -> None:
    """Check the AI1 PDF source anchor and its exact private manifest bytes.

    This validation-only anchor is committed transitively by the AI3 preview
    manifest SHA in ai0.print_evidence.v1; the Core evidence schema is unchanged.
    """
    _check(type(input_manifest_bytes) is bytes and 2 <= len(input_manifest_bytes) <= 256 * 1024,
           "PDF_INPUT_MANIFEST_UNVERIFIED")
    source = manifest.get("source")
    input_anchor = manifest.get("input_manifest")
    _check(type(source) is dict and set(source) == {"format", "artifact_ref", "sha256", "size_bytes"}
           and source.get("format") == "PDF" and type(source.get("artifact_ref")) is str
           and _safe_pdf_input_ref(source["artifact_ref"])
           and type(source.get("sha256")) is str and HEX.fullmatch(source["sha256"]) is not None
           and type(source.get("size_bytes")) is int and source["size_bytes"] == len(source_bytes)
           and source["sha256"] == _sha(source_bytes)
           and source["artifact_ref"].lower().endswith(".pdf"),
           "PDF_SOURCE_ANCHOR_UNVERIFIED")
    _check(type(input_anchor) is dict and set(input_anchor) == {"ref", "sha256"}
           and type(input_anchor.get("ref")) is str
           and _safe_pdf_input_ref(input_anchor["ref"])
           and input_anchor["ref"].endswith("/manifest.json")
           and type(input_anchor.get("sha256")) is str
           and HEX.fullmatch(input_anchor["sha256"]) is not None
           and input_anchor["ref"].split("/", 1)[0] == source["artifact_ref"].split("/", 1)[0]
           and _sha(input_manifest_bytes) == input_anchor["sha256"],
           "PDF_INPUT_MANIFEST_ANCHOR_UNVERIFIED")
    try:
        source_manifest = json.loads(input_manifest_bytes.decode("utf-8"),
            object_pairs_hook=_json_unique, parse_constant=_no_nonfinite_json)
    except Exception as exc:
        if isinstance(exc, _Invalid):
            raise
        raise _Invalid("PDF_INPUT_MANIFEST_UNVERIFIED") from exc
    _check(type(source_manifest) is dict and set(source_manifest) == {
        "schema", "manifest_ref", "shop_id", "order_id", "active_revision", "request_hash", "source"
    }, "PDF_INPUT_MANIFEST_UNVERIFIED")
    input_source = source_manifest.get("source")
    _check(type(input_source) is dict and set(input_source) == {
        "format", "artifact_ref", "sha256", "size_bytes"
    }, "PDF_INPUT_MANIFEST_UNVERIFIED")
    _check(type(source_manifest.get("shop_id")) is str and bool(source_manifest["shop_id"])
           and type(source_manifest.get("order_id")) is str and bool(source_manifest["order_id"])
           and type(source_manifest.get("active_revision")) is int
           and source_manifest["active_revision"] > 0
           and type(source_manifest.get("request_hash")) is str
           and HEX.fullmatch(source_manifest["request_hash"]) is not None
           and type(source_manifest.get("manifest_ref")) is str
           and type(input_source.get("format")) is str
           and type(input_source.get("artifact_ref")) is str
           and type(input_source.get("sha256")) is str
           and HEX.fullmatch(input_source["sha256"]) is not None
           and type(input_source.get("size_bytes")) is int
           and input_source["size_bytes"] > 0,
           "PDF_INPUT_MANIFEST_UNVERIFIED")
    _check(source_manifest.get("schema") == "ai0.pdf_review_manifest.v1"
           and source_manifest.get("manifest_ref") == input_anchor["ref"]
           and source_manifest.get("shop_id") == context["shop_id"]
           and source_manifest.get("order_id") == context["order_id"]
           and source_manifest.get("active_revision") == context["revision"]
           and source_manifest.get("request_hash") == context["request_hash"]
           and input_source == source,
           "PDF_INPUT_MANIFEST_SCOPE_MISMATCH")


def create_print_evidence_v1(*, context: dict[str, Any],
                             manifest_bytes: bytes,
                             originals: tuple[bytes, ...],
                             previews: tuple[bytes, ...],
                             settings: tuple[dict[str, Any], ...],
                             trusted_core_plan: dict[str, Any] | None = None,
                             renderer_identity: dict[str, Any],
                             printer_capabilities: dict[str, Any],
                             input_manifest_bytes: bytes | None = None,
                             request_data: Any = None) -> dict[str, Any]:
    """Create a verified content tuple, but NOT a trustworthy Core approval.

    All values must be independently obtained by AI0. A matching stored
    evidence SHA from the Core transaction is still required by verify().
    """
    try:
        _check(isinstance(context, dict), "SCOPE_UNVERIFIED")
        for key in ("shop_id", "order_id", "request_hash", "manifest_ref", "printer_id"):
            _check(type(context.get(key)) is str and bool(context[key]), "SCOPE_UNVERIFIED")
        _check(type(context.get("revision")) is int and context["revision"] > 0,
               "REVISION_UNVERIFIED")
        _check(HEX.fullmatch(context["request_hash"]) is not None and
               BUNDLE.fullmatch(context["manifest_ref"]) is not None and
               context["printer_id"] == "RMP7000", "SCOPE_UNVERIFIED")
        _check(type(manifest_bytes) is bytes and 0 < len(manifest_bytes) <= 256*1024,
               "MANIFEST_UNVERIFIED")
        manifest = json.loads(manifest_bytes, object_pairs_hook=_json_unique,
                              parse_constant=lambda _: (_ for _ in ()).throw(_Invalid("MANIFEST_UNVERIFIED")))
        _check(type(manifest) is dict and
               manifest.get("schema") in ("ai3.document_bridge.v1", "ai3.native_word_preview.v1",
                                           "ai3.native_pdf_preview.v1") and
               manifest.get("request_hash") == context["request_hash"], "MANIFEST_UNVERIFIED")
        native_word = manifest["schema"] == "ai3.native_word_preview.v1"
        native_pdf = manifest["schema"] == "ai3.native_pdf_preview.v1"
        if native_word:
            _check(manifest.get("revision") == context["revision"] and
                   manifest.get("ready") is False and
                   manifest.get("requires_staff_review") is True,
                   "WORD_REVIEW_PENDING")
        if native_pdf:
            import fitz

            _check(type(manifest.get("active_revision")) is int and
                   manifest.get("status") == "REVIEW_REQUIRED" and
                   manifest.get("active_revision") == context["revision"] and
                   manifest.get("ready") is False and manifest.get("allowed_to_print") is False and
                   manifest.get("requires_staff_review") is True and
                   manifest.get("physical_print_verified") is False and
                   manifest.get("evidence_kind") == "pymupdf_pdf_preview_only" and
                   type(manifest.get("source")) is dict and manifest["source"].get("format") == "PDF",
                   "PDF_REVIEW_PENDING")
            _check(manifest.get("renderer_versions") == {"pymupdf": fitz.VersionBind},
                   "PDF_RENDERER_CHANGED")
            _check(len(manifest.get("files", [])) == 1,
                   "PDF_SINGLE_SOURCE_REQUIRED")
            _verify_native_pdf_request(request_data=request_data, context=context,
                                       settings=settings)
            _verify_native_pdf_input_manifest(manifest=manifest, context=context,
                                              source_bytes=originals[0] if type(originals) is tuple and originals else b"",
                                              input_manifest_bytes=input_manifest_bytes)
        _check(type(originals) is tuple and 1 <= len(originals) <= processor.MAX_DOCS and
               type(previews) is tuple and 1 <= len(previews) <= 3*len(originals) and
               type(settings) is tuple and len(settings) == len(originals) and
               type(renderer_identity) is dict and bool(renderer_identity) and
               type(printer_capabilities) is dict and bool(printer_capabilities),
               "EVIDENCE_SHAPE_UNVERIFIED")
        _check(printer_capabilities.get("printer_id") == "RMP7000" and
               printer_capabilities.get("queue_name") == "RMP7000",
               "PRINTER_CAPABILITY_UNVERIFIED")
        files, images = manifest.get("files"), manifest.get("previews")
        _check(type(files) is list and len(files) == len(originals) and
               type(images) is list and len(images) == len(previews),
               "MANIFEST_MAPPING_UNVERIFIED")
        base_dir = context["manifest_ref"].split("/")[0] + "/"
        sources: list[dict[str, Any]] = []
        candidates: list[dict[str, Any]] = []
        for i, (entry, raw, setup) in enumerate(zip(files, originals, settings)):
            _check(type(entry) is dict and type(raw) is bytes and
                   0 < len(raw) <= processor.MAX_FILE and type(setup) is dict,
                   "SOURCE_UNVERIFIED")
            ref = entry.get("source_artifact_ref")
            _check(type(ref) is str and SOURCE.fullmatch(ref) is not None and
                   ref.startswith(base_dir) and ref.split("/")[-1].startswith(f"source-{i:03d}-"),
                   "SOURCE_REF_UNVERIFIED")
            extension = SOURCE.fullmatch(ref).group(1)
            digest = _sha(raw)
            _check(entry.get("file_sha256") == digest and
                   entry.get("size_bytes") == len(raw) and
                   entry.get("settings_sha256") == _canonical_hash(setup) and
                   ref.rsplit("-", 1)[-1].split(".")[0] == digest,
                   "SOURCE_OR_SETTINGS_CHANGED")
            if extension == "pdf":
                _check(raw.startswith(b"%PDF-") and
                       type(entry.get("render_method")) is str and
                       entry["render_method"].startswith("pymupdf-") and
                       manifest["schema"] in ("ai3.document_bridge.v1", "ai3.native_pdf_preview.v1"),
                       "PDF_NATIVE_UNVERIFIED")
                if native_pdf:
                    from .bridge import _pdf_font_reliable
                    _check(_pdf_font_reliable(raw), "PDF_FONT_OR_ENCRYPTION_UNVERIFIED")
            else:
                _check(raw.startswith(b"PK") and zipfile.is_zipfile(io.BytesIO(raw)) and
                       manifest["schema"] == "ai3.native_word_preview.v1" and
                       entry.get("render_method") == "word_com_native_preview_only",
                       "WORD_NATIVE_UNVERIFIED")
                with zipfile.ZipFile(io.BytesIO(raw)) as archive:
                    _check("word/document.xml" in archive.namelist(),
                           "WORD_NATIVE_UNVERIFIED")
            sources.append({"source_artifact_ref": ref, "format": extension.upper(),
                            "size_bytes": len(raw), "source_sha256": digest})
            candidates.append({"status": "READY", "file_sha256": digest,
                               "document_pages": entry.get("document_pages"), **setup})
        _check(all(s["format"] == sources[0]["format"] for s in sources),
               "MIXED_FORMAT_REQUIRES_REVIEW")
        is_word = sources[0]["format"] == "DOCX"
        if is_word:
            _check(renderer_identity == manifest.get("renderer_identity") and
                   renderer_identity.get("engine") == "microsoft_word_com" and
                   type(renderer_identity.get("version")) is str and
                   bool(renderer_identity["version"]),
                   "WORD_RENDERER_UNVERIFIED")
        else:
            _check(renderer_identity == manifest.get("renderer_versions"),
                   "PDF_RENDERER_CHANGED")
        counted = processor.plan(candidates)
        _check(manifest.get("paper_plan") == counted["files"] and
               type(manifest.get("counts")) is dict and
               all(manifest["counts"].get(k) == counted[k] for k in
                   ("document_pages", "printed_faces", "physical_sheets",
                    "requires_price_confirmation")), "PRINT_PLAN_CHANGED")
        plan_sha256 = _check_core_plan(
            trusted_core_plan, context=context,
            manifest_ref=context["manifest_ref"], counted=counted)
        preview_data: list[dict[str, Any]] = []
        for index, (entry, png) in enumerate(zip(images, previews)):
            _check(type(entry) is dict and type(png) is bytes and
                   8 <= len(png) <= 10*1024*1024 and
                   png.startswith(b"\x89PNG\r\n\x1a\n"), "PREVIEW_UNVERIFIED")
            ref = entry.get("ref")
            _check(type(ref) is str and PNG.fullmatch(ref) is not None and
                   ref.startswith(base_dir) and entry.get("bytes") == len(png) and
                   entry.get("sha256") == _sha(png), "PREVIEW_CHANGED")
            preview_data.append({"index": index, "bytes": len(png), "sha256": _sha(png)})
        evidence = {
            "schema": SCHEMA,
            "shop_id": context["shop_id"], "order_id": context["order_id"],
            "revision": context["revision"], "request_hash": context["request_hash"],
            "sources": sources, "source_set_sha256": _canonical_hash(sources),
            "settings_sha256": _canonical_hash(list(settings)),
            "manifest_ref": context["manifest_ref"], "manifest_sha256": _sha(manifest_bytes),
            "previews": preview_data, "renderer_sha256": _canonical_hash(renderer_identity),
            "plan_sha256": plan_sha256, "printer_id": "RMP7000",
            "printer_capability_sha256": _canonical_hash(printer_capabilities),
        }
        evidence["evidence_sha256"] = _canonical_hash(evidence)
        return {"schema": SCHEMA, "status": "SNAPSHOT_DERIVED",
                "reason_code": "SERVER_ATTESTATION_REQUIRED",
                "snapshot": evidence, "source_format": sources[0]["format"],
                "document_pages": counted["document_pages"],
                "physical_sheets": counted["physical_sheets"],
                "allowed_to_print": False, "allowed_to_simulate": False,
                "physical_print_verified": False}
    except _Invalid as exc:
        return _hold(str(exc))
    except Exception:
        return _hold("PRINT_EVIDENCE_UNVERIFIED")


def verify_print_evidence_v1(*, expected: dict[str, Any],
                             trusted_evidence_sha256: str, active_revision: int,
                             context: dict[str, Any], manifest_bytes: bytes,
                             originals: tuple[bytes, ...],
                             previews: tuple[bytes, ...],
                             settings: tuple[dict[str, Any], ...],
                             trusted_core_plan: dict[str, Any] | None = None,
                             renderer_identity: dict[str, Any],
                             printer_capabilities: dict[str, Any],
                             input_manifest_bytes: bytes | None = None,
                             request_data: Any = None) -> dict[str, Any]:
    """Compare all raw bytes to the independently persisted Core SHA anchor."""
    if (type(expected) is not dict or type(context) is not dict or
            type(trusted_evidence_sha256) is not str or
            HEX.fullmatch(trusted_evidence_sha256) is None or
            type(active_revision) is not int or
            type(context.get("revision")) is not int or
            context["revision"] != active_revision):
        return _hold("CORE_EVIDENCE_OR_REVISION_UNVERIFIED")
    result = create_print_evidence_v1(
        context=context, manifest_bytes=manifest_bytes, originals=originals,
        previews=previews, settings=settings, trusted_core_plan=trusted_core_plan,
        renderer_identity=renderer_identity, printer_capabilities=printer_capabilities,
        input_manifest_bytes=input_manifest_bytes, request_data=request_data)
    if result["status"] != "SNAPSHOT_DERIVED":
        return result
    observed = result["snapshot"]
    if (expected != observed or expected.get("evidence_sha256") != trusted_evidence_sha256 or
            _canonical_hash({k:v for k,v in expected.items() if k != "evidence_sha256"}) != trusted_evidence_sha256):
        return _hold("STALE_OR_MUTATED_PRINT_EVIDENCE")
    return {"schema": SCHEMA, "status": "EVIDENCE_VERIFIED",
            "reason_code": "NONE", "evidence_sha256": trusted_evidence_sha256,
            "source_format": result["source_format"],
            "physical_sheets": result["physical_sheets"],
            "allowed_to_print": False, "allowed_to_simulate": False,
            "physical_print_verified": False}
