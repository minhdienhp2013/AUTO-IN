"""AI0 bounded child entry for AI3's advisory one-page classifier."""
import base64
import json
import os
import sys


def main() -> int:
    if os.name != "posix":
        return 2
    import resource

    memory = 512 * 1024 * 1024
    resource.setrlimit(resource.RLIMIT_AS, (memory, memory))
    resource.setrlimit(resource.RLIMIT_CPU, (8, 8))
    raw = sys.stdin.buffer.read(35 * 1024 * 1024 + 1)
    if len(raw) > 35 * 1024 * 1024:
        return 2
    try:
        request = json.loads(raw)
        if set(request) != {"content_base64", "format_hint", "expected_sha256"}:
            return 2
        data = base64.b64decode(request["content_base64"], validate=True)
        from workers.documents.first_page_classifier import classify_first_page

        result = classify_first_page(
            data, format_hint=request["format_hint"],
            expected_sha256=request["expected_sha256"],
        )
        sys.stdout.write(json.dumps(result, separators=(",", ":")))
        return 0
    except Exception:
        # Never print source, OCR text, file paths, or exception messages.
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
