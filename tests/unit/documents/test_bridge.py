"""CODE-203 product-backed document Port tests (only synthetic/local media)."""
import hashlib
import io
import json
from pathlib import Path
import zipfile

import fitz
from PIL import Image
import pytest

from workers.documents.bridge import _canonical, process_request


def _input(documents):
    data = {"documents": documents}
    digest = hashlib.sha256(_canonical(data).encode("utf-8")).hexdigest()
    return {"request_data": data, "expected_request_hash": digest}


@pytest.fixture
def roots(tmp_path):
    incoming, published = tmp_path / "incoming", tmp_path / "published"
    incoming.mkdir()
    published.mkdir()
    return incoming, published


def _pdf(path, count=3, *, text=False):
    doc = fitz.open()
    for i in range(count):
        p = doc.new_page()
        if text:
            p.insert_text((50, 50), "Unembedded font unsafe")
        else:
            p.draw_rect(fitz.Rect(25, 25, 170, 170))
    doc.save(path)
    doc.close()


def _png(path):
    Image.new("RGB", (512, 768), "white").save(path)


def test_synthetic_pdf_duplex_separate_copies_verified_manifest(roots):
    incoming, published = roots
    _pdf(incoming / "s.pdf", 3)
    request = _input([{"artifact_name": "s.pdf", "copies": 3, "duplex": True}])
    result = process_request(request, input_root=incoming, artifact_root=published)
    assert result["status"] == "READY", result
    plan = result["plan"]
    assert (plan["document_pages"], plan["printed_faces"], plan["physical_sheets"]) == (3, 9, 6)
    assert plan["request_hash"] == request["expected_request_hash"]
    assert plan["printer_id"] == "RMP7000" and plan["ready"] is True
    manifest = json.loads((published / plan["artifact_ref"]).read_text())
    assert manifest["counts"]["physical_sheets"] == 6
    assert len(manifest["previews"]) == 3
    for p in manifest["previews"]:
        stored = published / p["ref"]
        assert stored.is_file()
        assert hashlib.sha256(stored.read_bytes()).hexdigest() == p["sha256"]
    assert manifest["files"][0]["file_sha256"] == hashlib.sha256((incoming / "s.pdf").read_bytes()).hexdigest()
    assert manifest["content_settings_sha256"] == result["content_settings_sha256"]


def test_two_files_duplex_do_not_share_backside(roots):
    incoming, published = roots
    _pdf(incoming / "a.pdf", 3)
    _pdf(incoming / "b.pdf", 1)
    request = _input([{"artifact_name": "a.pdf", "duplex": True},
                      {"artifact_name": "b.pdf", "duplex": True}])
    value = process_request(request, input_root=incoming, artifact_root=published)
    assert value["status"] == "READY", value
    assert value["plan"]["printed_faces"] == 4
    assert value["plan"]["physical_sheets"] == 3


def test_synthetic_image_and_page_size_warning(roots):
    incoming, published = roots
    _png(incoming / "photo.png")
    value = process_request(_input([{"artifact_name": "photo.png", "paper": "A4"}]),
                            input_root=incoming, artifact_root=published)
    assert value["status"] == "READY", value
    assert value["plan"]["physical_sheets"] == 1
    manifest = json.loads((published / value["plan"]["artifact_ref"]).read_text())
    assert "IMAGE_PAPER_SIZE_REQUIRES_CONFIRMATION" in manifest["files"][0]["warnings"]


def test_pdf_unembedded_font_needs_human_no_artifact(roots):
    incoming, published = roots
    _pdf(incoming / "font.pdf", text=True)
    value = process_request(_input([{"artifact_name": "font.pdf"}]),
                            input_root=incoming, artifact_root=published)
    assert value["status"] == "NEEDS_HUMAN"
    assert value["reason_code"] == "PDF_FONT_NOT_EMBEDDED_OR_UNVERIFIED"
    assert list(published.iterdir()) == []


@pytest.mark.parametrize("name", [
    "../private.pdf", "/etc/passwd", "x/../../private.pdf", r"x\escape.pdf",
    "./a.pdf", "C:/Windows/file.pdf",
])
def test_customer_path_cannot_escape_root(roots, name):
    incoming, published = roots
    result = process_request(_input([{"artifact_name": name}]),
                             input_root=incoming, artifact_root=published)
    assert result["status"] == "NEEDS_HUMAN"
    assert result["reason_code"] == "UNSAFE_ARTIFACT_NAME"
    assert list(published.iterdir()) == []


def test_symlink_in_path_fails_closed(roots):
    incoming, published = roots
    outside = incoming.parent / "outside.pdf"
    _pdf(outside, 1)
    (incoming / "link.pdf").symlink_to(outside)
    result = process_request(_input([{"artifact_name": "link.pdf"}]),
                             input_root=incoming, artifact_root=published)
    assert result["status"] == "NEEDS_HUMAN"
    assert list(published.iterdir()) == []


@pytest.mark.parametrize("member,expected", [
    ("../escape.pdf", "ZIP_PATH_TRAVERSAL"),
    ("files/deep.zip", "NESTED_ZIP_REQUIRES_HUMAN"),
])
def test_zip_dangerous_entries_needs_human(roots, member, expected):
    incoming, published = roots
    archive = incoming / "files.zip"
    with zipfile.ZipFile(archive, "w") as z:
        z.writestr(member, b"%PDF-fake")
    result = process_request(_input([{"artifact_name": "files.zip"}]),
                             input_root=incoming, artifact_root=published)
    assert result["status"] == "NEEDS_HUMAN"
    assert result["reason_code"] == expected
    assert list(published.iterdir()) == []


def test_zip_safe_multi_doc_separate_sheets(roots):
    incoming, published = roots
    _pdf(incoming / "a.pdf", 3)
    raw = (incoming / "a.pdf").read_bytes()
    with zipfile.ZipFile(incoming / "docs.zip", "w") as z:
        z.writestr("a.pdf", raw)
        z.writestr("b.pdf", raw)
    result = process_request(_input([{"artifact_name": "docs.zip", "duplex": True}]),
                             input_root=incoming, artifact_root=published)
    assert result["status"] == "READY", result
    assert result["plan"]["physical_sheets"] == 4


@pytest.mark.parametrize("data", [b"invalid", b"%PDF- corrupt"])
def test_corrupt_pdf_not_ready(roots, data):
    incoming, published = roots
    (incoming / "bad.pdf").write_bytes(data)
    result = process_request(_input([{"artifact_name": "bad.pdf"}]),
                             input_root=incoming, artifact_root=published)
    assert result["status"] == "NEEDS_HUMAN"
    assert "plan" not in result


def test_word_and_excel_fail_closed(roots):
    incoming, published = roots
    (incoming / "a.docx").write_bytes(b"not a docx")
    (incoming / "b.xlsx").write_bytes(b"not excel")
    for name in ("a.docx", "b.xlsx"):
        result = process_request(_input([{"artifact_name": name}]),
                                 input_root=incoming, artifact_root=published)
        assert result["status"] == "NEEDS_HUMAN"
        assert "plan" not in result


def test_untrusted_customer_metadata_cannot_override_counts(roots):
    incoming, published = roots
    _pdf(incoming / "p.pdf")
    docs = [{"artifact_name": "p.pdf", "document_pages": 9999}]
    result = process_request(_input(docs), input_root=incoming, artifact_root=published)
    assert result["reason_code"] == "UNMAPPED_DOCUMENT_FIELDS"


def test_request_hash_mismatch_and_unsafe_floats(roots):
    incoming, published = roots
    _png(incoming / "photo.png")
    value = _input([{"artifact_name": "photo.png"}])
    value["expected_request_hash"] = "0" * 64
    result = process_request(value, input_root=incoming, artifact_root=published)
    assert result["reason_code"] == "REQUEST_HASH_MISMATCH"
    result = process_request({"request_data": {"documents": [
        {"artifact_name": "photo.png", "copies": 1.5}]}, "expected_request_hash": "0"*64},
        input_root=incoming, artifact_root=published)
    assert result["reason_code"] == "UNSAFE_CANONICAL_REQUEST_DATA"


def test_invalid_setting_fails_closed_without_artifacts(roots):
    incoming, published = roots
    _png(incoming / "photo.png")
    value = _input([{"artifact_name": "photo.png", "page_range": 999}])
    result = process_request(value, input_root=incoming, artifact_root=published)
    assert result["status"] == "NEEDS_HUMAN"
    assert list(published.iterdir()) == []
