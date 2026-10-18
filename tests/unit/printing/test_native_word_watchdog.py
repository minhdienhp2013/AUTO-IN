"""Cross-platform fake-child tests for the preview-only Word watchdog."""
from __future__ import annotations

import base64
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import zipfile

from agents.windows.native_word_watchdog import preview_word_native_isolated


def _docx() -> bytes:
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as archive:
        archive.writestr("[Content_Types].xml", "<Types/>")
        archive.writestr("word/document.xml", "<document/>")
    return out.getvalue()


def _valid_result(expected: str) -> dict:
    # A valid PNG header is sufficient at this serialization boundary; image
    # decoding/layout verification belongs to the renderer test suite.
    preview = b"\x89PNG\r\n\x1a\nwatchdog-test"
    return {
        "schema": "ai3.word_native_preview.v1",
        "status": "REVIEW_REQUIRED",
        "reason_code": "WORD_FONT_AND_LAYOUT_STAFF_REVIEW_REQUIRED",
        "evidence_kind": "windows_word_com_preview_only",
        "native_word_verified": True,
        "physical_print_verified": False,
        "allowed_to_print": False,
        "source_format": "DOCX",
        "print_source_format": "DOCX",
        "source_sha256": expected,
        "renderer_identity": {"engine": "microsoft_word_com", "version": "test"},
        "document_pages": 1,
        "preview_png": [base64.b64encode(preview).decode("ascii")],
        "preview_sha256": [hashlib.sha256(preview).hexdigest()],
        "page_sizes": ["A4"],
        "warning_codes": ["PREVIEW_NOT_RICOH_PAPER_EVIDENCE"],
    }


def _run(source: bytes, script: str, *, timeout=3):
    digest = hashlib.sha256(source).hexdigest()
    return preview_word_native_isolated(
        source, expected_sha256=digest, allow_word_launch=True,
        timeout_seconds=timeout, worker_command=(sys.executable, "-c", script))


def test_isolated_word_worker_success_returns_review_only_preview():
    source = _docx()
    digest = hashlib.sha256(source).hexdigest()
    payload = json.dumps(_valid_result(digest))
    script = (
        "import pathlib,sys; args=sys.argv[1:]; "
        "pathlib.Path(args[args.index('--response')+1]).write_text(" +
        repr(payload) + ",encoding='utf-8')"
    )
    result = _run(source, script)
    assert result["status"] == "REVIEW_REQUIRED"
    assert result["allowed_to_print"] is False
    assert result["physical_print_verified"] is False
    assert result["print_source_format"] == "DOCX"
    assert result["preview_png"][0].startswith(b"\x89PNG\r\n\x1a\n")


def test_timeout_kills_worker_and_descendant_process_tree(tmp_path):
    source = _docx()
    pid_file = tmp_path / "descendant.pid"
    script = f"""
import pathlib,subprocess,sys,time
args=sys.argv[1:]
child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)'])
pathlib.Path({str(pid_file)!r}).write_text(str(child.pid))
time.sleep(60)
"""
    result = _run(source, script, timeout=1)
    assert (result["status"], result["reason_code"]) == ("NEEDS_HUMAN", "PROCESSING_TIMEOUT")
    assert result["allowed_to_print"] is False
    pid = int(pid_file.read_text())
    deadline = time.monotonic() + 4
    while time.monotonic() < deadline:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            break
        # A killed process can briefly remain a zombie until the OS reaps it.
        time.sleep(0.05)
    else:
        raise AssertionError("watchdog left its child process running")


def test_malformed_worker_response_is_held():
    result = _run(_docx(), (
        "import pathlib,sys; args=sys.argv[1:]; "
        "pathlib.Path(args[args.index('--response')+1]).write_text('{broken')"))
    assert (result["status"], result["reason_code"]) == (
        "NEEDS_HUMAN", "WORD_WORKER_RESPONSE_INVALID")
    assert result["allowed_to_print"] is False


def test_worker_cannot_turn_preview_into_print_authority():
    source = _docx()
    digest = hashlib.sha256(source).hexdigest()
    result_data = _valid_result(digest)
    result_data["allowed_to_print"] = True
    payload = json.dumps(result_data)
    script = (
        "import pathlib,sys; args=sys.argv[1:]; "
        "pathlib.Path(args[args.index('--response')+1]).write_text(" +
        repr(payload) + ",encoding='utf-8')"
    )
    result = _run(source, script)
    assert (result["status"], result["reason_code"]) == (
        "NEEDS_HUMAN", "WORD_WORKER_RESPONSE_INVALID")
    assert result["allowed_to_print"] is False
    assert result["physical_print_verified"] is False


def test_no_authorization_does_not_launch_worker():
    source = _docx()
    result = preview_word_native_isolated(
        source, expected_sha256=hashlib.sha256(source).hexdigest(),
        worker_command=(sys.executable, "-c", "raise SystemExit(99)"))
    assert (result["status"], result["reason_code"]) == (
        "NEEDS_HUMAN", "WORD_LAUNCH_NOT_AUTHORIZED")
    assert result["allowed_to_print"] is False
