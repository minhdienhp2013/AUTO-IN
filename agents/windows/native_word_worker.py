"""Private child entry point for isolated, preview-only Word COM rendering."""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import sys

MAX_RESPONSE_BYTES = 64 * 1024 * 1024


def _write_response(path: Path, value: dict) -> None:
    raw = json.dumps(value, ensure_ascii=True, separators=(",", ":"),
                     allow_nan=False).encode("utf-8")
    if len(raw) > MAX_RESPONSE_BYTES:
        raise ValueError("response too large")
    with path.open("xb") as output:
        output.write(raw)
        output.flush()
        os.fsync(output.fileno())


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--source", required=True)
    parser.add_argument("--response", required=True)
    parser.add_argument("--expected-sha256", required=True)
    args = parser.parse_args(argv)
    response = Path(args.response)
    try:
        source_path = Path(args.source)
        source = source_path.read_bytes()
        if hashlib.sha256(source).hexdigest() != args.expected_sha256:
            from agents.windows.native_word_document import _error
            _write_response(response, _error("SOURCE_HASH_MISMATCH"))
            return 2
        from agents.windows.native_word_document import _preview_word_native_in_process
        result = _preview_word_native_in_process(
            source, expected_sha256=args.expected_sha256, allow_word_launch=True)
        # Preview image bytes cross the private process boundary as bounded
        # base64. They are preview-only and remain subject to staff review.
        if result.get("status") == "REVIEW_REQUIRED":
            result = dict(result)
            result["preview_png"] = [base64.b64encode(blob).decode("ascii")
                                     for blob in result["preview_png"]]
            result["preview_sha256"] = list(result["preview_sha256"])
            result["warning_codes"] = list(result["warning_codes"])
        _write_response(response, result)
        return 0
    except Exception:
        # Do not reveal paths, document content, COM diagnostics, or traceback.
        try:
            from agents.windows.native_word_document import _error
            _write_response(response, _error("WORD_NATIVE_RENDER_UNVERIFIED"))
        except Exception:
            pass
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
