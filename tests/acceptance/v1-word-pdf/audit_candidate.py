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
HEX40=re.compile(r"[a-f0-9]{40}\Z")
HEX64=re.compile(r"[a-f0-9]{64}\Z")
GATES=("source_sha256","settings_digest","request_hash","revision")
COUNTS=("confirmations","approvals","print_jobs")


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
    expected={c["id"]:c for c in matrix["cases"]}
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
        # Require explicit role/source/settings verification, no ungrounded
        # schema-level "pass": staging owns the original SQL/HTTP traces.
        for key in GATES:
            if key not in details:
                issues.append(f'{row["id"]}: missing {key}')
        if not HEX64.fullmatch(str(details.get("source_sha256",""))):
            issues.append(f'{row["id"]}: invalid source sha')
        if not HEX64.fullmatch(str(details.get("settings_digest",""))):
            issues.append(f'{row["id"]}: invalid settings digest')
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
    except (AssertionError,ValueError,OSError,subprocess.SubprocessError,zipfile.BadZipFile) as exc:
        print("V1_AUDIT_BLOCKED "+type(exc).__name__,file=sys.stderr)
        return 2


if __name__=="__main__":
    raise SystemExit(main())
