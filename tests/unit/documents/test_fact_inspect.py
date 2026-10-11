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
    """Synthetic server-ingested immutable bytes + manifest pinned in DB by SHA."""
    digest = hashlib.sha256(data).hexdigest()
    # Each snapshot gets one sealed manifest, never overwrite older evidence.
    sealed_dir = root / f"{directory.name}-{index:03d}-{digest[:10]}"
    sealed_dir.mkdir(mode=0o700)
    name = f"source-{index:03d}-{digest}{ext}"
    path = sealed_dir / name
    path.write_bytes(data)
    path.chmod(0o400)
    ref = f"{sealed_dir.name}/{name}"
    manifest_ref = f"{sealed_dir.name}/manifest.json"
    manifest = {
        "schema": "ai3.upload_snapshot.v1",
        "files": [{"source_artifact_ref": ref, "file_sha256": digest,
                   "size_bytes": len(data)}],
    }
    manifest_path = sealed_dir / "manifest.json"
    manifest_bytes = json.dumps(manifest, separators=(",", ":"), sort_keys=True).encode()
    manifest_path.write_bytes(manifest_bytes)
    manifest_path.chmod(0o400)
    # Manifest ref + digest MUST be resolved from AI0 trusted DB, not webhook.
    item = {"artifact_ref": ref, "sha256": digest,
            "manifest_ref": manifest_ref,
            "manifest_sha256": hashlib.sha256(manifest_bytes).hexdigest()}
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



def test_bare_ref_and_self_declared_file_digest_are_not_sufficient(private_root):
    root, directory = private_root
    _, item = _snapshot(root, directory, _pdf(), ".pdf")
    unsigned = {"artifact_ref": item["artifact_ref"], "sha256": item["sha256"]}
    assert inspect([unsigned], artifact_root=root) == [
        {"kind": "unknown", "preview_trusted": False}
    ]
    assert process_request({"batch": [unsigned]}, artifact_root=root)["status"] == "NEEDS_HUMAN"


def test_manifest_deleted_or_mutated_must_block_known_valid_document(private_root):
    root, directory = private_root
    _, item = _snapshot(root, directory, _png(), ".png")
    signed = root / item["manifest_ref"]
    assert inspect([item], artifact_root=root)[0]["kind"] == "image"
    signed.chmod(0o600)
    signed.write_text('{"schema":"ai3.upload_snapshot.v1","files":[]}', encoding="utf-8")
    assert inspect([item], artifact_root=root)[0] == {
        "kind": "unknown", "preview_trusted": False
    }
    signed.unlink()
    assert inspect([item], artifact_root=root)[0]["kind"] == "unknown"


def test_manifest_source_evidence_wrong_but_manifest_sha_correct_rejected(private_root):
    root, directory = private_root
    _, item = _snapshot(root, directory, _pdf(), ".pdf")
    manifest_file = root / item["manifest_ref"]
    old = json.loads(manifest_file.read_text())
    old["files"][0]["file_sha256"] = "0" * 64
    serialized = json.dumps(old, sort_keys=True, separators=(",", ":")).encode()
    manifest_file.chmod(0o600)
    manifest_file.write_bytes(serialized)
    # Even a hash-updated manifest cannot make a mismatched source entry trusted.
    overwritten = dict(item, manifest_sha256=hashlib.sha256(serialized).hexdigest())
    assert inspect([overwritten], artifact_root=root) == [
        {"kind": "unknown", "preview_trusted": False}
    ]


def test_snapshot_missing_but_manifest_kept_returns_unknown(private_root):
    root, directory = private_root
    file, item = _snapshot(root, directory, _pdf(), ".pdf")
    file.unlink()
    assert inspect([item], artifact_root=root)[0] == {
        "kind": "unknown", "preview_trusted": False
    }


@pytest.mark.parametrize("failed", ["manifest", "document"])
def test_scoped_storage_read_errors_fail_closed(private_root, monkeypatch, failed):
    from workers.documents import bridge
    root, directory = private_root
    _, item = _snapshot(root, directory, _pdf(), ".pdf")
    original = bridge._read_scoped

    target = item["manifest_ref"] if failed == "manifest" else item["artifact_ref"]

    def fail_storage(root_path, relative):
        if relative == target:
            raise OSError("I/O error /secret/server/private-name.pdf")
        return original(root_path, relative)

    monkeypatch.setattr(bridge, "_read_scoped", fail_storage)
    result = process_request({"batch": [item]}, artifact_root=root)
    assert result["status"] == "NEEDS_HUMAN"
    assert result["facts"] == [{"kind": "unknown", "preview_trusted": False}]
    assert "/secret" not in json.dumps(result)


def test_symlink_manifest_is_never_followed(private_root, tmp_path):
    root, directory = private_root
    _, item = _snapshot(root, directory, _png(), ".png")
    manifest_path = root / item["manifest_ref"]
    evidence = manifest_path.read_bytes()
    external = tmp_path / "manifest.json"
    external.write_bytes(evidence)
    manifest_path.unlink()
    try:
        manifest_path.symlink_to(external)
    except (OSError, NotImplementedError):
        pytest.skip("symlink creation unavailable")
    assert inspect([item], artifact_root=root)[0] == {
        "kind": "unknown", "preview_trusted": False
    }


def test_real_bridge_published_snapshot_and_manifest_are_compatible(tmp_path):
    from workers.documents import bridge
    incoming = tmp_path / "incoming"
    root = tmp_path / "artifacts"
    incoming.mkdir()
    root.mkdir()
    (incoming / "verified.pdf").write_bytes(_pdf())
    request_data = {"documents": [{"artifact_name": "verified.pdf"}]}
    output = bridge.process_request(
        {"request_data": request_data,
         "expected_request_hash": hashlib.sha256(
             bridge._canonical(request_data).encode()).hexdigest()},
        input_root=incoming, artifact_root=root)
    assert output["status"] == "READY", output
    manifest_ref = output["plan"]["artifact_ref"]
    raw = (root / manifest_ref).read_bytes()
    manifest = json.loads(raw)
    evidence = manifest["files"][0]
    item = {
        "artifact_ref": evidence["source_artifact_ref"],
        "sha256": evidence["file_sha256"],
        "manifest_ref": manifest_ref,
        "manifest_sha256": hashlib.sha256(raw).hexdigest(),
    }
    assert inspect([item], artifact_root=root) == [
        {"kind": "pdf", "preview_trusted": True}
    ]
    assert process_request({"batch": [item]}, artifact_root=root)["status"] == "READY"


def test_cli_missing_manifest_evidence_fails_closed(private_root):
    root, directory = private_root
    _, item = _snapshot(root, directory, _png(), ".png")
    untrusted = dict(item)
    untrusted.pop("manifest_sha256")
    result = _cli(root, {"batch": [untrusted]})
    assert result.returncode == 2 and result.stderr == b""
    response = json.loads(result.stdout)
    assert response["status"] == "NEEDS_HUMAN"
    assert response["facts"] == [{"kind": "unknown", "preview_trusted": False}]



def test_same_size_source_mutation_is_detected_by_sha_not_size(private_root):
    root, directory = private_root
    path, item = _snapshot(root, directory, _pdf(), ".pdf")
    assert inspect([item], artifact_root=root)[0]["kind"] == "pdf"
    content = bytearray(path.read_bytes())
    content[-10] ^= 0x01  # Preserve length to prove SHA check is mandatory.
    path.chmod(0o600)
    path.write_bytes(content)
    assert path.stat().st_size == len(content)
    assert inspect([item], artifact_root=root) == [
        {"kind": "unknown", "preview_trusted": False}
    ]


def test_duplicate_manifest_entry_cannot_authorize_file(private_root):
    root, directory = private_root
    _, item = _snapshot(root, directory, _png(), ".png")
    signed = root / item["manifest_ref"]
    manifest = json.loads(signed.read_bytes())
    manifest["files"].append(dict(manifest["files"][0]))
    data = json.dumps(manifest, separators=(",", ":"), sort_keys=True).encode()
    signed.chmod(0o600)
    signed.write_bytes(data)
    modified = dict(item, manifest_sha256=hashlib.sha256(data).hexdigest())
    assert inspect([modified], artifact_root=root) == [
        {"kind": "unknown", "preview_trusted": False}
    ]


def test_corrupt_manifest_json_never_reveals_document(private_root):
    root, directory = private_root
    _, item = _snapshot(root, directory, _pdf(), ".pdf")
    manifest = root / item["manifest_ref"]
    manifest.chmod(0o600)
    malformed = b'{"schema":"ai3.upload_snapshot.v1", "files":['
    manifest.write_bytes(malformed)
    verified = dict(item, manifest_sha256=hashlib.sha256(malformed).hexdigest())
    cli = _cli(root, {"batch": [verified]})
    assert cli.returncode == 2 and cli.stderr == b""
    response = json.loads(cli.stdout)
    assert response["status"] == "NEEDS_HUMAN"
    assert response["facts"] == [{"kind": "unknown", "preview_trusted": False}]
    assert verified["artifact_ref"].encode() not in cli.stdout
