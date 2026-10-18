"""V1-NATIVE-01: isolated Word-native *preview only*, no printing or fallback.

Real execution is Windows-only and opt-in from a privileged worker after
separate operator approval. It opens a byte-identical DOCX with Microsoft Word,
never the customer's mutable path. Word emits a disposable preview-only PDF,
which is rasterized with PyMuPDF; the DOCX remains the sole intended print
source. Neither this module nor its output can authorize spooler/PrintOut.
"""
from __future__ import annotations

import hashlib
import io
import os
from pathlib import Path
import sys
import tempfile
from typing import Any, Callable
import zipfile

MAX_DOCX_BYTES = 25 * 1024 * 1024
MAX_WORD_PAGES = 500


def _error(code: str) -> dict[str, Any]:
    return {"schema": "ai3.word_native_preview.v1",
            "status": "NEEDS_HUMAN", "reason_code": code,
            "native_word_verified": False, "physical_print_verified": False,
            "source_format": "DOCX", "print_source_format": "DOCX"}


def _validate_docx(data: bytes) -> bool:
    if type(data) is not bytes or not 0 < len(data) <= MAX_DOCX_BYTES:
        return False
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            files = z.infolist()
            if len(files) > 500 or sum(x.file_size for x in files) > 100 * 1024 * 1024:
                return False
            names = {f.filename for f in files}
            if "word/document.xml" not in names or "[Content_Types].xml" not in names:
                return False
            # Word macro/embedded automation and remote relationship references
            # require a staff-only/manual route; do not auto-open.
            if any("vbaProject" in name or name.endswith(".bin") or
                   name.startswith("word/embeddings/") or
                   name.endswith("externalLink.xml") for name in names):
                return False
            for f in files:
                if f.flag_bits & 1 or f.file_size > 50 * 1024 * 1024:
                    return False
        return True
    except (zipfile.BadZipFile, ValueError, OSError):
        return False


class _WordCOM:
    """Live Word session is created only on Windows from an approved worker."""

    def __enter__(self):
        import pythoncom
        from win32com.client import DispatchEx
        pythoncom.CoInitialize()
        self._pythoncom = pythoncom
        self.app = None
        self.doc = None
        try:
            self.app = DispatchEx("Word.Application")
            self.app.Visible = False
            self.app.DisplayAlerts = 0
            self.app.AutomationSecurity = 3  # msoAutomationSecurityForceDisable
            self.app.Options.UpdateLinksAtOpen = False
            return self
        except Exception:
            self.__exit__(None, None, None)
            raise

    def render(self, source: Path, output_pdf: Path) -> int:
        # Native Windows Word opens original DOCX bytes (safe private copy),
        # NEVER the customer's mutable filesystem path, NEVER PrintOut.
        self.doc = self.app.Documents.Open(
            FileName=str(source), ConfirmConversions=False, ReadOnly=True,
            AddToRecentFiles=False, Visible=False, OpenAndRepair=False,
            NoEncodingDialog=True, UpdateLinks=0)
        self.doc.Repaginate()
        pages = int(self.doc.ComputeStatistics(2))  # wdStatisticPages
        if not 1 <= pages <= MAX_WORD_PAGES:
            raise ValueError("unreliable Word page count")
        # Export is ONLY a temporary native-Word preview representation.
        # The DOCX remains the print source; this PDF is never queued.
        self.doc.ExportAsFixedFormat(
            OutputFileName=str(output_pdf), ExportFormat=17, OpenAfterExport=False,
            OptimizeFor=0, Range=0, Item=0, IncludeDocProps=False,
            KeepIRM=True, CreateBookmarks=0, DocStructureTags=True,
            BitmapMissingFonts=True, UseISO19005_1=False)
        return pages

    def __exit__(self, *_args):
        try:
            if getattr(self, "doc", None) is not None:
                self.doc.Close(SaveChanges=0)
        finally:
            try:
                if getattr(self, "app", None) is not None:
                    self.app.Quit(SaveChanges=0)
            finally:
                self._pythoncom.CoUninitialize()


def _preview_word_native_in_process(source_bytes: bytes, *, expected_sha256: str,
                                    allow_word_launch: bool = False,
                                    session_factory: Callable[[], Any] | None = None) -> dict[str, Any]:
    """Return preview bytes for staff review; print authorization is always false.

    Fake injected session is clearly labeled, never counted as live Windows.
    This private implementation runs inside a watchdog child for real Word;
    COM calls may hang and must never execute in the product worker process.
    """
    if type(expected_sha256) is not str or hashlib.sha256(source_bytes if type(source_bytes) is bytes else b"").hexdigest() != expected_sha256:
        return _error("SOURCE_HASH_MISMATCH")
    if not _validate_docx(source_bytes):
        return _error("DOCX_UNSAFE_OR_CORRUPT")
    if not allow_word_launch:
        return _error("WORD_LAUNCH_NOT_AUTHORIZED")
    fake = session_factory is not None
    if not fake and sys.platform != "win32":
        return _error("WORD_WINDOWS_NOT_AVAILABLE")
    try:
        from workers.documents.processor import _render_pdf, MAX_PAGES
        with tempfile.TemporaryDirectory(prefix="autoin-native-word-preview-") as scratch:
            folder = Path(scratch)
            docx = folder / "source.docx"
            with docx.open("xb") as writer:
                writer.write(source_bytes)
                writer.flush()
                os.fsync(writer.fileno())
            pdf = folder / "word-preview-only.pdf"
            with (session_factory() if fake else _WordCOM()) as session:
                native_pages = session.render(docx, pdf)
                # Version is observed from the actual Word session, never from
                # registry presence. A fake session cannot claim live identity.
                identity = ({"engine": "injected_fake",
                             "version": "not_run"}
                            if fake else
                            {"engine": "microsoft_word_com",
                             "version": str(session.app.Version)})
            if type(native_pages) is not int or not 1 <= native_pages <= min(MAX_WORD_PAGES, MAX_PAGES):
                return _error("WORD_PAGE_COUNT_UNVERIFIED")
            if hashlib.sha256(docx.read_bytes()).hexdigest() != expected_sha256:
                return _error("SOURCE_CHANGED_DURING_RENDER")
            pdf_bytes = pdf.read_bytes()
            result = _render_pdf(pdf_bytes, folder, expected_sha256[:16])
            if result.get("status") != "READY" or result.get("document_pages") != native_pages:
                return _error("WORD_PREVIEW_PAGE_COUNT_MISMATCH")
            previews = tuple((folder / name).read_bytes() for name in result["preview_files"])
            if not 1 <= len(previews) <= 3 or any(not p.startswith(b"\x89PNG\r\n\x1a\n") for p in previews):
                return _error("WORD_PREVIEW_UNVERIFIED")
            return {
                "schema": "ai3.word_native_preview.v1",
                "status": "REVIEW_REQUIRED",
                "reason_code": "WORD_FONT_AND_LAYOUT_STAFF_REVIEW_REQUIRED",
                "evidence_kind": "injected_fake" if fake else "windows_word_com_preview_only",
                "native_word_verified": not fake,
                "physical_print_verified": False,
                "allowed_to_print": False,
                "source_format": "DOCX",
                "print_source_format": "DOCX",
                "source_sha256": expected_sha256,
                "renderer_identity": identity,
                "document_pages": native_pages,
                "preview_png": previews,
                "preview_sha256": tuple(hashlib.sha256(x).hexdigest() for x in previews),
                "page_sizes": result["page_sizes"],
                "warning_codes": ("WORD_FONT_SUBSTITUTION_NOT_EXCLUDED",
                                  "PREVIEW_NOT_RICOH_PAPER_EVIDENCE"),
            }
    except Exception:
        # COM exceptions may contain file paths/customer content: never expose.
        return _error("WORD_NATIVE_RENDER_UNVERIFIED")


def preview_word_native(source_bytes: bytes, *, expected_sha256: str,
                        allow_word_launch: bool = False,
                        session_factory: Callable[[], Any] | None = None) -> dict[str, Any]:
    """Render Word preview in a killable child when using real Windows COM.

    Injected test sessions remain in-process and are explicitly marked fake.
    Real Word execution is delegated to a bounded worker process; this caller
    returns a held result if the worker times out or its response is invalid.
    """
    if session_factory is not None:
        return _preview_word_native_in_process(
            source_bytes, expected_sha256=expected_sha256,
            allow_word_launch=allow_word_launch, session_factory=session_factory)
    from agents.windows.native_word_watchdog import preview_word_native_isolated
    return preview_word_native_isolated(
        source_bytes, expected_sha256=expected_sha256,
        allow_word_launch=allow_word_launch)
