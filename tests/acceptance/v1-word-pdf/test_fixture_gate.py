"""Pure fixture contract tests; do not claim any API/DB/agent or OA exercised."""
import importlib.util
import io
import pathlib
import re
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
    assert re.fullmatch(r"[a-f0-9]{40}", gate.current_candidate_sha())
    assert len(data["cases"]) == 27
    assert all(row["observed"] == "NOT_RUN" for row in data["cases"])


def test_27_synthetic_bytes_have_distinct_sha_and_correct_formats():
    result = gate.fixture_result()
    assert (result["count"], result["distinct_sha256"]) == (27, 27)
    assert result["status"] == "FIXTURE_PASS_PRODUCT_NOT_RUN"
    assert all(row["product_status"] == "NOT_RUN" for row in result["cases"])
    assert result["source_candidate_sha"] == gate.current_candidate_sha()
    assert [row["id"] for row in result["product_acceptance_cases"]] == [
        f"V1-{number:03d}" for number in range(28, 37)]
    assert all(row["observed"] == "NOT_RUN"
               for row in result["product_acceptance_cases"])


def test_ticket_gate_matrix_covers_core_contract_and_exact_lease():
    cases = gate.ticket_gate_cases()["cases"]
    by_id = {row["id"]: row for row in cases}
    assert len(cases) == 4
    assert len(by_id["V1-028"]["required_checks"]) == 18
    assert len(by_id["V1-029"]["required_checks"]) >= 8
    assert set(by_id["V1-030"]["required_checks"]) == {
        "job_id", "order_id", "revision", "request_hash", "approval_id",
        "printer_id", "lease_token"}
    assert all(row["expected"] == "HOLD" and row["observed"] == "NOT_RUN"
               for row in cases)


def test_inbound_queue_matrix_is_product_only_and_shop_scoped():
    cases = gate.inbound_queue_cases()
    assert [row["id"] for row in cases] == [f"V1-{number:03d}" for number in range(32, 37)]
    by_id = {row["id"]: row for row in cases}
    assert set(by_id["V1-032"]["required_checks"]) >= {
        "missing_bearer_401", "nonstaff_403", "staff_bearer_no_store", "no_shop_query"}
    assert "spoof_query_ignored_or_denied" in by_id["V1-033"]["required_checks"]
    assert "source_not_ready_disclaimer" in by_id["V1-034"]["required_checks"]
    assert "network_error_clears_old_rows" in by_id["V1-035"]["required_checks"]
    assert "print_job_writes_zero" in by_id["V1-036"]["required_checks"]
    assert all(row["expected"] == "PASS" and row["observed"] == "NOT_RUN"
               for row in cases)


def test_ticket_gate_auditor_requires_all_mutations_and_no_side_effects():
    spec = importlib.util.spec_from_file_location(
        "v1_candidate_auditor", MODULE.with_name("audit_candidate.py"))
    verifier = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(verifier)
    matrix = gate.ticket_gate_cases()["cases"]
    base_gate = {
        "https_trace_sha256": "a" * 64,
        "agent_trace_sha256": "b" * 64,
        "core_guard_trace_sha256": "c" * 64,
        "authenticated_https": True,
        "physical_print": False,
    }

    def denied(check_key, field="check"):
        return {field: check_key, "result": "NEEDS_HUMAN",
                "journal_rows_before": 0, "journal_rows_after": 0,
                "mark_sending_calls": 0, "driver_send_calls": 0}

    for case in matrix:
        gate_row = dict(base_gate)
        if case["id"] in ("V1-028", "V1-029"):
            gate_row["mutation_results"] = [
                denied(check) for check in case["required_checks"]]
        elif case["id"] == "V1-030":
            gate_row["lease_identity_mismatches"] = [
                denied(field, "field") for field in case["required_checks"]]
        else:
            gate_row.update(ticket_source="core_authenticated_https",
                            events=["claim", "preflight"],
                            end_to_end=denied("malformed_core_ticket_end_to_end"))
        assert verifier.ticket_gate_evidence_issues(
            case["id"], {"ticket_gate": gate_row}) == []

    incomplete = {"ticket_gate": {**base_gate, "mutation_results": []}}
    issues = verifier.ticket_gate_evidence_issues("V1-028", incomplete)
    assert any("coverage incomplete" in issue for issue in issues)

    unsafe = {"ticket_gate": {
        **base_gate,
        "ticket_source": "core_authenticated_https",
        "events": ["claim", "preflight", "mark-sending"],
        "end_to_end": {**denied("case"), "driver_send_calls": 1},
    }}
    issues = verifier.ticket_gate_evidence_issues("V1-031", unsafe)
    assert any("unexpected event" in issue for issue in issues)
    assert any("driver_send_calls not zero" in issue for issue in issues)


def test_inbound_queue_auditor_requires_auth_scope_ui_and_read_only_proof():
    spec = importlib.util.spec_from_file_location(
        "v1_candidate_auditor", MODULE.with_name("audit_candidate.py"))
    verifier = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(verifier)
    cases = gate.inbound_queue_cases()
    common = {"api_trace_sha256": "a"*64, "ui_trace_sha256": "b"*64,
              "db_guard_trace_sha256": "c"*64,
              "checks": {name: True for case in cases for name in case["required_checks"]}}
    evidence = {
        "V1-032": {"endpoint":"/api/v1/inbound-review-items", "method":"GET",
            "unauthenticated_status":401,"non_staff_status":403,"authorized_bearer":True,
            "cache_control":"no-store","query_parameters":[],
            "response_item_fields":["id","kind","mapped_customer","media_state",
                "raw_event_sha256","received_at","status"]},
        "V1-033": {"tenant_scope":{"scope_source":"authenticated_principal.shop_id",
            "principal_shop_item_ids":["a"],"returned_item_ids":["a"],
            "foreign_shop_item_ids":["b"],"spoof_query_status":200,"cross_shop_status":403}},
        "V1-034": {"displayed_statuses":["NEEDS_HUMAN"],
            "displayed_media_states":["AWAITING_MEDIA"],
            "source_not_ready_copy":"tệp gốc chưa được lưu hoặc chưa sẵn sàng.",
            "visible_actions":["refresh"]},
        "V1-035": {"error_observations":[
            {"condition":name,"old_rows_present":False,"visible_error":True}
            for name in ("network","401","503")]},
        "V1-036": {"requests":[{"path":"/api/v1/inbound-review-items","method":"GET"}],
            "mutation_counts_before":{"preview_reads":0,"confirmations":0,"approvals":0,"print_jobs":0},
            "mutation_counts_after":{"preview_reads":0,"confirmations":0,"approvals":0,"print_jobs":0}},
    }
    for case in cases:
        assert verifier.inbound_queue_evidence_issues(
            case["id"], {"inbound_queue":{**common,**evidence[case["id"]]}}) == []
    bad = {"inbound_queue":{**common,**evidence["V1-034"],
        "displayed_media_states":["SAVED"]}}
    assert any("AWAITING_MEDIA" in issue for issue in
        verifier.inbound_queue_evidence_issues("V1-034",bad))
    stale = {"inbound_queue":{**common,**evidence["V1-035"],
        "error_observations":[{"condition":"network","old_rows_present":True,
                               "visible_error":True}]}}
    assert any("stale rows" in issue for issue in
        verifier.inbound_queue_evidence_issues("V1-035",stale))


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
    assert script.count("subprocess.run(") == 1
    assert '["git","rev-parse","HEAD"]' in script
    assert "raw9100" not in script.lower()
    assert "zalo.official" not in script.lower()


def test_exact_head_auditor_rejects_fixture_only_evidence(tmp_path):
    import hashlib
    import json
    spec = importlib.util.spec_from_file_location(
        "v1_candidate_auditor", MODULE.with_name("audit_candidate.py"))
    verifier = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(verifier)
    candidate = gate.current_candidate_sha()
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
    candidate = gate.current_candidate_sha()
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


@pytest.mark.parametrize("case_id", ["V1-025", "V1-026", "V1-027"])
def test_auditor_requires_product_stale_actions_for_same_path_digest_drift(case_id):
    """Pure verifier negative control: never counts as a product-tested case."""
    spec = importlib.util.spec_from_file_location(
        "v1_candidate_auditor", MODULE.with_name("audit_candidate.py"))
    verifier = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(verifier)
    pair = next(x for x in gate.same_path_evidence_pairs() if x["id"] == case_id)
    fixture_only = {
        "evidence_before": pair["before"],
        "evidence_after": pair["after"],
        "stable_locators_before": pair["stable_locators_before"],
        "stable_locators_after": pair["stable_locators_after"],
    }
    issues = verifier.stale_digest_evidence_issues(case_id, fixture_only)
    assert any("stale action outcomes" in msg for msg in issues)
    assert any("driver send" in msg for msg in issues)
    assert any("guard changed" in msg for msg in issues)
    # Positive control exercises only the consistency checker with explicitly
    # fabricated values. Real candidate acceptance still requires PG/agent logs.
    synthetic = {
        **fixture_only,
        "stale_action_results": {
            name: "STALE" for name in
            ("confirmation", "approval", "claim", "preflight", "mark_sending")},
        "guards_before": {"confirmations": 0, "approvals": 0, "print_jobs": 0},
        "guards_after": {"confirmations": 0, "approvals": 0, "print_jobs": 0},
        "driver_send_calls_before": 0,
        "driver_send_calls_after": 0,
    }
    assert verifier.stale_digest_evidence_issues(case_id, synthetic) == []
    tampered = {**synthetic, "stable_locators_after": {
        **synthetic["stable_locators_after"],
        "manifest_ref": "different/path/manifest.json"}}
    assert any("resource path invariant" in msg for msg in
               verifier.stale_digest_evidence_issues(case_id, tampered))
