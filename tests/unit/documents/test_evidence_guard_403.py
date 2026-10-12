"""CODE-403: real renderer bytes + trusted frozen evidence + DryRun safety tests.

Synthetic only, on POSIX secure openat paths. No Zalo or Windows/Ricoh driver.
"""
import hashlib
import json
from pathlib import Path
import zipfile

import fitz
from PIL import Image
import pytest

from workers.documents import bridge
from workers.documents.evidence_guard import verify_approved_evidence, SCHEMA


def request(items):
    data = {"documents": items}
    return {"request_data": data,
            "expected_request_hash": hashlib.sha256(
                bridge._canonical(data).encode("utf-8")).hexdigest()}


def pdf(path, pages=3):
    with fitz.open() as document:
        for _ in range(pages):
            page = document.new_page()
            page.draw_rect(fitz.Rect(15, 20, 150, 200))
        document.save(path)


def image(path):
    Image.new("RGB", (240, 330), "white").save(path)


def prepared(tmp_path, docs):
    incoming, output = tmp_path / "incoming", tmp_path / "sealed"
    incoming.mkdir()
    output.mkdir()
    for name, kind, n in docs:
        if kind == "pdf":
            pdf(incoming / name, n)
        elif kind == "png":
            image(incoming / name)
        else:
            raise AssertionError(kind)
    return incoming, output


def published(incoming, output, items, *, revision=3):
    result = bridge.process_request(request(items),
                                    input_root=incoming, artifact_root=output)
    assert result["status"] == "READY", result
    ref = result["plan"]["artifact_ref"]
    manifest = (output / ref).read_bytes()
    trusted = {
        "active_revision": revision, "approval_revision": revision,
        "request_hash": result["plan"]["request_hash"],
        "approval_id": "human-staff-approval-in-test-db",
        "manifest_ref": ref,
        "manifest_sha256": hashlib.sha256(manifest).hexdigest(),
        "plan": result["plan"],
    }
    return result, trusted, json.loads(manifest)


def checked(trusted, root):
    return verify_approved_evidence(trusted, artifact_root=root)


def test_pdf_snapshot_and_preview_remain_sealed_after_incoming_changes(tmp_path):
    incoming, output = prepared(tmp_path, [("source.pdf", "pdf", 3)])
    result, trusted, manifest = published(
        incoming, output, [{"artifact_name": "source.pdf", "copies": 3, "duplex": True}])
    allowed = checked(trusted, output)
    assert allowed["schema"] == SCHEMA and allowed["status"] == "READY", allowed
    m = allowed["metadata"]
    assert (m["document_pages"], m["printed_faces"], m["physical_sheets"]) == (3, 9, 6)
    assert m["requires_price_confirmation"] is False
    assert m["paper_verified"] is False
    assert m["print_evidence_kind"] == "pre_send_document_only"
    assert m["source_sha256"] == [manifest["files"][0]["file_sha256"]]
    assert m["preview_sha256"] == [x["sha256"] for x in manifest["previews"]]
    pdf(incoming / "source.pdf", 1)  # Original mutable upload changed.
    assert checked(trusted, output)["status"] == "READY"


@pytest.mark.parametrize("bad_field", ["active_revision", "approval_revision"])
def test_revision_change_revokes_trusted_evidence(tmp_path, bad_field):
    incoming, output = prepared(tmp_path, [("source.pdf", "pdf", 2)])
    _, trusted, _ = published(incoming, output, [{"artifact_name": "source.pdf"}])
    assert checked(trusted, output)["status"] == "READY"
    wrong = {**trusted, bad_field: 4}
    proof = checked(wrong, output)
    assert proof["status"] == "NEEDS_HUMAN" and proof["reason_code"] == "STALE_REVISION"


def test_changed_request_hash_or_manifest_blocks_after_approval(tmp_path):
    incoming, output = prepared(tmp_path, [("source.pdf", "pdf", 2)])
    _, trusted, _ = published(incoming, output, [{"artifact_name": "source.pdf"}])
    assert checked({**trusted, "request_hash": "a" * 64}, output)["status"] == "NEEDS_HUMAN"
    assert checked({**trusted, "manifest_sha256": "b" * 64}, output)["reason_code"] == "MANIFEST_CHANGED"


def test_image_more_than_150_sheets_requires_price_confirmation_metadata(tmp_path):
    incoming, output = prepared(tmp_path, [("photo.png", "png", 1)])
    _, trusted, _ = published(incoming, output, [{"artifact_name": "photo.png", "copies": 151}])
    check = checked(trusted, output)
    assert check["status"] == "READY", check
    assert check["metadata"]["physical_sheets"] == 151
    assert check["metadata"]["requires_price_confirmation"] is True
    assert check["metadata"]["paper_verified"] is False


def test_multi_file_preview_file_counts_and_untrusted_paper_plan(tmp_path):
    incoming, output = prepared(tmp_path, [("a.pdf", "pdf", 3), ("b.png", "png", 1)])
    _, trusted, manifest = published(incoming, output, [
        {"artifact_name": "a.pdf", "duplex": True, "copies": 2},
        {"artifact_name": "b.png", "copies": 3},
    ])
    proof = checked(trusted, output)
    assert proof["status"] == "READY", proof
    assert proof["metadata"]["document_count"] == 2
    assert proof["metadata"]["physical_sheets"] == 7
    # Even a manifest with an updated SHA cannot forge counts/plan.
    manifest["files"][0]["physical_sheets"] = 999
    path = output / trusted["manifest_ref"]
    path.write_text(json.dumps(manifest), encoding="utf-8")
    altered = {**trusted, "manifest_sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
    assert checked(altered, output)["reason_code"] in ("COUNTS_MISMATCH", "MANIFEST_CHANGED")


def test_zip_expansion_as_separate_stable_sources_not_shared_duplex(tmp_path):
    incoming, output = prepared(tmp_path, [("a.pdf", "pdf", 3), ("b.pdf", "pdf", 1)])
    with zipfile.ZipFile(incoming / "docs.zip", "w") as archive:
        archive.write(incoming / "a.pdf", "a.pdf")
        archive.write(incoming / "b.pdf", "b.pdf")
    result, trusted, manifest = published(
        incoming, output, [{"artifact_name": "docs.zip", "duplex": True, "copies": 2}])
    proof = checked(trusted, output)
    assert proof["status"] == "READY", proof
    assert len(manifest["files"]) == 2
    assert proof["metadata"]["physical_sheets"] == 6
    assert proof["metadata"]["document_count"] == 2


@pytest.mark.parametrize("target", ["source", "preview", "manifest"])
def test_tampered_bytes_after_preview_cannot_pass_evidence_gate(tmp_path, target):
    incoming, output = prepared(tmp_path, [("a.pdf", "pdf", 2)])
    _, trusted, manifest = published(incoming, output, [{"artifact_name": "a.pdf"}])
    ref = {
        "source": manifest["files"][0]["source_artifact_ref"],
        "preview": manifest["previews"][0]["ref"],
        "manifest": trusted["manifest_ref"],
    }[target]
    file = output / ref
    old = file.read_bytes()
    file.chmod(0o600)
    file.write_bytes(old[:-1] + bytes([old[-1] ^ 1]))
    proof = checked(trusted, output)
    assert proof["status"] == "NEEDS_HUMAN", proof
    assert proof["reason_code"] == {
        "source": "SOURCE_CHANGED", "preview": "PREVIEW_CHANGED",
        "manifest": "MANIFEST_CHANGED"}[target]


@pytest.mark.parametrize("target", ["source", "preview", "manifest"])
def test_missing_artifact_or_io_failure_needs_human(tmp_path, target):
    incoming, output = prepared(tmp_path, [("a.png", "png", 1)])
    _, trusted, manifest = published(incoming, output, [{"artifact_name": "a.png"}])
    ref = {
        "source": manifest["files"][0]["source_artifact_ref"],
        "preview": manifest["previews"][0]["ref"],
        "manifest": trusted["manifest_ref"],
    }[target]
    (output / ref).unlink()
    proof = checked(trusted, output)
    assert proof["status"] == "NEEDS_HUMAN" and proof["ready"] is False


def test_preview_swapped_but_updated_sha_not_claimed_as_published_evidence(tmp_path):
    incoming, output = prepared(tmp_path, [("a.pdf", "pdf", 2)])
    _, trusted, manifest = published(incoming, output, [{"artifact_name": "a.pdf"}])
    png = output / manifest["previews"][0]["ref"]
    png.chmod(0o600)
    Image.new("RGB", (30, 30), "black").save(png)
    # Stable server hash on manifest prevents attacker updating preview digest.
    assert checked(trusted, output)["reason_code"] == "PREVIEW_CHANGED"


def test_malformed_manifest_and_source_ref_never_print_ready(tmp_path):
    incoming, output = prepared(tmp_path, [("a.pdf", "pdf", 2)])
    _, trusted, manifest = published(incoming, output, [{"artifact_name": "a.pdf"}])
    p = output / trusted["manifest_ref"]
    p.chmod(0o600)
    p.write_text('{"schema":"ai3.document_bridge.v1","files":[]}', encoding="utf-8")
    assert checked(trusted, output)["status"] == "NEEDS_HUMAN"
    p.write_text('{"broken": ', encoding="utf-8")
    assert checked({**trusted,"manifest_sha256":hashlib.sha256(p.read_bytes()).hexdigest()},
                   output)["status"] == "NEEDS_HUMAN"


def test_failure_during_render_returns_no_ready_plan_and_no_evidence(tmp_path, monkeypatch):
    incoming, output = prepared(tmp_path, [("a.pdf", "pdf", 2)])
    from workers.documents import processor
    monkeypatch.setattr(processor, "_inspect_data", lambda *args: (_ for _ in ()).throw(
        bridge._ProcessorDeadline()))
    answer = bridge.process_request(request([{"artifact_name":"a.pdf"}]),
                                    input_root=incoming, artifact_root=output)
    assert answer["status"] == "NEEDS_HUMAN" and answer["reason_code"] == "PROCESSING_TIMEOUT"
    assert not list(output.iterdir())


def test_fake_approval_fields_cannot_replace_trusted_document_proof(tmp_path):
    incoming, output = prepared(tmp_path, [("a.pdf", "pdf", 2)])
    _, trusted, manifest = published(incoming, output, [{"artifact_name": "a.pdf"}])
    assert checked({**trusted, "file_ref": "../../customer.pdf"}, output)["status"] == "NEEDS_HUMAN"
    assert checked({**trusted, "plan": {**trusted["plan"], "artifact_ref": "../../foo"}},
                   output)["status"] == "NEEDS_HUMAN"


def test_source_and_png_evidence_are_distinct_from_driver_completion(tmp_path):
    incoming, output = prepared(tmp_path, [("a.png", "png", 1)])
    _, trusted, _ = published(incoming, output, [{"artifact_name": "a.png"}])
    proof = checked(trusted, output)
    assert proof["status"] == "READY"
    assert proof["metadata"]["paper_verified"] is False
    assert proof["metadata"]["print_evidence_kind"] != "simulated"
    assert "VERIFIED_DONE" not in json.dumps(proof)
