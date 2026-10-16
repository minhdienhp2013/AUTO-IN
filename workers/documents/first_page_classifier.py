"""TN005-1PAGE: local, first-page-only document *suggestions*, not print approval.

Only accepts bounded, SHA-256 anchored bytes. No filenames, network, persistence,
external AI calls, logging, total-page calculations, or printer interactions.
OCR, when installed, uses local Tesseract with a bounded subprocess deadline;
callers may inject an explicitly trusted *local* OCR reader for tests.
"""
from __future__ import annotations

import hashlib
import io
import re
import subprocess
from time import monotonic
import unicodedata
import zipfile
from collections.abc import Callable
from typing import Any

SCHEMA_VERSION = "tn005.first_page.v1"
MAX_SOURCE_BYTES = 25 * 1024 * 1024
MAX_FIRST_PAGE_PIXELS = 12_000_000
MAX_EXTRACTED_CHARS = 16_000
MAX_OCR_SECONDS = 4.0
IMAGE_FORMATS = {
    "png": "PNG", "jpg": "JPEG", "jpeg": "JPEG", "tif": "TIFF",
    "tiff": "TIFF", "bmp": "BMP", "webp": "WEBP",
}
OCRReader = Callable[[Any], str]


def _out(status: str, *, category: str = "UNKNOWN", confidence: str = "none",
         pages: int = 0, method: str = "not_run", reason: str = "NONE") -> dict[str, Any]:
    return {"schema_version": SCHEMA_VERSION, "status": status,
            "category": category, "confidence_label": confidence,
            "analyzed_page_count": pages, "method": method,
            "reason_code": reason}


def _normalize(content: str) -> list[str]:
    # A defensive, bounded private text buffer; no raw text is ever returned.
    content = unicodedata.normalize("NFD", content[:MAX_EXTRACTED_CHARS]).casefold()
    content = "".join("d" if c == "đ" else c for c in content
                      if unicodedata.category(c) != "Mn")
    return [re.sub(r"\s+", " ", line).strip() for line in content.splitlines()
            if line.strip()][:100]


def _suggest(text: str, method: str) -> dict[str, Any]:
    lines = _normalize(text)
    if not lines:
        return _out("UNKNOWN", pages=1, method=method, reason="NO_READABLE_TEXT")
    # Heading + *independent* document-structure evidence, never a lone keyword.
    # Matching anchored lines prevents a quoted heading buried in body text from
    # being treated as the document's actual title.
    header = "\n".join(lines[:8])
    body = "\n".join(lines[:100])
    patterns = {
        "WORKSHEET": (r"(?:^|\n)(?:phieu hoc tap|bai tap(?: [a-z0-9 ]{1,30})?)(?:\n|$)",
                      [r"\b(?:cau|bai)\s*[1-9]\b", r"\b(?:ho ten|lop|hoc sinh)\b"]),
        "EXAM": (r"(?:^|\n)(?:de (?:thi|kiem tra)(?: [a-z0-9 ]{0,30})?)(?:\n|$)",
                 [r"\bthoi gian\b", r"\b(?:cau|phan)\s*[1-9]\b"]),
        "APPLICATION_FORM": (r"(?:^|\n)(?:(?:don (?:xin|de nghi|dang ky))|to khai)(?: [a-z0-9 ]{0,45})?(?:\n|$)",
                             [r"\bkinh gui\b", r"\bnguoi lam don\b", r"\btoi ten\b"]),
        "CONTRACT_MINUTES": (r"(?:^|\n)(?:hop dong|bien ban)(?: [a-z0-9 ]{0,45})?(?:\n|$)",
                             [r"\bben a\b", r"\bben b\b", r"\bthanh phan\b", r"\bnoi dung cuoc hop\b"]),
        "LESSON_PLAN": (r"(?:^|\n)(?:giao an|ke hoach bai day)(?: [a-z0-9 ]{0,35})?(?:\n|$)",
                        [r"\bmuc tieu\b", r"\bhoat dong\b", r"\bphuong phap\b"]),
        "CV_PROFILE": (r"(?:^|\n)(?:so yeu ly lich|curriculum vitae|ho so xin viec|cv)(?:\n|$)",
                       [r"\bho va ten\b", r"\bkinh nghiem\b", r"\bhoc van\b", r"\bky nang\b"]),
        "ADMINISTRATIVE": (r"(?:^|\n)(?:quyet dinh|thong bao|cong van)(?: [a-z0-9 ]{0,40})?(?:\n|$)",
                           [r"\bcan cu\b", r"\bdieu 1\b", r"\bkinh gui\b", r"\bco quan\b"]),
        "GENERAL_DOCUMENT": (r"(?:^|\n)(?:huong dan su dung|tai lieu huong dan)(?:\n|$)",
                             [r"\bbuoc\s*[1-9]\b", r"\blu(u|y) y\b", r"\bcach thuc hien\b"]),
    }
    candidates = []
    for category, (heading, signals) in patterns.items():
        if re.search(heading, header) and sum(bool(re.search(p, body)) for p in signals) >= 2:
            candidates.append(category)
    if len(candidates) == 1:
        return _out("SUGGESTED", category=candidates[0], confidence="high",
                    pages=1, method=method)
    return _out("UNKNOWN", pages=1, method=method,
                reason="AMBIGUOUS_CONTENT" if len(candidates) > 1
                else "COVER_OR_INSUFFICIENT_EVIDENCE")


class _OCRDeadlineExceeded(Exception):
    """OCR discovery and recognition exceeded a single local time budget."""


def _remaining_ocr_seconds(deadline: float) -> float:
    remaining = deadline - monotonic()
    if remaining <= 0:
        raise _OCRDeadlineExceeded()
    return remaining


def _local_ocr(image: Any) -> str:
    """Discover languages and OCR under ONE 4-second Tesseract time budget.

    pytesseract.get_languages() has no timeout: never call it. Instead run the
    local executable directly with --list-langs and a deadline. The remaining
    time, not a fresh 4 seconds, is passed to image_to_string(). A parent
    worker deadline is still required for in-process Python/image preparation.
    """
    import pytesseract  # optional, local only; does not call a cloud provider

    deadline = monotonic() + MAX_OCR_SECONDS
    try:
        discovery = subprocess.run(
            [pytesseract.pytesseract.tesseract_cmd, "--list-langs"],
            capture_output=True, check=False,
            timeout=_remaining_ocr_seconds(deadline),
        )
    except FileNotFoundError as exc:
        raise ImportError("Local OCR executable missing") from exc
    except subprocess.TimeoutExpired as exc:
        raise _OCRDeadlineExceeded() from exc
    if discovery.returncode != 0:
        raise ImportError("OCR language discovery unavailable")
    # Tesseract versions may list languages on stdout or stderr. No command
    # output (which can include local installation paths) is ever surfaced.
    language_lines = (discovery.stdout + b"\n" + discovery.stderr).decode(
        "utf-8", errors="replace").splitlines()
    languages = {line.strip() for line in language_lines}
    available = [lang for lang in ("vie", "eng") if lang in languages]
    if not available:
        raise ImportError("No supported local OCR language pack")

    try:
        result = pytesseract.image_to_string(
            image, lang="+".join(available),
            config="--psm 6", timeout=_remaining_ocr_seconds(deadline),
        )
    except (subprocess.TimeoutExpired, RuntimeError) as exc:
        # pytesseract raises RuntimeError for its subprocess timeout; returning
        # UNKNOWN is safer than forwarding provider/executable exception text.
        raise _OCRDeadlineExceeded() from exc
    _remaining_ocr_seconds(deadline)
    return result

def _ocr_image(image: Any, *, ocr_reader: OCRReader | None,
               allow_local_ocr: bool, method: str) -> dict[str, Any]:
    if image.width * image.height > MAX_FIRST_PAGE_PIXELS:
        return _out("NEEDS_HUMAN", pages=0, reason="FIRST_PAGE_TOO_LARGE")
    engine = ocr_reader if ocr_reader is not None else (_local_ocr if allow_local_ocr else None)
    if engine is None:
        return _out("UNKNOWN", pages=1, method=method,
                    reason="OCR_UNAVAILABLE")
    try:
        raw = engine(image)
        if not isinstance(raw, str):
            return _out("UNKNOWN", pages=1, method=method,
                        reason="OCR_UNVERIFIED")
        return _suggest(raw, method)
    except ImportError:
        return _out("UNKNOWN", pages=1, method=method, reason="OCR_UNAVAILABLE")
    except _OCRDeadlineExceeded:
        return _out("UNKNOWN", pages=1, method=method, reason="OCR_TIMEOUT")
    except Exception:
        # No exception text, filename or any OCR bytes may escape.
        return _out("UNKNOWN", pages=1, method=method, reason="OCR_FAILED")


def classify_first_page(data: bytes, *, format_hint: str, expected_sha256: str,
                        ocr_reader: OCRReader | None = None,
                        allow_local_ocr: bool = True) -> dict[str, Any]:
    """Inspect *only* PDF page 0 / image-TIFF frame 0, as an advisory hint.

    The caller must supply expected_sha256 from a trusted sealed source row,
    not request/client metadata. No attempt is made to validate print readiness.
    """
    if not isinstance(data, bytes) or not 0 < len(data) <= MAX_SOURCE_BYTES:
        return _out("NEEDS_HUMAN", reason="INVALID_FILE_SIZE")
    if (not isinstance(expected_sha256, str) or
            re.fullmatch(r"[0-9a-f]{64}", expected_sha256) is None or
            hashlib.sha256(data).hexdigest() != expected_sha256):
        return _out("NEEDS_HUMAN", reason="SOURCE_HASH_MISMATCH")
    if not isinstance(format_hint, str):
        return _out("NEEDS_HUMAN", reason="UNSUPPORTED_FORMAT")
    fmt = format_hint.lower().lstrip(".")
    if fmt == "docx":
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                # Inspect only the directory listing, not document.xml text;
                # Word-native pagination remains unknown and unattempted.
                if "word/document.xml" not in archive.namelist():
                    return _out("NEEDS_HUMAN", reason="DOCUMENT_CORRUPT")
        except (zipfile.BadZipFile, ValueError, OSError):
            return _out("NEEDS_HUMAN", reason="DOCUMENT_CORRUPT")
        return _out("UNKNOWN", reason="WORD_NATIVE_FIRST_PAGE_UNVERIFIED")
    if fmt == "pdf":
        if not data.lstrip().startswith(b"%PDF-"):
            return _out("NEEDS_HUMAN", reason="EXTENSION_CONTENT_MISMATCH")
        try:
            import fitz
            from PIL import Image
            with fitz.open(stream=data, filetype="pdf") as doc:
                if doc.needs_pass or doc.is_encrypted:
                    return _out("NEEDS_HUMAN", reason="PASSWORD_PROTECTED")
                if len(doc) == 0:
                    return _out("NEEDS_HUMAN", reason="INVALID_PAGE_COUNT")
                page = doc.load_page(0)  # Never load/read page index >0.
                text = page.get_text("text")
                if text.strip():
                    return _suggest(text, "pymupdf_page0_text")
                # Only raster PDFs lacking extractable text need OCR.
                if not page.get_images(full=True):
                    return _out("UNKNOWN", pages=1, method="pymupdf_page0_text",
                                reason="NO_READABLE_TEXT")
                width, height = page.rect.width, page.rect.height
                if width <= 0 or height <= 0:
                    return _out("NEEDS_HUMAN", reason="INVALID_PAGE_SIZE")
                scale = min(1.25, 1600 / max(width, height))
                if width * height * scale * scale > MAX_FIRST_PAGE_PIXELS:
                    return _out("NEEDS_HUMAN", reason="FIRST_PAGE_TOO_LARGE")
                image = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
                return _ocr_image(Image.frombytes("RGB", (image.width, image.height),
                                                 image.samples),
                                  ocr_reader=ocr_reader,
                                  allow_local_ocr=allow_local_ocr,
                                  method="pymupdf_page0_local_ocr")
        except Exception:
            return _out("NEEDS_HUMAN", reason="PDF_UNREADABLE")
    if fmt in IMAGE_FORMATS:
        try:
            from PIL import Image, ImageOps
            with Image.open(io.BytesIO(data)) as image:
                if image.format != IMAGE_FORMATS[fmt]:
                    return _out("NEEDS_HUMAN", reason="EXTENSION_CONTENT_MISMATCH")
                # Image.open() reads only the header. Reject oversized first
                # frames BEFORE seek/decode/exif_transpose/convert allocations.
                width, height = image.size
                if (width <= 0 or height <= 0 or
                        width > MAX_FIRST_PAGE_PIXELS // height):
                    return _out("NEEDS_HUMAN", reason="FIRST_PAGE_TOO_LARGE")
                image.seek(0)  # TIFF/animated images: only first frame.
                width, height = image.size
                if (width <= 0 or height <= 0 or
                        width > MAX_FIRST_PAGE_PIXELS // height):
                    return _out("NEEDS_HUMAN", reason="FIRST_PAGE_TOO_LARGE")
                # Do not mutate process-wide Pillow decompression-bomb limits.
                frame = ImageOps.exif_transpose(image).convert("RGB")
                return _ocr_image(frame, ocr_reader=ocr_reader,
                                  allow_local_ocr=allow_local_ocr,
                                  method="pillow_frame0_local_ocr")
        except Exception:
            return _out("NEEDS_HUMAN", reason="IMAGE_UNREADABLE")
    return _out("NEEDS_HUMAN", reason="UNSUPPORTED_FORMAT")
