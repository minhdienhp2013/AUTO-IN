"""Real synthetic PDF/image rendering, fake-only OCR and no document/customer data."""
from __future__ import annotations

import hashlib
import io
import json
import sys
from types import ModuleType, SimpleNamespace
from statistics import median
from time import perf_counter
import zipfile

import fitz
from PIL import Image
import pytest

from workers.documents.first_page_classifier import (
    SCHEMA_VERSION, classify_first_page,
)

WORKSHEET = "BAI TAP TOAN\nCAU 1: TINH 1 + 2\nHO TEN: MAU TONG HOP\nLOP: 5A"
CONTRACT = "HOP DONG LAO DONG\nBEN A: DON VI MAU\nBEN B: CA NHAN MAU"
EXAM = "DE KIEM TRA TOAN\nTHOI GIAN: 45 PHUT\nCAU 1: GIAI TOAN"
FORM = "DON XIN NGHI HOC\nKINH GUI: NHA TRUONG\nTOI TEN: HOC SINH MAU"
LESSON = "GIAO AN\nMUC TIEU: REN KY NANG\nHOAT DONG: THUC HANH"
CV = "SO YEU LY LICH\nHO VA TEN: NGUOI MAU\nKINH NGHIEM: 3 NAM"
ADMIN = "QUYET DINH\nCAN CU: VAN BAN HOP LE\nDIEU 1: THI HANH"
GENERAL = "HUONG DAN SU DUNG\nBUOC 1: BAT MAY\nCACH THUC HIEN: LAM THEO MAU"


def pdf(*pages):
    with fitz.open() as doc:
        for data in pages:
            page = doc.new_page()
            page.insert_text((35, 45), data, fontsize=11)
        return doc.tobytes()


def png(color="white"):
    buf = io.BytesIO()
    with Image.new("RGB", (320, 240), color) as img:
        img.save(buf, format="PNG")
    return buf.getvalue()


def scanned_pdf():
    with fitz.open() as doc:
        for color in ("red", "blue"):
            page = doc.new_page()
            page.insert_image(fitz.Rect(10, 10, 300, 200), stream=png(color))
        return doc.tobytes()


def call(data, fmt, **kwargs):
    return classify_first_page(data, format_hint=fmt,
                               expected_sha256=hashlib.sha256(data).hexdigest(),
                               **kwargs)


def assert_clean(output):
    assert set(output) == {"schema_version", "status", "category", "confidence_label",
                           "analyzed_page_count", "method", "reason_code"}
    assert output["schema_version"] == SCHEMA_VERSION
    assert output["analyzed_page_count"] in (0, 1)
    raw = json.dumps(output, ensure_ascii=False)
    for secret in ("MAU TONG HOP", "BEN A", "NGUOI MAU", "KINH GUI", "CAU 1"):
        assert secret not in raw


@pytest.mark.parametrize("first,second,want", [
    (WORKSHEET, CONTRACT, "WORKSHEET"),
    (CONTRACT, WORKSHEET, "CONTRACT_MINUTES"),
])
def test_pdf_page_zero_wins_opposing_page_one(first, second, want, monkeypatch):
    raw = pdf(first, second)
    original = fitz.Document.load_page
    inspected = []

    def guard(doc, pno=0):
        inspected.append(pno)
        assert pno == 0, "Classifier must never load PDF page index > 0"
        return original(doc, pno)

    monkeypatch.setattr(fitz.Document, "load_page", guard)
    outcome = call(raw, "pdf", allow_local_ocr=False)
    assert outcome["status"] == "SUGGESTED" and outcome["category"] == want
    assert outcome["confidence_label"] == "high"
    assert outcome["analyzed_page_count"] == 1
    assert inspected == [0]
    assert_clean(outcome)


@pytest.mark.parametrize("text,kind", [
    (EXAM, "EXAM"), (FORM, "APPLICATION_FORM"),
    (LESSON, "LESSON_PLAN"), (CV, "CV_PROFILE"),
    (ADMIN, "ADMINISTRATIVE"), (GENERAL, "GENERAL_DOCUMENT"),
])
def test_representative_first_page_content_categories(text, kind):
    outcome = call(pdf(text), "pdf", allow_local_ocr=False)
    assert (outcome["status"], outcome["category"]) == ("SUGGESTED", kind)
    assert_clean(outcome)


def test_pdf_cover_heading_alone_is_unknown_and_does_not_consult_page_two():
    out = call(pdf("BAI TAP TOAN", CONTRACT), "pdf", allow_local_ocr=False)
    assert out["status"] == "UNKNOWN"
    assert out["reason_code"] == "COVER_OR_INSUFFICIENT_EVIDENCE"
    assert out["analyzed_page_count"] == 1
    assert_clean(out)


def test_pdf_quoted_keyword_in_body_is_not_document_heading():
    out = call(pdf("TONG QUAN\nTAI LIEU NAY NOI VE HOP DONG\nBEN A\nBEN B"),
               "pdf", allow_local_ocr=False)
    assert out["status"] == "UNKNOWN"


def test_scan_pdf_missing_ocr_and_available_fake_ocr_first_page_only(monkeypatch):
    raw = scanned_pdf()
    # Prevent remote calls or local OCR: not installed/authorized on this path.
    no = call(raw, "pdf", allow_local_ocr=False)
    assert (no["status"], no["reason_code"]) == ("UNKNOWN", "OCR_UNAVAILABLE")
    original = fitz.Document.load_page
    inspected = []

    def guard(doc, pno=0):
        inspected.append(pno)
        assert pno == 0
        return original(doc, pno)

    monkeypatch.setattr(fitz.Document, "load_page", guard)
    seen = []

    def local_fake(pixels):
        seen.append(pixels.getpixel((150, 100)))
        return WORKSHEET

    yes = call(raw, "pdf", ocr_reader=local_fake)
    assert yes["status"] == "SUGGESTED" and yes["category"] == "WORKSHEET"
    assert inspected == [0] and len(seen) == 1
    assert seen[0][0] > seen[0][2]  # red page, never blue page 2
    assert_clean(yes)


def test_multipage_tiff_uses_only_first_frame_for_fake_ocr():
    a, b = Image.new("RGB", (140, 180), "red"), Image.new("RGB", (140, 180), "blue")
    buffer = io.BytesIO()
    a.save(buffer, format="TIFF", save_all=True, append_images=[b])
    a.close(); b.close()
    seen = []

    def local_fake(image):
        seen.append(image.getpixel((10, 10)))
        return FORM

    out = call(buffer.getvalue(), "tiff", ocr_reader=local_fake)
    assert out["status"] == "SUGGESTED" and out["category"] == "APPLICATION_FORM"
    assert out["analyzed_page_count"] == 1 and len(seen) == 1
    assert seen[0][0] > seen[0][2]
    assert_clean(out)


def test_image_without_local_ocr_unknown():
    outcome = call(png(), "png", allow_local_ocr=False)
    assert outcome["status"] == "UNKNOWN"
    assert outcome["reason_code"] == "OCR_UNAVAILABLE"
    assert_clean(outcome)


def test_ocr_exception_fails_closed_without_sensitive_exception_text():
    def fake(_image):
        raise RuntimeError("private-customer-id-123")
    out = call(png(), "png", ocr_reader=fake)
    assert (out["status"], out["reason_code"]) == ("UNKNOWN", "OCR_FAILED")
    assert "private-customer-id-123" not in str(out)


def test_docx_never_guesses_document_xml_first_page():
    z = io.BytesIO()
    with zipfile.ZipFile(z, "w") as out:
        out.writestr("word/document.xml", f"<w:t>{WORKSHEET}</w:t>")
    result = call(z.getvalue(), "docx")
    assert (result["status"], result["reason_code"], result["analyzed_page_count"]) == (
        "UNKNOWN", "WORD_NATIVE_FIRST_PAGE_UNVERIFIED", 0)
    assert_clean(result)


@pytest.mark.parametrize("raw,fmt,code", [
    (b"not pdf", "pdf", "EXTENSION_CONTENT_MISMATCH"),
    (b"%PDF-garbage", "pdf", "PDF_UNREADABLE"),
    (b"not image", "png", "IMAGE_UNREADABLE"),
    (b"not word", "docx", "DOCUMENT_CORRUPT"),
    (b"any", "xyz", "UNSUPPORTED_FORMAT"),
    (b"", "pdf", "INVALID_FILE_SIZE"),
])
def test_corrupt_or_unsupported_document_fails_closed(raw, fmt, code):
    out = call(raw, fmt, allow_local_ocr=False)
    assert out["status"] == "NEEDS_HUMAN"
    assert out["reason_code"] == code
    assert out["analyzed_page_count"] == 0
    assert_clean(out)


def test_trusted_source_hash_required_and_filename_is_not_input():
    raw = pdf(WORKSHEET)
    bad = classify_first_page(raw, format_hint="pdf", expected_sha256="0" * 64)
    assert bad["status"] == "NEEDS_HUMAN"
    assert bad["reason_code"] == "SOURCE_HASH_MISMATCH"
    # The classifier has no filename argument at all; even a misleading
    # customer filename cannot affect classification.
    assert "filename" not in classify_first_page.__code__.co_varnames
    assert_clean(bad)


def test_synthetic_one_page_latency_measurement(capsys):
    samples = [pdf(WORKSHEET), pdf(CONTRACT), pdf("TRANG BIA", WORKSHEET), png()]
    times = []
    for data in samples:
        fmt = "pdf" if data.startswith(b"%PDF") else "png"
        start = perf_counter()
        outcome = call(data, fmt, allow_local_ocr=False)
        times.append(round((perf_counter() - start) * 1000, 3))
        assert_clean(outcome)
    # Reporting observed timing only: NOT a speed SLA or OCR benchmark.
    print(json.dumps({"benchmark_kind": "synthetic_first_page_no_ocr",
                      "samples": len(times), "latency_ms": times,
                      "median_ms": round(median(times), 3)}))


def test_fake_zip_without_word_document_cannot_masquerade_as_docx():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as archive:
        archive.writestr("unrelated.txt", "BAI TAP TOAN")
    out = call(buf.getvalue(), "docx")
    assert out["status"] == "NEEDS_HUMAN"
    assert out["reason_code"] == "DOCUMENT_CORRUPT"
    assert_clean(out)


def test_pdf_blank_first_page_cannot_read_later_page_for_label():
    with fitz.open() as doc:
        doc.new_page()
        page = doc.new_page()
        page.insert_text((45, 50), WORKSHEET)
        raw = doc.tobytes()
    out = call(raw, "pdf", allow_local_ocr=False)
    assert out["status"] == "UNKNOWN"
    assert out["category"] == "UNKNOWN"
    assert out["analyzed_page_count"] == 1
    assert_clean(out)


def test_oversized_png_rejected_from_header_without_decode_or_global_change(monkeypatch):
    from PIL import ImageOps

    # Genuine 14MP PNG but 1-bit synthetic pixels keep test memory/bytes low.
    output = io.BytesIO()
    with Image.new("1", (4000, 3500), 0) as src:
        src.save(output, format="PNG")
    source = output.getvalue()
    previous_limit = Image.MAX_IMAGE_PIXELS

    def must_not_decode(*_args, **_kwargs):
        raise AssertionError("Oversized header must reject before decode/EXIF/RGB")

    monkeypatch.setattr(ImageOps, "exif_transpose", must_not_decode)
    result = call(source, "png", ocr_reader=must_not_decode)
    assert (result["status"], result["reason_code"], result["analyzed_page_count"]) == (
        "NEEDS_HUMAN", "FIRST_PAGE_TOO_LARGE", 0)
    assert Image.MAX_IMAGE_PIXELS == previous_limit
    assert_clean(result)


def test_oversized_first_tiff_frame_rejected_before_decode(monkeypatch):
    from PIL import ImageOps

    buf = io.BytesIO()
    with Image.new("1", (4000, 3500), 0) as img:
        img.save(buf, format="TIFF", compression="tiff_lzw")
    before = Image.MAX_IMAGE_PIXELS

    def forbidden(*_args, **_kwargs):
        raise AssertionError("TIFF first frame must not be decoded")

    monkeypatch.setattr(ImageOps, "exif_transpose", forbidden)
    result = call(buf.getvalue(), "tiff", ocr_reader=forbidden)
    assert result["status"] == "NEEDS_HUMAN"
    assert result["reason_code"] == "FIRST_PAGE_TOO_LARGE"
    assert Image.MAX_IMAGE_PIXELS == before
    assert_clean(result)


def _fake_pytesseract(monkeypatch):
    """Optional OCR dependency is absent in default CI; fake it, never install."""
    fake = ModuleType("pytesseract")
    fake.pytesseract = SimpleNamespace(tesseract_cmd="tesseract")
    fake.image_to_string = lambda *_a, **_k: pytest.fail("unexpected OCR invocation")
    fake.get_languages = lambda *_a, **_k: pytest.fail("unbounded language listing")
    monkeypatch.setitem(sys.modules, "pytesseract", fake)
    return fake


def test_unbounded_get_languages_is_never_called_and_hung_discovery_times_out(monkeypatch):
    import subprocess
    pytesseract = _fake_pytesseract(monkeypatch)
    from workers.documents import first_page_classifier as module

    def discovery_timeout(command, *, capture_output, check, timeout):
        assert command[-1] == "--list-langs"
        assert capture_output and check is False
        assert 0 < timeout <= module.MAX_OCR_SECONDS
        raise subprocess.TimeoutExpired(command, timeout, output=b"private-language-output")

    def forbidden(*_args, **_kwargs):
        raise AssertionError("No OCR recognition after discovery timeout")

    monkeypatch.setattr(module.subprocess, "run", discovery_timeout)
    monkeypatch.setattr(pytesseract, "get_languages", forbidden)
    monkeypatch.setattr(pytesseract, "image_to_string", forbidden)
    result = call(png(), "png")
    assert (result["status"], result["reason_code"]) == ("UNKNOWN", "OCR_TIMEOUT")
    assert result["analyzed_page_count"] == 1
    assert "private-language-output" not in str(result)
    assert_clean(result)


def test_local_ocr_uses_remaining_budget_for_recognition(monkeypatch):
    import subprocess
    pytesseract = _fake_pytesseract(monkeypatch)
    from workers.documents import first_page_classifier as module

    # Deterministic monotonic ticks: 4-second end-to-end budget, not 4+4.
    ticks = iter([100.0, 101.0, 102.0, 103.0])
    monkeypatch.setattr(module, "monotonic", lambda: next(ticks))
    called = []

    def list_languages(command, *, capture_output, check, timeout):
        called.append(("discover", timeout))
        return subprocess.CompletedProcess(
            command, 0, stdout=b"List of available languages (2):\neng\nvie\n",
            stderr=b"")

    def recognize(_image, *, lang, config, timeout):
        called.append(("recognize", timeout))
        assert lang == "vie+eng" and config == "--psm 6"
        return WORKSHEET

    monkeypatch.setattr(module.subprocess, "run", list_languages)
    monkeypatch.setattr(pytesseract, "image_to_string", recognize)
    monkeypatch.setattr(pytesseract, "get_languages",
                        lambda *_args, **_kwargs: pytest.fail("no unbounded discovery"))
    result = call(png(), "png")
    assert result["status"] == "SUGGESTED"
    assert result["category"] == "WORKSHEET"
    assert called == [("discover", pytest.approx(3.0)),
                      ("recognize", pytest.approx(2.0))]
    assert_clean(result)


def test_discovery_consumes_ocr_budget_recognition_is_never_started(monkeypatch):
    import subprocess
    pytesseract = _fake_pytesseract(monkeypatch)
    from workers.documents import first_page_classifier as module

    ticks = iter([100.0, 100.0, 104.0])
    monkeypatch.setattr(module, "monotonic", lambda: next(ticks))

    def discovered(command, *, capture_output, check, timeout):
        assert timeout == pytest.approx(module.MAX_OCR_SECONDS)
        return subprocess.CompletedProcess(command, 0, stdout=b"eng\n", stderr=b"")

    monkeypatch.setattr(module.subprocess, "run", discovered)
    monkeypatch.setattr(pytesseract, "image_to_string",
                        lambda *_args, **_kwargs: pytest.fail("no time for OCR"))
    result = call(png(), "png")
    assert result["status"] == "UNKNOWN"
    assert result["reason_code"] == "OCR_TIMEOUT"
    assert_clean(result)


def test_discovery_error_does_not_leak_exception_or_attempt_ocr(monkeypatch):
    import subprocess
    pytesseract = _fake_pytesseract(monkeypatch)
    from workers.documents import first_page_classifier as module

    monkeypatch.setattr(module.subprocess, "run",
                        lambda *a, **k: subprocess.CompletedProcess(
                            a, 1, stdout=b"", stderr=b"private-customer-id-123"))
    monkeypatch.setattr(pytesseract, "image_to_string",
                        lambda *_args, **_kwargs: pytest.fail("discovery failed"))
    out = call(png(), "png")
    assert (out["status"], out["reason_code"]) == ("UNKNOWN", "OCR_UNAVAILABLE")
    assert "private-customer-id-123" not in str(out)
    assert_clean(out)
