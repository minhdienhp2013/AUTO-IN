"""Pure fixture contract tests; do not claim any API/DB/agent or OA exercised."""
import importlib.util
import io
import pathlib
import struct
import sys
import zipfile
import zlib

import pytest

MODULE = pathlib.Path(__file__).with_name("fixture_gate.py")
SPEC = importlib.util.spec_from_file_location("v1_fixture_gate", MODULE)
gate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gate)


def test_manifest_is_27_unique_labeled_not_run_cases():
    data = gate.manifest()
    assert data["phase"] == "pre-integration"
    assert data["source_candidate_sha"] == (
        "0673460af71205986b901a21fc7724dbea23c991")
    assert len(data["cases"]) == 27
    assert all(row["observed"] == "NOT_RUN" for row in data["cases"])


def test_27_synthetic_bytes_have_distinct_sha_and_correct_formats():
    result = gate.fixture_result()
    assert (result["count"], result["distinct_sha256"]) == (27, 27)
    assert result["status"] == "FIXTURE_PASS_PRODUCT_NOT_RUN"
    assert all(row["product_status"] == "NOT_RUN" for row in result["cases"])


@pytest.mark.parametrize("kind", ["pdf", "docx", "png", "xlsx", "zip"])
def test_synthetic_file_signatures_or_openable_archive(kind):
    raw = gate.source(kind, "V1-ACCEPTANCE-SYNTHETIC")
    assert len(raw) > 15
    if kind == "pdf":
        assert raw.startswith(b"%PDF-") and b"startxref" in raw
        marker = raw.rfind(b"startxref\n")
        pos = int(raw[marker + len(b"startxref\n"):].split(b"\n", 1)[0])
        assert raw[pos:pos+4] == b"xref"
    elif kind == "png":
        assert raw[:8] == b"\x89PNG\r\n\x1a\n"
        pos = 8
        while pos < len(raw):
            length = struct.unpack(">I", raw[pos:pos+4])[0]
            tag = raw[pos+4:pos+8]
            payload = raw[pos+8:pos+8+length]
            crc = struct.unpack(">I", raw[pos+8+length:pos+12+length])[0]
            assert (zlib.crc32(tag+payload)&0xffffffff) == crc
            pos += 12+length
        assert pos == len(raw)
    else:
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            names = archive.namelist()
            if kind == "docx": assert "word/document.xml" in names
            if kind == "xlsx": assert "xl/workbook.xml" in names
            if kind == "zip": assert len(names) == 6


def test_source_mutation_changes_sha_and_cannot_replay_old_source_digest():
    a = gate.source("pdf", "V1-SOURCE-A")
    b = gate.source("pdf", "V1-SOURCE-B")
    from hashlib import sha256
    assert sha256(a).hexdigest() != sha256(b).hexdigest()


def test_settings_are_separate_from_source_hash_and_need_new_confirmation():
    # Invariant at acceptance fixture level; the Core/staging agent must still
    # bind these settings in product evidence. We do NOT claim it does today.
    from hashlib import sha256
    import json
    file_sha = sha256(gate.source("docx", "V1-COPIES-CHANGE")).hexdigest()
    first = {"source_sha256": file_sha, "copies": 1, "duplex": False}
    second = {**first, "copies": 2}
    digest = lambda obj: sha256(json.dumps(obj,sort_keys=True).encode()).hexdigest()
    assert first["source_sha256"] == second["source_sha256"]
    assert digest(first) != digest(second)


def test_matrix_requires_manual_handoff_for_image_and_color():
    table = {row["key"]: row for row in gate.manifest()["cases"]}
    for key in ("image_manual", "cccd_manual", "color_manual",
                "excel_manual", "zip_over_five"):
        assert table[key]["expected"] == "MANUAL"
        assert table[key]["observed"] == "NOT_RUN"
    assert table["unknown_no_retry"]["expected"] == "HOLD"


def test_no_live_or_unsafe_operation_in_synthetic_generator():
    script = MODULE.read_text(encoding="utf-8")
    assert "requests.post(" not in script
    assert "subprocess.run(" not in script
    assert "raw9100" not in script.lower()
    assert "zalo.official" not in script.lower()


def test_exact_head_auditor_rejects_fixture_only_evidence(tmp_path):
    import hashlib
    import json
    spec = importlib.util.spec_from_file_location(
        "v1_candidate_auditor", MODULE.with_name("audit_candidate.py"))
    verifier = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(verifier)
    candidate = gate.manifest()["source_candidate_sha"]
    fake_report = gate.fixture_result()  # Intentionally NOT a product run.
    payload = tmp_path / "fixture-only.zip"
    with zipfile.ZipFile(payload, "w") as out:
        out.writestr("v1-word-pdf.json", json.dumps(fake_report))
        out.writestr("v1-word-pdf.tap", "TAP version 13\nok 1 - fixture only\n1..1\n")
    log = tmp_path / "job.log"
    log.write_text(f"EXACT_V1_CANDIDATE_SHA={candidate}\n", encoding="utf-8")
    digest = hashlib.sha256(payload.read_bytes()).hexdigest()
    with pytest.raises(AssertionError):
        verifier.evaluate(payload, candidate, digest, log, candidate)


def test_auditor_rejects_wrong_checkout_even_when_zip_digest_matches(tmp_path):
    import hashlib
    import json
    spec = importlib.util.spec_from_file_location(
        "v1_candidate_auditor", MODULE.with_name("audit_candidate.py"))
    verifier = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(verifier)
    candidate = gate.manifest()["source_candidate_sha"]
    artifact = tmp_path / "no-product.zip"
    with zipfile.ZipFile(artifact, "w") as z:
        z.writestr("v1-word-pdf.json", json.dumps({}))
    log = tmp_path / "job.log"
    log.write_text(f"EXACT_V1_CANDIDATE_SHA={candidate}\n", encoding="utf-8")
    with pytest.raises(AssertionError, match="CHECKOUT_SHA_MISMATCH"):
        verifier.evaluate(artifact, candidate,
            hashlib.sha256(artifact.read_bytes()).hexdigest(), log, "0"*40)


@pytest.mark.parametrize("case_id,changed", [
    ("V1-025", "manifest_sha256"),
    ("V1-026", "previews[0].sha256"),
    ("V1-027", "renderer_sha256"),
])
def test_new_digest_mutation_on_same_path_changes_evidence_sha_not_source(
        case_id, changed):
    """Only hashes change in the fixture; product stale handling is NOT RUN."""
    cases = {item["id"]: item for item in gate.same_path_evidence_pairs()}
    item = cases[case_id]
    before, after = item["before"], item["after"]
    assert item["product_status"] == "NOT_RUN"
    assert item["mutated_digest"] == changed
    assert item["stable_locators_before"] == item["stable_locators_after"]
    assert before["sources"] == after["sources"]
    assert before["source_set_sha256"] == after["source_set_sha256"]
    assert before["settings_sha256"] == after["settings_sha256"]
    assert before["request_hash"] == after["request_hash"]
    assert before["revision"] == after["revision"]
    assert before["manifest_ref"] == after["manifest_ref"]
    assert before["printer_capability_sha256"] == after["printer_capability_sha256"]
    assert before["evidence_sha256"] != after["evidence_sha256"]
    assert before["evidence_sha256"] == gate.canonical_sha256({
        key: value for key, value in before.items() if key != "evidence_sha256"})
    assert after["evidence_sha256"] == gate.canonical_sha256({
        key: value for key, value in after.items() if key != "evidence_sha256"})
    if changed == "manifest_sha256":
        assert before["manifest_sha256"] != after["manifest_sha256"]
        assert before["previews"] == after["previews"]
        assert before["renderer_sha256"] == after["renderer_sha256"]
    elif changed == "previews[0].sha256":
        assert before["previews"][0]["sha256"] != after["previews"][0]["sha256"]
        assert before["previews"][0]["bytes"] == after["previews"][0]["bytes"]
        assert before["manifest_sha256"] == after["manifest_sha256"]
        assert before["renderer_sha256"] == after["renderer_sha256"]
    else:
        assert before["renderer_sha256"] != after["renderer_sha256"]
        assert before["manifest_sha256"] == after["manifest_sha256"]
        assert before["previews"] == after["previews"]
