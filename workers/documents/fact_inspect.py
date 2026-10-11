"""AI3 CODE-303: server-only document facts Port for AI2 interpretByRules.

The caller MUST retrieve artifact_ref + sha256 from its trusted server-side
upload/manifest record, never from webhook text, Zalo filenames or the browser.
No physical printing or order approval happens here.
"""
from __future__ import annotations

import hashlib
import io
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


def inspect(batch: list[dict[str, Any]], *,
            artifact_root: str | Path) -> list[dict[str, Any]]:
    """Port: inspect(batch) -> DocumentFact[] (AI2 rules.ts exact field names).

    Inbound batch must originate from AI0's trusted DB/manifest resolver.
    sha256 must be the immutable snapshot hash already stored by the server.
    A malicious/missing/mutated artifact is always UNKNOWN, never a page guess.
    """
    if not isinstance(batch, list) or not 1 <= len(batch) <= MAX_BATCH:
        return [_unknown()]
    root = Path(artifact_root)
    if not root.is_dir() or root.is_symlink():
        return [_unknown() for _ in batch]
    result = []
    for item in batch:
        try:
            if not isinstance(item, dict) or set(item) != {"artifact_ref", "sha256"}:
                result.append(_unknown())
                continue
            ref, expected = item["artifact_ref"], item["sha256"]
            if not isinstance(ref, str) or not isinstance(expected, str):
                result.append(_unknown())
                continue
            matched = _REF.fullmatch(ref)
            if not matched or not _SHA.fullmatch(expected) or matched.group(1) != expected:
                result.append(_unknown())
                continue
            # Reject "..", URLs, symlinks, and TOCTOU by secure dirfd reads.
            # This reads bytes ONCE and decodes those same verified bytes only.
            data = bridge._read_scoped(root, ref)
            digest = hashlib.sha256(data).hexdigest()
            if digest != expected:
                result.append(_unknown())
                continue
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
