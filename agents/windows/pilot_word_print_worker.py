"""Private, killable child process for original-DOCX Word inspection/printing.

Only the parent pilot agent creates these requests after Core ticket, source
hash, printer and settings checks. The worker prints the original DOCX; it has
no PDF conversion path and never reports paper completion.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re

SHA256 = re.compile(r"^[a-f0-9]{64}$")
MAX_RESPONSE_BYTES = 4096


def execute_word_job(*, source_path: Path, expected_sha256: str, mode: str,
                     printer_name: str | None = None, copies: int = 1,
                     expected_page_count: int | None = None) -> dict:
    """Run one isolated Word open/count or PrintOut; injectable COM in tests."""
    if (mode not in ("inspect", "print") or not source_path.is_absolute() or
            str(source_path).startswith("\\\\") or source_path.is_symlink() or
            not source_path.is_file() or not SHA256.fullmatch(expected_sha256) or
            type(copies) is not int or not 1 <= copies <= 99):
        raise ValueError("WORD_REQUEST_INVALID")
    if mode == "print" and (not printer_name or type(expected_page_count) is not int or
                             expected_page_count < 1):
        raise ValueError("WORD_PRINT_REQUEST_INVALID")
    if os.name == "nt":
        from agents.windows.pilot_native_print import _assert_private_windows_acl
        _assert_private_windows_acl(source_path.parent)
        _assert_private_windows_acl(source_path)

    source_bytes = source_path.read_bytes()
    if hashlib.sha256(source_bytes).hexdigest() != expected_sha256:
        raise ValueError("SOURCE_HASH_MISMATCH")
    from agents.windows.native_word_document import _validate_docx
    if not _validate_docx(source_bytes):
        raise ValueError("DOCX_UNREADABLE")

    import pythoncom
    from win32com.client import DispatchEx
    initialized = False
    app = None
    document = None
    try:
        pythoncom.CoInitialize()
        initialized = True
        app = DispatchEx("Word.Application")
        app.Visible = False
        app.DisplayAlerts = 0
        app.AutomationSecurity = 3
        app.Options.UpdateLinksAtOpen = False
        document = app.Documents.Open(
            FileName=str(source_path), ConfirmConversions=False,
            ReadOnly=True, AddToRecentFiles=False, Visible=False,
            OpenAndRepair=False, NoEncodingDialog=True, UpdateLinks=0)
        sections = list(document.Sections)
        if not sections:
            raise ValueError("WORD_SECTIONS_UNAVAILABLE")
        # Apply the contract's A4 setting in memory before measuring. Preserve
        # each source section's orientation; never save or convert the DOCX.
        for section in sections:
            section.PageSetup.PaperSize = 9  # wdPaperA4
        document.Repaginate()
        page_count = int(document.ComputeStatistics(2))
        if not 1 <= page_count <= 10000:
            raise ValueError("WORD_PAGE_COUNT_INVALID")
        result = {"source_sha256": expected_sha256, "page_count": page_count}
        if mode == "print":
            # Recheck layout immediately before PrintOut. A font/Word change
            # since preflight stops before the native side effect.
            if page_count != expected_page_count:
                raise ValueError("WORD_LAYOUT_CHANGED_BEFORE_SEND")
            app.ActivePrinter = printer_name
            document.PrintOut(
                Background=False, Copies=copies, Collate=True,
                PrintToFile=False, ManualDuplexPrint=False)
            result["status"] = "SUBMITTED"
        else:
            result["status"] = "INSPECTED"
        return result
    finally:
        try:
            if document is not None:
                document.Close(SaveChanges=0)
        finally:
            try:
                if app is not None:
                    app.Quit(SaveChanges=0)
            finally:
                if initialized:
                    pythoncom.CoUninitialize()


def _write_result(path: Path, result: dict) -> None:
    raw = json.dumps(result, sort_keys=True, separators=(",", ":"),
                     allow_nan=False).encode("utf-8")
    if len(raw) > MAX_RESPONSE_BYTES:
        raise ValueError("WORD_RESPONSE_TOO_LARGE")
    with path.open("xb") as output:
        output.write(raw)
        output.flush()
        os.fsync(output.fileno())


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--source", required=True)
    parser.add_argument("--response", required=True)
    parser.add_argument("--expected-sha256", required=True)
    parser.add_argument("--mode", choices=("inspect", "print"), required=True)
    parser.add_argument("--printer")
    parser.add_argument("--copies", type=int, default=1)
    parser.add_argument("--expected-pages", type=int)
    args = parser.parse_args(argv)
    try:
        source_path = Path(args.source)
        response_path = Path(args.response)
        if (os.name != "nt" or not source_path.is_absolute() or
                not response_path.is_absolute() or source_path.parent != response_path.parent or
                response_path.exists() or response_path.is_symlink()):
            return 2
        # The child is only for the service's private byte snapshot. Do not
        # expose an unauthenticated command that can print arbitrary user files.
        from agents.windows.pilot_native_print import _assert_private_windows_acl
        _assert_private_windows_acl(source_path.parent)
        _assert_private_windows_acl(source_path)
        result = execute_word_job(
            source_path=source_path, expected_sha256=args.expected_sha256,
            mode=args.mode, printer_name=args.printer, copies=args.copies,
            expected_page_count=args.expected_pages)
        _write_result(response_path, result)
        return 0
    except Exception:
        # Do not disclose Word diagnostics, source paths, or document content.
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
