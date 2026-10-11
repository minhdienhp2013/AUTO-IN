"""AI3 CODE-303: server-only document facts Port for AI2 interpretByRules.

The caller MUST resolve artifact_ref/sha256 and manifest_sha256 from its
server-owned DB/manifest index, never from webhook text or a customer request.
No physical printing or order approval happens here.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import sys
import tempfile
from typing import Any

from . import bridge, processor

SCHEMA = "ai3.document_facts.v1"
MAX_BATCH = 20
MAX_INPUT_BYTES = 256 * 1024

# Exactly the immutable private snapshots made by AI3's verified bridge, or
# an AI0 artifact-ingest adapter with the SAME private, hash-bound convention.
# No arbitrary relative/absolute paths are ever accepted.
_REF = re.compile(
    r"doc-[a-zA-Z0-9_-]{6,64}/"
    r"source-[0-9]{3}-([0-9a-f]{64})\."
    r"(pdf|doc|docx|xls|xlsx|csv|png|jpe?g|tiff?|webp|bmp|zip)"
)
_SHA = re.compile(r"[0-9a-f]{64}")
_MANIFEST_LIMIT = 256 * 1024
_MANIFEST_SCHEMAS = frozenset({"ai3.document_bridge.v1", "ai3.upload_snapshot.v1"})
_KINDS = {
    ".pdf": "pdf", ".doc": "word", ".docx": "word",
    ".xls": "excel", ".xlsx": "excel", ".csv": "excel",
    ".png": "image", ".jpg": "image", ".jpeg": "image",
    ".tif": "image", ".tiff": "image", ".webp": "image",
    ".bmp": "image", ".zip": "zip",
}


def _unknown() -> dict[str, Any]:
    return {"kind": "unknown", "preview_trusted": False}


def _kind(name: str) -> str:
    return _KINDS.get(PurePosixPath(name).suffix.lower(), "unknown")


def _render_trusted(name: str, data: bytes) -> bool:
    """Actually decode and produce preview(s); never infer trust by extension."""
    kind = _kind(name)
    if kind not in ("pdf", "image"):
        return False
    if kind == "pdf" and not bridge._pdf_font_reliable(data):
        return False
    try:
        with tempfile.TemporaryDirectory(prefix="autoin-fact-") as folder:
            directory = Path(folder)
            result = processor._inspect_data(name, data, directory, "verified")
            if result.get("status") != "READY" or not result.get("render_method"):
                return False
            previews = result.get("preview_files")
            if not isinstance(previews, list) or not previews:
                return False
            for name in previews:
                if (not isinstance(name, str) or Path(name).name != name
                        or not (directory / name).is_file()
                        or (directory / name).is_symlink()
                        or (directory / name).stat().st_size == 0):
                    return False
            return True
    except Exception:
        return False


def _fact(name: str, data: bytes) -> dict[str, Any]:
    kind = _kind(name)
    if kind == "unknown":
        return _unknown()
    if kind in ("word", "excel"):
        # Format may be recognized but there is no verified native Windows
        # preview/page count. AI2 must hand off; do not guess pages.
        return {"kind": kind, "preview_trusted": False}
    if kind != "zip":
        return {"kind": kind, "preview_trusted": True} if _render_trusted(name, data) else _unknown()

    files, error = processor._check_archive(data)
    if error or not files or len(files) > processor.MAX_DOCS:
        return _unknown()
    if not all(_render_trusted(member_name, payload) for member_name, payload in files):
        return {"kind": "zip", "count_inside": len(files), "preview_trusted": False}
    return {"kind": "zip", "count_inside": len(files), "preview_trusted": True}


def _verified_source(root: Path, item: dict[str, Any]) -> tuple[str, bytes] | None:
    """Require TWO server-persisted digests: sealed manifest and frozen bytes.

    The manifest digest MUST be read from AI0's authenticated DB metadata,
    not derived from a request. A forged ref/hash pair alone proves nothing.
    Secure dirfd opens reject symlinks at all relative path segments; read the
    verified document bytes only once, then decode from those same bytes.
    """
    if not isinstance(item, dict) or set(item) != {
            "artifact_ref", "sha256", "manifest_ref", "manifest_sha256"}:
        return None
    ref, digest = item["artifact_ref"], item["sha256"]
    manifest_ref, manifest_hash = item["manifest_ref"], item["manifest_sha256"]
    if not all(isinstance(v, str) for v in (ref, digest, manifest_ref, manifest_hash)):
        return None
    matched = _REF.fullmatch(ref)
    if not (matched and _SHA.fullmatch(digest) and matched.group(1) == digest
            and _SHA.fullmatch(manifest_hash)
            and manifest_ref == ref.split("/", 1)[0] + "/manifest.json"):
        return None

    # Authenticate manifest bytes against the independent hash captured and
    # persisted by the server before trusting any source refs in its contents.
    raw_manifest = bridge._read_scoped(root, manifest_ref)
    if len(raw_manifest) > _MANIFEST_LIMIT:
        return None
    if hashlib.sha256(raw_manifest).hexdigest() != manifest_hash:
        return None
    manifest = json.loads(raw_manifest.decode("utf-8"),
                          object_pairs_hook=bridge._no_duplicate_keys,
                          parse_constant=bridge._no_nonfinite_json)
    if not isinstance(manifest, dict) or manifest.get("schema") not in _MANIFEST_SCHEMAS:
        return None
    entries = manifest.get("files")
    if not isinstance(entries, list) or not 1 <= len(entries) <= processor.MAX_DOCS:
        return None
    if manifest["schema"] == "ai3.document_bridge.v1":
        # Bridge manifests commit request/renderer evidence; the caller must
        # authenticate the manifest hash against the correct shop/order.
        if not (_SHA.fullmatch(str(manifest.get("request_hash", "")))
                and _SHA.fullmatch(str(manifest.get("content_settings_sha256", "")))):
            return None
    matching = [entry for entry in entries if isinstance(entry, dict)
                and entry.get("source_artifact_ref") == ref]
    if len(matching) != 1:
        return None
    proof = matching[0]
    if proof.get("file_sha256") != digest or type(proof.get("size_bytes")) is not int:
        return None
    if not 0 < proof["size_bytes"] <= processor.MAX_FILE:
        return None

    content = bridge._read_scoped(root, ref)
    if len(content) != proof["size_bytes"] or hashlib.sha256(content).hexdigest() != digest:
        return None
    return ref, content


def inspect(batch: list[dict[str, Any]], *,
            artifact_root: str | Path) -> list[dict[str, Any]]:
    """Port: inspect(batch) -> DocumentFact[] (AI2 rules.ts exact field names).

    AI0 must take artifact_ref, sha256, manifest_ref and manifest_sha256 from
    the verified per-shop/per-order server record, NEVER from the webhook.
    A missing/unregistered/changed manifest or source yields unknown.
    """
    if not isinstance(batch, list) or not 1 <= len(batch) <= MAX_BATCH:
        return [_unknown()]
    root = Path(artifact_root)
    if not root.is_dir() or root.is_symlink():
        return [_unknown() for _ in batch]
    result = []
    for item in batch:
        try:
            verified = _verified_source(root, item)
            if verified is None:
                result.append(_unknown())
                continue
            ref, data = verified
            result.append(_fact(ref, data))
        except Exception:
            # Intentionally no filename, file text, traceback or raw exceptions.
            result.append(_unknown())
    return result


def process_request(payload: Any, *, artifact_root: str | Path) -> dict[str, Any]:
    if not isinstance(payload, dict) or set(payload) != {"batch"}:
        facts = [_unknown()]
    else:
        facts = inspect(payload["batch"], artifact_root=artifact_root)
    status = ("READY" if facts and all(
        item["kind"] not in ("unknown", "word", "excel")
        and item.get("preview_trusted") is True for item in facts)
        else "NEEDS_HUMAN")
    return {
        "schema": SCHEMA, "status": status,
        "facts": facts,
        **({"reason_code": "DOCUMENT_UNVERIFIED"} if status != "READY" else {}),
    }


def main() -> int:
    import argparse
    import signal
    parser = argparse.ArgumentParser(description="AUTO-IN trusted artifact facts; NO PRINT")
    parser.add_argument("--artifact-root", required=True,
                        help="Server-owned private root; NEVER from webhook body")
    parser.add_argument("--timeout-seconds", type=int, default=45)
    args = parser.parse_args()
    if not 1 <= args.timeout_seconds <= 120:
        parser.error("--timeout-seconds must be 1..120")

    def expired(_signum: int, _frame: Any) -> None:
        raise TimeoutError()

    output: dict[str, Any]
    if not hasattr(signal, "setitimer"):
        output = {"schema": SCHEMA, "status": "NEEDS_HUMAN",
                  "reason_code": "PROCESSOR_TIMEOUT_UNAVAILABLE",
                  "facts": [_unknown()]}
    else:
        old_handler = signal.signal(signal.SIGALRM, expired)
        try:
            signal.setitimer(signal.ITIMER_REAL, args.timeout_seconds)
            try:
                raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
                if len(raw) > MAX_INPUT_BYTES:
                    output = {"schema": SCHEMA, "status": "NEEDS_HUMAN",
                              "reason_code": "INPUT_TOO_LARGE", "facts": [_unknown()]}
                else:
                    request = json.loads(raw.decode("utf-8"),
                                         object_pairs_hook=bridge._no_duplicate_keys,
                                         parse_constant=bridge._no_nonfinite_json)
                    output = process_request(request, artifact_root=args.artifact_root)
            except TimeoutError:
                output = {"schema": SCHEMA, "status": "NEEDS_HUMAN",
                          "reason_code": "PROCESSING_TIMEOUT", "facts": [_unknown()]}
            except Exception:
                output = {"schema": SCHEMA, "status": "NEEDS_HUMAN",
                          "reason_code": "INVALID_OR_UNVERIFIED_BATCH", "facts": [_unknown()]}
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, old_handler)
    print(json.dumps(output, ensure_ascii=False, separators=(",", ":")), flush=True)
    return 0 if output["status"] == "READY" else 2


if __name__ == "__main__":
    raise SystemExit(main())
