"""CODE-303 facts Port: real PDF, raster, ZIP, sha256 and safe JSON CLI.

All specimens are synthetic. No Zalo credentials, customer files or driver.
"""
from __future__ import annotations

import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import zipfile

import fitz
from PIL import Image
import pytest

from workers.documents.fact_inspect import SCHEMA, inspect, process_request


ROOT = Path(__file__).resolve().parents[3]


@pytest.fixture
def private_root(tmp_path):
    root = tmp_path / "private-artifacts"
    root.mkdir()
    directory = root / "doc-a1b2c3d4"
    directory.mkdir(mode=0o700)
    return root, directory


def _snapshot(root, directory, data: bytes, ext: str, index: int = 0):
    digest = hashlib.sha256(data).hexdigest()
    name = f"source-{index:03d}-{digest}{ext}"
    path = directory / name
    path.write_bytes(data)
    path.chmod(0o400)
    item = {"artifact_ref": f"{directory.name}/{name}", "sha256": digest}
    return path, item


def _pdf(pages=2):
    with fitz.open() as pdf:
        for _ in range(pages):
            page = pdf.new_page()
            page.draw_rect(fitz.Rect(10, 10, 70, 70))
        return pdf.tobytes()


def _png():
    data = io.BytesIO()
    Image.new("RGB", (200, 300), (245, 240, 250)).save(data, "PNG")
    return data.getvalue()


def _zip(members):
    data = io.BytesIO()
    with zipfile.ZipFile(data, "w") as archive:
        for name, content in members.items():
            archive.writestr(name, content)
    return data.getvalue()


def _cli(root: Path, payload):
    body = payload if isinstance(payload, bytes) else json.dumps(payload).encode("utf-8")
    return subprocess.run([
        sys.executable, "-m", "workers.documents.fact_inspect",
        "--artifact-root", str(root), "--timeout-seconds", "15",
    ], input=body, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        cwd=ROOT, timeout=20, check=False)


def test_pdf_and_image_are_verified_by_real_render(private_root):
    root, directory = private_root
    _, pdf = _snapshot(root, directory, _pdf(3), ".pdf")
    _, image = _snapshot(root, directory, _png(), ".png", 1)
    facts = inspect([pdf, image], artifact_root=root)
    assert facts == [
        {"kind": "pdf", "preview_trusted": True},
        {"kind": "image", "preview_trusted": True},
    ]
    output = process_request({"batch": [pdf, image]}, artifact_root=root)
    assert output == {"schema": SCHEMA, "status": "READY", "facts": facts}
    assert all(not any(key in f for key in ("document_pages", "physical_sheets", "path"))
               for f in facts)


def test_zip_safe_real_verified_members_counts_without_page_guess(private_root):
    root, directory = private_root
    archive = _zip({"first.pdf": _pdf(), "scan.png": _png()})
    _, item = _snapshot(root, directory, archive, ".zip")
    assert inspect([item], artifact_root=root) == [
        {"kind": "zip", "count_inside": 2, "preview_trusted": True}
    ]


@pytest.mark.parametrize("member", [
    "../outside.pdf", "/root/escape.pdf", "docs/../escape.pdf",
])
def test_zip_unsafe_paths_are_unknown(private_root, member):
    root, directory = private_root
    _, item = _snapshot(root, directory, _zip({member: _pdf()}), ".zip")
    assert inspect([item], artifact_root=root) == [
        {"kind": "unknown", "preview_trusted": False}
    ]


def test_zip_with_word_is_known_count_but_requires_staff(private_root):
    root, directory = private_root
    _, item = _snapshot(root, directory, _zip({
        "a.pdf": _pdf(), "b.docx": b"not-verified-document"
    }), ".zip")
    assert inspect([item], artifact_root=root) == [
        {"kind": "zip", "count_inside": 2, "preview_trusted": False}
    ]
    assert process_request({"batch": [item]}, artifact_root=root)["status"] == "NEEDS_HUMAN"


@pytest.mark.parametrize("ext,kind", [(".docx", "word"), (".doc", "word"),
                                      (".xlsx", "excel"), (".csv", "excel")])
def test_manual_formats_never_gain_fake_trusted_preview(private_root, ext, kind):
    root, directory = private_root
    _, item = _snapshot(root, directory, b"synthetic but unrendered", ext)
    assert inspect([item], artifact_root=root) == [
        {"kind": kind, "preview_trusted": False}
    ]


def test_hash_mismatch_and_changed_snapshot_fail_closed(private_root):
    root, directory = private_root
    path, item = _snapshot(root, directory, _pdf(), ".pdf")
    assert inspect([item], artifact_root=root)[0]["kind"] == "pdf"
    path.chmod(0o600)
    path.write_bytes(_png())  # Existing immutable ref now contains DIFFERENT bytes.
    assert inspect([item], artifact_root=root) == [
        {"kind": "unknown", "preview_trusted": False}
    ]
    assert process_request({"batch": [item]}, artifact_root=root)["status"] == "NEEDS_HUMAN"


def test_missing_ref_and_bad_expected_hash_are_unknown(private_root):
    root, directory = private_root
    _, item = _snapshot(root, directory, _pdf(), ".pdf")
    invalid = dict(item, sha256="0" * 64)
    missing = {"artifact_ref": "doc-a1b2c3d4/source-000-" + ("a" * 64) + ".pdf",
               "sha256": "a" * 64}
    assert inspect([invalid, missing], artifact_root=root) == [
        {"kind": "unknown", "preview_trusted": False},
        {"kind": "unknown", "preview_trusted": False},
    ]


@pytest.mark.parametrize("untrusted_ref", [
    "../../secrets/private.pdf", "/tmp/elsewhere.pdf",
    "https://example.com/customer.pdf", "inbox/customer.pdf",
    "doc-a1b2c3d4/../source-000-secret.pdf",
])
def test_webhook_paths_and_urls_never_read(private_root, untrusted_ref):
    root, directory = private_root
    path, valid = _snapshot(root, directory, _pdf(), ".pdf")
    malicious = {"artifact_ref": untrusted_ref, "sha256": valid["sha256"]}
    assert inspect([malicious], artifact_root=root) == [
        {"kind": "unknown", "preview_trusted": False}
    ]


def test_symlink_snapshot_rejected_without_following(private_root, tmp_path):
    root, directory = private_root
    other, item = _snapshot(root, directory, _pdf(), ".pdf")
    other.unlink()
    external = tmp_path / "outside.pdf"
    external.write_bytes(_pdf())
    try:
        other.symlink_to(external)
    except (OSError, NotImplementedError):
        pytest.skip("symlink creation unavailable")
    assert inspect([item], artifact_root=root) == [
        {"kind": "unknown", "preview_trusted": False}
    ]


def test_corrupt_pdf_and_wrong_extension_do_not_claim_preview_trust(private_root):
    root, directory = private_root
    _, item = _snapshot(root, directory, b"not a PDF", ".pdf")
    _, second = _snapshot(root, directory, _pdf(), ".png", 1)
    assert inspect([item, second], artifact_root=root) == [
        {"kind": "unknown", "preview_trusted": False},
        {"kind": "unknown", "preview_trusted": False}
    ]


def test_cli_pdf_image_zip_json_shape_and_no_document_leaks(private_root):
    root, directory = private_root
    _, pdf = _snapshot(root, directory, _pdf(), ".pdf")
    _, img = _snapshot(root, directory, _png(), ".png", 1)
    _, zipitem = _snapshot(root, directory, _zip({"a.pdf": _pdf()}), ".zip", 2)
    response = _cli(root, {"batch": [pdf, img, zipitem]})
    assert response.returncode == 0, response.stderr
    assert response.stderr == b""
    assert response.stdout.count(b"\n") == 1
    value = json.loads(response.stdout)
    assert value["schema"] == SCHEMA and value["status"] == "READY"
    assert value["facts"] == [
        {"kind": "pdf", "preview_trusted": True},
        {"kind": "image", "preview_trusted": True},
        {"kind": "zip", "count_inside": 1, "preview_trusted": True},
    ]
    assert pdf["artifact_ref"].encode() not in response.stdout
    assert b"source-000" not in response.stdout


@pytest.mark.parametrize("bad", [
    {"batch": [{"artifact_ref": "any.pdf", "sha256": "a" * 64}]},
    {"batch": [{"artifact_ref": "doc-a1b2c3d4/source-000-" + "a"*64 + ".pdf",
                "sha256": "0"*64}]},
    {"batch": [{"artifact_ref": "doc-a1b2c3d4/source-000-" + "a"*64 + ".pdf",
                "sha256": "a"*64}]},
    b"{broken",
    b'{"batch":[],"batch":[]}',
    {"batch": [{"filename": "../../customers.pdf"}]},
])
def test_cli_invalid_missing_or_hash_mismatch_needs_human(private_root, bad):
    root, directory = private_root
    response = _cli(root, bad)
    assert response.returncode == 2 and response.stderr == b""
    value = json.loads(response.stdout)
    assert value["status"] == "NEEDS_HUMAN"
    assert value["facts"] == [{"kind": "unknown", "preview_trusted": False}]
    assert "reason_code" in value
    assert b"customers.pdf" not in response.stdout


def test_cli_limits_failing_closed_not_extra_facts(private_root):
    root, directory = private_root
    output = _cli(root, b" " * (256 * 1024 + 1))
    assert output.returncode == 2
    assert json.loads(output.stdout)["facts"] == [
        {"kind": "unknown", "preview_trusted": False}
    ]


def test_batch_over_rule_threshold_is_preserved_for_ai2_handover(private_root):
    root, directory = private_root
    rows = []
    for index in range(6):
        _, item = _snapshot(root, directory, _png(), ".png", index)
        rows.append(item)
    facts = inspect(rows, artifact_root=root)
    assert len(facts) == 6 and all(f["preview_trusted"] for f in facts)
    # AI2 computes the actual total and routes >5 to a human.
