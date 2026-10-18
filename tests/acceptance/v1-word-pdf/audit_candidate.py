"""AI5 exact-SHA independent V1 artifact gate. Fail CLOSED on missing evidence.

Never infer PASS from generic CI green or a self-reported JSON alone:
  python tests/acceptance/v1-word-pdf/audit_candidate.py \
    --candidate-sha <actual-integrated-sha> \
    --artifact /tmp/v1-word-pdf-artifact.zip \
    --zip-sha256 <SHA256_FROM_GITHUB> \
    --job-log /tmp/exact-head-unified-job.log

Required files inside ZIP: v1-word-pdf.json, v1-word-pdf.tap.
AI0 must supply real product-produced per-case evidence with DB/postback/agent
guard checks. A ZIP generated only by fixture selfcheck can NEVER PASS here.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import pathlib
import re
import subprocess
import sys
import zipfile
from collections import Counter

ROOT=pathlib.Path(__file__).resolve().parents[3]
MANIFEST=ROOT/"tests/fixtures/public/v1-word-pdf/matrix.json"
TICKET_GATE_MATRIX=pathlib.Path(__file__).with_name("ticket_gate_matrix.json")
WORD_REVIEW_MATRIX=pathlib.Path(__file__).with_name("word_review_matrix.json")
HEX40=re.compile(r"[a-f0-9]{40}\Z")
HEX64=re.compile(r"[a-f0-9]{64}\Z")
GATES=("source_sha256","settings_sha256","request_hash","revision","manifest_sha256",
       "renderer_sha256","plan_sha256","printer_capability_sha256","evidence_sha256")
COUNTS=("confirmations","approvals","print_jobs")


def canonical_sha256(value):
    return hashlib.sha256(json.dumps(
        value,ensure_ascii=False,sort_keys=True,separators=(",",":")
    ).encode("utf-8")).hexdigest()


def stale_digest_evidence_issues(case_id, details):
    """Require product-original stale actions, not a fixture-only digest check."""
    mutation={
        "V1-025": "manifest_sha256",
        "V1-026": "previews[0].sha256",
        "V1-027": "renderer_sha256",
    }[case_id]
    issues=[]
    earlier,later=details.get("evidence_before"),details.get("evidence_after")
    if not isinstance(earlier,dict) or not isinstance(later,dict):
        return [case_id+": authoritative PrintEvidenceV1 before/after missing"]
    keys=("schema","shop_id","order_id","revision","request_hash","sources",
          "source_set_sha256","settings_sha256","manifest_ref","manifest_sha256",
          "previews","renderer_sha256","plan_sha256","printer_id",
          "printer_capability_sha256","evidence_sha256")
    for name,snapshot in [("before",earlier),("after",later)]:
        if not all(k in snapshot for k in keys):
            issues.append(case_id+": "+name+" PrintEvidenceV1 incomplete")
            continue
        if snapshot.get("schema")!="ai0.print_evidence.v1":
            issues.append(case_id+": "+name+" evidence schema")
        expected=canonical_sha256({k:v for k,v in snapshot.items() if k!="evidence_sha256"})
        if snapshot.get("evidence_sha256")!=expected:
            issues.append(case_id+": "+name+" noncanonical evidence_sha256")
    if issues:return issues
    immutable=("shop_id","order_id","revision","request_hash","sources",
               "source_set_sha256","settings_sha256","manifest_ref","plan_sha256",
               "printer_id","printer_capability_sha256")
    for key in immutable:
        if earlier[key]!=later[key]:
            issues.append(case_id+": mutated unexpected field "+key)
    a_preview=earlier.get("previews",[])
    b_preview=later.get("previews",[])
    if len(a_preview)!=len(b_preview) or len(a_preview)!=1:
        issues.append(case_id+": missing single preview proof")
    elif a_preview[0].get("index")!=b_preview[0].get("index") or a_preview[0].get("bytes")!=b_preview[0].get("bytes"):
        issues.append(case_id+": preview index/byte length changed")
    diffs=[]
    if earlier.get("manifest_sha256")!=later.get("manifest_sha256"):
        diffs.append("manifest_sha256")
    if a_preview and b_preview and a_preview[0].get("sha256")!=b_preview[0].get("sha256"):
        diffs.append("previews[0].sha256")
    if earlier.get("renderer_sha256")!=later.get("renderer_sha256"):
        diffs.append("renderer_sha256")
    if diffs!=[mutation]:
        issues.append(case_id+": digest mutation not isolated: "+str(diffs))
    if earlier.get("evidence_sha256")==later.get("evidence_sha256"):
        issues.append(case_id+": unchanged evidence_sha256")
    old_paths=details.get("stable_locators_before")
    new_paths=details.get("stable_locators_after")
    if (not isinstance(old_paths,dict) or not isinstance(new_paths,dict)
        or old_paths!=new_paths or not all(
            isinstance(old_paths.get(k),str) and old_paths[k]
            for k in ("source_artifact_ref","manifest_ref",
                      "preview_storage_path","renderer_executable_path")
        )):
        issues.append(case_id+": resource path invariant not verified")
    elif (old_paths["source_artifact_ref"]!=earlier["sources"][0].get("source_artifact_ref")
          or old_paths["manifest_ref"]!=earlier["manifest_ref"]):
        issues.append(case_id+": stable path does not bind snapshot")
    actions=details.get("stale_action_results")
    if (not isinstance(actions,dict) or not all(
        actions.get(k) in ("STALE","DENIED","NEEDS_HUMAN")
        for k in ("confirmation","approval","claim","preflight","mark_sending")
    )):
        issues.append(case_id+": missing stale action outcomes")
    before,after=details.get("guards_before"),details.get("guards_after")
    if not isinstance(before,dict) or not isinstance(after,dict) or any(
        before.get(k)!=after.get(k) for k in COUNTS
    ):
        issues.append(case_id+": confirmation/approval/print job guard changed")
    a,b=details.get("driver_send_calls_before"),details.get("driver_send_calls_after")
    if not isinstance(a,int) or not isinstance(b,int) or a!=b:
        issues.append(case_id+": unverified extra driver send attempt")
    return issues


def ticket_gate_evidence_issues(case_id, details):
    """Require explicit product observations for the integrated HTTPS gate."""
    matrix=json.loads(TICKET_GATE_MATRIX.read_text(encoding="utf-8"))
    spec=next(case for case in matrix["cases"] if case["id"]==case_id)
    gate=details.get("ticket_gate")
    if not isinstance(gate,dict):
        return [case_id+": ticket gate evidence missing"]
    issues=[]
    for field in ("https_trace_sha256","agent_trace_sha256","core_guard_trace_sha256"):
        if not HEX64.fullmatch(str(gate.get(field,""))):
            issues.append(case_id+": invalid/missing "+field)
    if gate.get("authenticated_https") is not True:
        issues.append(case_id+": authenticated HTTPS not verified")
    if gate.get("physical_print") is not False:
        issues.append(case_id+": physical print must remain disabled")

    def side_effects_free(row, label):
        if not isinstance(row,dict):
            issues.append(case_id+": missing observation "+label)
            return
        if row.get("result")!="NEEDS_HUMAN":
            issues.append(case_id+": "+label+" did not fail closed")
        if (row.get("journal_rows_before")!=row.get("journal_rows_after") or
                type(row.get("journal_rows_before")) is not int):
            issues.append(case_id+": "+label+" journal changed/unverified")
        for field in ("mark_sending_calls","driver_send_calls"):
            if row.get(field)!=0:
                issues.append(case_id+": "+label+" "+field+" not zero")

    if case_id in ("V1-028","V1-029"):
        rows=gate.get("mutation_results")
        expected=set(spec["required_checks"])
        if (not isinstance(rows,list) or
                {row.get("check") for row in rows if isinstance(row,dict) and
                 isinstance(row.get("check"),str)}!=expected or
                len(rows)!=len(expected)):
            issues.append(case_id+": contract mutation coverage incomplete/duplicate")
        else:
            for row in rows:
                side_effects_free(row,row.get("check","mutation"))
    elif case_id=="V1-030":
        rows=gate.get("lease_identity_mismatches")
        expected=set(spec["required_checks"])
        if (not isinstance(rows,list) or
                {row.get("field") for row in rows if isinstance(row,dict) and
                 isinstance(row.get("field"),str)}!=expected or
                len(rows)!=len(expected)):
            issues.append(case_id+": exact lease identity coverage incomplete/duplicate")
        else:
            for row in rows:
                side_effects_free(row,row.get("field","lease mismatch"))
    elif case_id=="V1-031":
        if gate.get("ticket_source")!="core_authenticated_https":
            issues.append(case_id+": ticket was not sourced from authenticated Core HTTPS")
        if gate.get("events")!=["claim","preflight"]:
            issues.append(case_id+": unexpected event after rejected preflight")
        side_effects_free(gate.get("end_to_end"),"malformed ticket end-to-end")
    return issues


def inbound_queue_evidence_issues(case_id, details):
    """Check evidence shape for authenticated, read-only inbound queue cases."""
    matrix=json.loads(MANIFEST.read_text(encoding="utf-8"))
    spec=next(case for case in matrix["additional_cases"] if case["id"]==case_id)
    queue=details.get("inbound_queue")
    if not isinstance(queue,dict):
        return [case_id+": inbound queue evidence missing"]
    issues=[]
    for field in ("api_trace_sha256","ui_trace_sha256","db_guard_trace_sha256"):
        if not HEX64.fullmatch(str(queue.get(field,""))):
            issues.append(case_id+": invalid/missing "+field)
    checks=queue.get("checks")
    if not isinstance(checks,dict) or any(checks.get(name) is not True
                                         for name in spec["required_checks"]):
        issues.append(case_id+": required acceptance checks incomplete/failed")

    if case_id=="V1-032":
        if queue.get("endpoint")!="/api/v1/inbound-review-items":
            issues.append(case_id+": wrong endpoint")
        if (queue.get("method")!="GET" or queue.get("unauthenticated_status")!=401 or
                queue.get("non_staff_status")!=403 or
                queue.get("authorized_bearer") is not True or
                queue.get("cache_control")!="no-store" or
                queue.get("query_parameters")!=[]):
            issues.append(case_id+": auth/no-store/tenant-neutral contract failed")
        expected_fields={"id","kind","mapped_customer","media_state",
                         "raw_event_sha256","received_at","status"}
        if set(queue.get("response_item_fields",[]))!=expected_fields:
            issues.append(case_id+": response is not exact metadata-only shape")
    elif case_id=="V1-033":
        scope=queue.get("tenant_scope")
        if not isinstance(scope,dict):
            issues.append(case_id+": tenant scope proof missing")
        else:
            returned=scope.get("returned_item_ids")
            own=scope.get("principal_shop_item_ids")
            foreign=scope.get("foreign_shop_item_ids")
            spoof_effect=scope.get("spoof_query_effect")
            if (scope.get("scope_source")!="authenticated_principal.shop_id" or
                    not isinstance(returned,list) or not isinstance(own,list) or
                    not isinstance(foreign,list) or not set(returned).issubset(set(own)) or
                    set(returned).intersection(set(foreign)) or
                    scope.get("spoof_query_status") not in (200,400) or
                    spoof_effect not in ("ignored","rejected") or
                    (scope.get("spoof_query_status")==200 and spoof_effect!="ignored") or
                    (scope.get("spoof_query_status")==400 and
                     (spoof_effect!="rejected" or returned))):
                issues.append(case_id+": principal shop scope/spoof query not proven")
    elif case_id=="V1-034":
        if set(queue.get("displayed_statuses",[]))!={"NEEDS_HUMAN"}:
            issues.append(case_id+": displayed NEEDS_HUMAN status missing")
        if set(queue.get("displayed_media_states",[]))!={"AWAITING_MEDIA"}:
            issues.append(case_id+": displayed AWAITING_MEDIA status missing")
        copy=queue.get("source_not_ready_copy")
        if (not isinstance(copy,str) or
                "tệp gốc chưa được lưu hoặc chưa sẵn sàng" not in copy):
            issues.append(case_id+": original file not-ready copy missing")
        if queue.get("visible_actions") not in ([],["refresh"]):
            issues.append(case_id+": queue exposes a non-read-only action")
    elif case_id=="V1-035":
        rows=queue.get("error_observations")
        expected={"network","401","503"}
        if (not isinstance(rows,list) or
                {row.get("condition") for row in rows if isinstance(row,dict)}!=expected or
                len(rows)!=len(expected) or
                any(row.get("old_rows_present") is not False or
                    row.get("visible_error") is not True for row in rows
                    if isinstance(row,dict))):
            issues.append(case_id+": stale rows/error state not verified for every failure")
    elif case_id=="V1-036":
        requests=queue.get("requests")
        if (not isinstance(requests,list) or not requests or
                any(not isinstance(req,dict) or req.get("method")!="GET" or
                    req.get("path")!="/api/v1/inbound-review-items" for req in requests)):
            issues.append(case_id+": queue performed a non-GET/non-queue request")
        before,after=queue.get("mutation_counts_before"),queue.get("mutation_counts_after")
        keys=("preview_reads","confirmations","approvals","print_jobs")
        if (not isinstance(before,dict) or not isinstance(after,dict) or
                any(type(before.get(key)) is not int or type(after.get(key)) is not int or
                    before.get(key)!=after.get(key) for key in keys)):
            issues.append(case_id+": preview/confirmation/approval/job counters changed")
    return issues


def word_review_evidence_issues(case_id, details):
    """Require exact-candidate evidence for Word review-only acceptance rows."""
    matrix=json.loads(WORD_REVIEW_MATRIX.read_text(encoding="utf-8"))
    spec=next(case for case in matrix["cases"] if case["id"]==case_id)
    proof=details.get("word_review")
    if not isinstance(proof,dict):
        return [case_id+": Word review evidence missing"]
    issues=[]
    for field in ("adapter_trace_sha256","source_request_trace_sha256",
                  "core_revision_trace_sha256"):
        if not HEX64.fullmatch(str(proof.get(field,""))):
            issues.append(case_id+": invalid/missing "+field)
    checks=proof.get("checks")
    if not isinstance(checks,dict) or any(checks.get(name) is not True
                                         for name in spec["required_checks"]):
        issues.append(case_id+": Word review acceptance checks incomplete/failed")
    expected_result="REVIEW_REQUIRED" if spec["expected"]=="REVIEW_REQUIRED" else "NEEDS_HUMAN"
    if proof.get("result")!=expected_result:
        issues.append(case_id+": unexpected Word review result")
    if (proof.get("ready") is not False or proof.get("allowed_to_print") is not False or
            proof.get("requires_staff_review") is not True or
            proof.get("physical_print_verified") is not False or
            proof.get("printout_calls")!=0 or proof.get("driver_send_calls")!=0):
        issues.append(case_id+": review-only/no-print invariants failed")

    if case_id=="V1-037":
        if (not HEX64.fullmatch(str(proof.get("expected_source_sha256",""))) or
                not HEX64.fullmatch(str(proof.get("observed_source_sha256",""))) or
                proof.get("expected_source_sha256")==proof.get("observed_source_sha256") or
                proof.get("word_launch_calls")!=0 or proof.get("artifact_count")!=0):
            issues.append(case_id+": source hash mismatch was not held before launch")
    elif case_id=="V1-038":
        if (not HEX64.fullmatch(str(proof.get("expected_request_hash",""))) or
                not HEX64.fullmatch(str(proof.get("observed_request_hash",""))) or
                proof.get("expected_request_hash")==proof.get("observed_request_hash") or
                proof.get("word_launch_calls")!=0 or proof.get("artifact_count")!=0):
            issues.append(case_id+": request hash mismatch was not held before launch")
    elif case_id=="V1-039":
        if (type(proof.get("active_revision")) is not int or
                type(proof.get("requested_revision")) is not int or
                proof.get("active_revision")==proof.get("requested_revision") or
                proof.get("reason_code") not in ("STALE_REVISION",
                                                   "CORE_EVIDENCE_OR_REVISION_UNVERIFIED") or
                proof.get("bundle_created") is not False):
            issues.append(case_id+": stale active revision was not held")
    elif case_id=="V1-040":
        if (proof.get("word_launch_enabled") is not False or
                proof.get("word_process_started") is not False or
                proof.get("reason_code")!="WORD_LAUNCH_NOT_AUTHORIZED"):
            issues.append(case_id+": default Word launch was not disabled")
    elif case_id=="V1-041":
        failures=proof.get("failure_observations")
        if (not isinstance(failures,list) or
                {row.get("kind") for row in failures if isinstance(row,dict)}!=
                    {"timeout","malformed"} or len(failures)!=2 or
                any(row.get("result")!="NEEDS_HUMAN" or
                    row.get("allowed_to_print") is not False or
                    row.get("word_process_cleaned") is not True or
                    row.get("artifact_count")!=0 for row in failures
                    if isinstance(row,dict))):
            issues.append(case_id+": timeout/malformed response did not fail closed")
    elif case_id=="V1-042":
        expected_source_sha=proof.get("expected_source_sha256")
        expected_request_hash=proof.get("expected_request_hash")
        active_revision=proof.get("active_revision")
        if (not HEX64.fullmatch(str(expected_source_sha or "")) or
                not HEX64.fullmatch(str(expected_request_hash or "")) or
                type(active_revision) is not int or active_revision < 1):
            issues.append(case_id+": missing/invalid source, request, or active-revision anchor")
        bundle=proof.get("bundle")
        if (not isinstance(bundle,dict) or bundle.get("status")!="REVIEW_REQUIRED" or
                bundle.get("ready") is not False or
                bundle.get("allowed_to_print") is not False or
                bundle.get("requires_staff_review") is not True or
                bundle.get("source_format")!="DOCX" or
                bundle.get("print_source_format")!="DOCX" or
                not HEX64.fullmatch(str(bundle.get("source_sha256") or "")) or
                bundle.get("source_sha256")!=expected_source_sha or
                type(bundle.get("revision")) is not int or
                bundle.get("revision")!=active_revision or
                bundle.get("request_hash")!=expected_request_hash or
                bundle.get("preview_pdf_used_as_print_source") is not False):
            issues.append(case_id+": DOCX native review bundle not safely bound/review-only")
        manifest=bundle.get("manifest") if isinstance(bundle,dict) else None
        files=manifest.get("files") if isinstance(manifest,dict) else None
        file_row=files[0] if isinstance(files,list) and len(files)==1 else None
        if (not isinstance(manifest,dict) or manifest.get("ready") is not False or
                manifest.get("allowed_to_print") is not False or
                manifest.get("requires_staff_review") is not True or
                type(manifest.get("revision")) is not int or
                manifest.get("revision")!=active_revision or
                manifest.get("request_hash")!=expected_request_hash or
                not isinstance(file_row,dict) or
                not HEX64.fullmatch(str(file_row.get("file_sha256") or "")) or
                file_row.get("file_sha256")!=proof.get("expected_source_sha256") or
                not str(file_row.get("source_artifact_ref","" )).lower().endswith(".docx")):
            issues.append(case_id+": review manifest is missing required DOCX/no-print flags")
    elif case_id=="V1-043":
        fake=proof.get("fake_observation")
        if (not isinstance(fake,dict) or fake.get("evidence_kind")!="injected_fake" or
                fake.get("native_word_verified") is not False or
                proof.get("bundle_created") is not False or
                proof.get("reason_code")!="WORD_NATIVE_EVIDENCE_UNVERIFIED"):
            issues.append(case_id+": synthetic observation could claim native success")
    return issues


def evaluate(artifact, expected_sha, zip_sha256, job_log, checkout_sha):
    if not HEX40.fullmatch(expected_sha):
        raise AssertionError("INVALID_CANDIDATE_SHA")
    if checkout_sha!=expected_sha:
        raise AssertionError("CHECKOUT_SHA_MISMATCH")
    payload=pathlib.Path(artifact).read_bytes()
    if not HEX64.fullmatch(zip_sha256) or hashlib.sha256(payload).hexdigest()!=zip_sha256:
        raise AssertionError("ARTIFACT_ZIP_SHA256_MISMATCH")
    log=pathlib.Path(job_log).read_text(encoding="utf-8")
    assert f"EXACT_V1_CANDIDATE_SHA={expected_sha}" in log, "EXACT_HEAD_LOG_MISSING"
    with zipfile.ZipFile(artifact) as z:
        names=set(z.namelist())
        assert names=={"v1-word-pdf.json","v1-word-pdf.tap"}, "MISSING_OR_EXTRA_ARTIFACT_FILES"
        report=json.loads(z.read("v1-word-pdf.json"))
        tap=z.read("v1-word-pdf.tap").decode("utf-8")
    assert report.get("schema")=="autoin.v1.word_pdf.acceptance.v1"
    assert report.get("product_commit_sha")==expected_sha
    assert report.get("checkout_sha")==expected_sha
    assert report.get("mode") in ("isolated_simulation","staging")
    assert report.get("oa_real") is False and report.get("physical_print") is False
    assert "TAP version 13" in tap and "1..1" in tap
    sentinels=[line[len("V1_ACCEPT_JSON "):] for line in tap.splitlines()
               if line.startswith("V1_ACCEPT_JSON ")]
    assert len(sentinels)==1 and json.loads(sentinels[0])==report, "TAP_JSON_MISMATCH"
    matrix=json.loads(MANIFEST.read_text(encoding="utf-8"))
    ticket_matrix=json.loads(TICKET_GATE_MATRIX.read_text(encoding="utf-8"))
    word_matrix=json.loads(WORD_REVIEW_MATRIX.read_text(encoding="utf-8"))
    expected_rows=[*matrix["cases"],*ticket_matrix["cases"],
                   *matrix.get("additional_cases",[]),*word_matrix["cases"]]
    expected={c["id"]:c for c in expected_rows}
    assert len(expected)==len(expected_rows), "DUPLICATE_EXPECTED_CASE_ID"
    inbound_ids={case["id"] for case in matrix.get("additional_cases",[])}
    word_review_ids={case["id"] for case in word_matrix["cases"]}
    tests=report.get("cases")
    assert isinstance(tests,list) and len(tests)==len(expected)
    assert len({row.get("id") for row in tests})==len(expected)
    assert set(row.get("id") for row in tests)==set(expected)
    issues=[]
    for row in tests:
        e=expected[row["id"]]
        if row.get("outcome")!=e["expected"] or row.get("status")!="PASS":
            issues.append(f'{row["id"]}: {row.get("status","MISSING")} / {row.get("outcome","MISSING")}')
            continue
        details=row.get("evidence")
        if not isinstance(details,dict) or details.get("source") not in ("real_pg_http","staging_signed","windows_verified"):
            issues.append(f'{row["id"]}: no authoritative product source')
            continue
        if row["id"] in inbound_ids:
            issues.extend(inbound_queue_evidence_issues(row["id"],details))
        elif row["id"] in word_review_ids:
            issues.extend(word_review_evidence_issues(row["id"],details))
            continue
        else:
            # Require explicit role/source/settings verification, no ungrounded
            # schema-level "pass": staging owns the original SQL/HTTP traces.
            for key in GATES:
                if key not in details:
                    issues.append(f'{row["id"]}: missing {key}')
            if not HEX64.fullmatch(str(details.get("source_sha256",""))):
                issues.append(f'{row["id"]}: invalid source sha')
            if not HEX64.fullmatch(str(details.get("settings_sha256",""))):
                issues.append(f'{row["id"]}: invalid settings SHA')
            for digest_field in ("manifest_sha256","renderer_sha256","plan_sha256",
                                 "printer_capability_sha256","evidence_sha256"):
                if not HEX64.fullmatch(str(details.get(digest_field,""))):
                    issues.append(f'{row["id"]}: invalid {digest_field}')
            if not HEX64.fullmatch(str(details.get("request_hash",""))):
                issues.append(f'{row["id"]}: invalid request hash')
            for phase in ("guards_before","guards_after"):
                guards=details.get(phase)
                if not isinstance(guards,dict) or any(not isinstance(guards.get(k),int) for k in COUNTS):
                    issues.append(f'{row["id"]}: missing {phase} DB counts')
            if e["expected"] in ("STALE","DENY","CONFLICT","HOLD","MANUAL"):
                pre=details.get("guards_before",{})
                post=details.get("guards_after",{})
                if isinstance(pre,dict) and isinstance(post,dict) and post.get("print_jobs")!=pre.get("print_jobs"):
                    issues.append(f'{row["id"]}: unauthorized print job mutation')
        if row["id"] in ("V1-025","V1-026","V1-027"):
            issues.extend(stale_digest_evidence_issues(row["id"],details))
        if row["id"] in {case["id"] for case in ticket_matrix["cases"]}:
            issues.extend(ticket_gate_evidence_issues(row["id"],details))
    assert report.get("status")=="PASS" and not issues, "BLOCKED_CASES: "+", ".join(issues[:24])
    assert "ok 1 - V1 Word/PDF exact candidate product acceptance" in tap
    return {"status":"PASS_CANDIDATE_ARTIFACT_CONSISTENCY_ONLY",
            "sha":expected_sha,"tested":len(tests),"counts":dict(Counter(row["outcome"] for row in tests)),
            "limits":"requires independent inspection of original real PG/agent traces; no OA/print claim"}


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--candidate-sha",required=True)
    ap.add_argument("--artifact",type=pathlib.Path,required=True)
    ap.add_argument("--zip-sha256",required=True)
    ap.add_argument("--job-log",type=pathlib.Path,required=True)
    args=ap.parse_args()
    try:
        git=subprocess.run(["git","rev-parse","HEAD"],cwd=ROOT,
            capture_output=True,text=True,timeout=5,check=True).stdout.strip()
        result=evaluate(args.artifact,args.candidate_sha,args.zip_sha256,args.job_log,git)
        print("V1_AUDIT_JSON "+json.dumps(result,sort_keys=True))
        return 0
    except (AssertionError,KeyError,TypeError,ValueError,OSError,
            subprocess.SubprocessError,zipfile.BadZipFile) as exc:
        print("V1_AUDIT_BLOCKED "+type(exc).__name__,file=sys.stderr)
        return 2


if __name__=="__main__":
    raise SystemExit(main())
