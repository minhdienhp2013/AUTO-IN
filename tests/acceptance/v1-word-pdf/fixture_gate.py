"""AI5 V1-ACCEPTANCE-01 fixture-only Word/PDF and manual-routing controls.

Run: python tests/acceptance/v1-word-pdf/fixture_gate.py --check-fixture
     python -m pytest -q tests/acceptance/v1-word-pdf/test_fixture_gate.py
Do not call fixture PASS a product, Chromium, native Word, OA or print PASS.
"""
from __future__ import annotations
import argparse
import base64
import hashlib
import io
import json
import pathlib
import re
import subprocess
import struct
import sys
import xml.etree.ElementTree as ET
import zipfile
import zlib

ROOT=pathlib.Path(__file__).resolve().parents[3]
MANIFEST=ROOT/"tests/fixtures/public/v1-word-pdf/matrix.json"
TICKET_GATE_MATRIX=pathlib.Path(__file__).with_name("ticket_gate_matrix.json")
WORD_REVIEW_MATRIX=pathlib.Path(__file__).with_name("word_review_matrix.json")
FORMATS={"pdf","docx","png","jpg","xlsx","zip"}
STATUS={"PASS","STALE","ALLOW","DENY","ONE","CONFLICT","HOLD","MANUAL"}
VERSION="autoin.v1.word_pdf.acceptance.matrix.v1"


def manifest():
    data=json.loads(MANIFEST.read_text(encoding="utf-8"))
    assert data["schema"]==VERSION
    cases=data["cases"]
    assert len(cases)==27 and len({c["id"] for c in cases})==27
    assert len({c["key"] for c in cases})==27
    assert [c["id"] for c in cases]==[f"V1-{i:03d}" for i in range(1,28)]
    assert {c["expected"] for c in cases}==STATUS
    for case in cases:
        assert case["format"] in FORMATS
        assert case["observed"]=="NOT_RUN", "Do not predeclare product PASS"
    assert any(c["key"]=="word_native" for c in cases)
    assert all(c["tier"] in {"product","windows","agent"} for c in cases)
    return data


def ticket_gate_cases():
    """Additional product cases; separate from the 27 synthetic file fixtures."""
    data=json.loads(TICKET_GATE_MATRIX.read_text(encoding="utf-8"))
    assert data["schema"]=="autoin.v1.word_pdf.ticket_gate.matrix.v1"
    cases=data["cases"]
    assert [case["id"] for case in cases]==[f"V1-{i:03d}" for i in range(28,32)]
    assert all(case["expected"]=="HOLD" and case["observed"]=="NOT_RUN"
               for case in cases)
    assert len({case["key"] for case in cases})==4
    return data


def inbound_queue_cases():
    """Product acceptance rows for the metadata-only inbound staff queue."""
    data=manifest()
    cases=data.get("additional_cases")
    assert isinstance(cases,list)
    assert [case["id"] for case in cases]==[f"V1-{i:03d}" for i in range(32,37)]
    assert all(case["expected"]=="PASS" and case["observed"]=="NOT_RUN"
               for case in cases)
    assert len({case["key"] for case in cases})==5
    return cases


def word_review_cases():
    """Product acceptance overlays for native Word review-only behavior."""
    data=json.loads(WORD_REVIEW_MATRIX.read_text(encoding="utf-8"))
    assert data["schema"]=="autoin.v1.word_review.matrix.v1"
    assert data["source_contract"]=={
        "source":"ai0.word_review_source.v1",
        "input_manifest":"ai0.word_review_manifest.v1",
        "worker_result":"ai3.native_word_preview.v1",
        "ui_projection":"ai0.word_review_preview.v1",
        "contract_doc":"docs/architecture/V1_CORE_AGENT_EVIDENCE_CONTRACT_20261017.md",
    }
    cases=data["cases"]
    assert [case["id"] for case in cases]==[f"V1-{i:03d}" for i in range(37,59)]
    assert all(case["expected"] in {"HOLD","REVIEW_REQUIRED"} and
               case["observed"]=="NOT_RUN" for case in cases)
    assert len({case["key"] for case in cases})==len(cases)
    return data


def current_candidate_sha():
    """Bind fixture output to the checkout that actually ran the gate."""
    value=subprocess.run(["git","rev-parse","HEAD"],cwd=ROOT,
        capture_output=True,text=True,timeout=5,check=True).stdout.strip()
    assert re.fullmatch(r"[a-f0-9]{40}",value)
    return value


def _png(label):
    # Real PNG (20x20 RGB) with source-derived color; no file/network dependency.
    rgb=hashlib.sha256(label.encode()).digest()[:3]
    pixels=b"".join(b"\x00"+rgb*20 for _ in range(20))
    def chunk(tag,body):
        return struct.pack(">I",len(body))+tag+body+struct.pack(">I",zlib.crc32(tag+body)&0xffffffff)
    return (b"\x89PNG\r\n\x1a\n"+chunk(b"IHDR",struct.pack(">IIBBBBB",20,20,8,2,0,0,0))
            +chunk(b"tEXt",b"Comment\x00"+label.encode())
            +chunk(b"IDAT",zlib.compress(pixels))+chunk(b"IEND",b""))


def _pdf(label):
    safe=re.sub(r"[^A-Za-z0-9 _-]","",label)
    ops=f"BT /F1 12 Tf 40 760 Td ({safe}) Tj ET".encode("ascii")
    objects=[
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Length "+str(len(ops)).encode()+b" >>\nstream\n"+ops+b"\nendstream",
    ]
    parts=[b"%PDF-1.4\n"]; offset=[0]
    for i,obj in enumerate(objects,1):
        offset.append(sum(map(len,parts)))
        parts.append(str(i).encode()+b" 0 obj\n"+obj+b"\nendobj\n")
    start=sum(map(len,parts))
    parts.append(b"xref\n0 6\n0000000000 65535 f \n")
    parts.extend(f"{v:010d} 00000 n \n".encode() for v in offset[1:])
    parts.append(b"trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n"+str(start).encode()+b"\n%%EOF\n")
    return b"".join(parts)


def _zip(members):
    output=io.BytesIO()
    with zipfile.ZipFile(output,"w",compression=zipfile.ZIP_DEFLATED) as z:
        for key,val in sorted(members.items()):
            meta=zipfile.ZipInfo(key,date_time=(1980,1,1,0,0,0))
            meta.compress_type=zipfile.ZIP_DEFLATED
            z.writestr(meta,val)
    return output.getvalue()


def source(kind,label):
    if kind=="pdf":
        return _pdf(label)
    if kind in ("png","jpg"):
        if kind=="png": return _png(label)
        # A genuine small JPEG, generated locally; never a real ID photograph.
        from PIL import Image
        output=io.BytesIO()
        rgb=tuple(hashlib.sha256(label.encode()).digest()[:3])
        with Image.new("RGB",(20,20),rgb) as image:
            image.save(output,format="JPEG")
        return output.getvalue()
    if kind=="docx":
        xml=(f'<?xml version="1.0" encoding="UTF-8"?>'
             f'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
             f'<w:body><w:p><w:r><w:t>{label}</w:t></w:r></w:p></w:body></w:document>').encode()
        types=(b'<?xml version="1.0"?>'
          b'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
          b'<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
          b'<Default Extension="xml" ContentType="application/xml"/>'
          b'<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
          b'</Types>')
        rels=(b'<?xml version="1.0"?>'
          b'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
          b'<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
          b'</Relationships>')
        return _zip({"[Content_Types].xml":types,"_rels/.rels":rels,
                     "word/document.xml":xml})
    if kind=="xlsx": return _zip({"xl/workbook.xml":b"<workbook/>"})
    if kind=="zip": return _zip({f"synthetic_{i:02d}.pdf":_pdf(label+str(i)) for i in range(6)})
    raise ValueError("unsupported synthetic kind")



def canonical_sha256(value):
    """UTF-8 canonical JSON hash for fixture controls, never a Core authority."""
    return hashlib.sha256(json.dumps(
        value,ensure_ascii=False,sort_keys=True,separators=(",",":")
    ).encode("utf-8")).hexdigest()


def same_path_evidence_pairs():
    """Synthetic paired snapshots for V1-025..027; does not exercise Core.

    Preserve all resource paths, source bytes/settings/revision and replace exactly
    ONE attested digest component. Proves expected evidence hash MUST change,
    not that the integrated product blocks stale confirmations.
    """
    sample=source("pdf","PUBLIC-V1-ORIGINAL")
    source_digest=hashlib.sha256(sample).hexdigest()
    manifest_a=b'{"source":"public","page_count":1}'
    manifest_b=b'{"source":"public","page_count":2}'
    preview_a=b"PREVIEW-IMAGE-AA"
    preview_b=b"PREVIEW-IMAGE-BB"
    renderer_a=b"local-renderer-version-1"
    renderer_b=b"local-renderer-version-2"
    assert len(manifest_a)==len(manifest_b)
    assert len(preview_a)==len(preview_b)
    sources=[{"source_artifact_ref":"synthetic/shop/order/original.pdf",
        "format":"pdf","size_bytes":len(sample),"source_sha256":source_digest}]
    settings={"copies":1,"paper_size":"A4","duplex":False,"flip":"long_edge",
        "orientation":"portrait","range":"all","scale":"100","printer_id":"synthetic-no-print"}
    base={
        "schema":"ai0.print_evidence.v1",
        "shop_id":"autoin_test_v1", "order_id":"synthetic-order", "revision":2,
        "request_hash":hashlib.sha256(b"request-fixed").hexdigest(),
        "sources":sources,
        "source_set_sha256":canonical_sha256(sources),
        "settings_sha256":canonical_sha256(settings),
        "manifest_ref":"synthetic/shop/order/manifest.json",
        "manifest_sha256":hashlib.sha256(manifest_a).hexdigest(),
        "previews":[{"index":0,"bytes":len(preview_a),
                     "sha256":hashlib.sha256(preview_a).hexdigest()}],
        "renderer_sha256":hashlib.sha256(renderer_a).hexdigest(),
        "plan_sha256":canonical_sha256({"pages":1,"sheets":1}),
        "printer_id":"synthetic-no-print",
        "printer_capability_sha256":canonical_sha256({"ready":False,"format":"A4"}),
    }
    stable_locations={
        "source_artifact_ref":sources[0]["source_artifact_ref"],
        "manifest_ref":base["manifest_ref"],
        "preview_storage_path":"synthetic/shop/order/preview-0.png",
        "renderer_executable_path":"synthetic/bin/renderer",
        "preview_index":0,
    }
    import copy
    out=[]
    for case_id,key in (
        ("V1-025","manifest_sha256"),
        ("V1-026","previews[0].sha256"),
        ("V1-027","renderer_sha256"),
    ):
        before=copy.deepcopy(base)
        after=copy.deepcopy(base)
        if key=="manifest_sha256":
            after["manifest_sha256"]=hashlib.sha256(manifest_b).hexdigest()
        elif key=="previews[0].sha256":
            after["previews"][0]["sha256"]=hashlib.sha256(preview_b).hexdigest()
        elif key=="renderer_sha256":
            after["renderer_sha256"]=hashlib.sha256(renderer_b).hexdigest()
        else:
            raise AssertionError(key)
        before["evidence_sha256"]=canonical_sha256(before)
        after["evidence_sha256"]=canonical_sha256(after)
        assert before["evidence_sha256"]!=after["evidence_sha256"]
        assert before["sources"]==after["sources"]
        assert before["source_set_sha256"]==after["source_set_sha256"]
        assert before["settings_sha256"]==after["settings_sha256"]
        assert before["request_hash"]==after["request_hash"]
        assert before["revision"]==after["revision"]
        assert before["manifest_ref"]==after["manifest_ref"]
        assert before["previews"][0]["index"]==after["previews"][0]["index"]
        assert before["previews"][0]["bytes"]==after["previews"][0]["bytes"]
        changed=[
            k for k in before
            if k!="evidence_sha256" and before[k]!=after[k]
        ]
        assert changed==["previews" if key=="previews[0].sha256" else key]
        out.append({"id":case_id,"mutated_digest":key,
            "before":before,"after":after,
            "stable_locators_before":stable_locations.copy(),
            "stable_locators_after":stable_locations.copy(),
            "product_status":"NOT_RUN"})
    return out

def fixture_result():
    data=manifest()
    rows=[]
    for c in data["cases"]:
        raw=source(c["format"],c["id"])
        digest=hashlib.sha256(raw).hexdigest()
        assert len(raw)>10
        if c["format"] in ("docx","xlsx","zip"):
            with zipfile.ZipFile(io.BytesIO(raw)) as z:
                if c["format"]=="docx":
                    assert "word/document.xml" in z.namelist()
                    ET.fromstring(z.read("word/document.xml"))
                if c["format"]=="zip": assert len(z.namelist())==6
        elif c["format"]=="pdf":
            assert raw.startswith(b"%PDF-") and b"startxref" in raw
        elif c["format"]=="png":
            assert raw.startswith(b"\x89PNG\r\n\x1a\n")
        rows.append({"id":c["id"],"format":c["format"],"source_sha256":digest,
                     "expected":c["expected"],"product_status":"NOT_RUN"})
    assert len(rows)==27 and len({r["source_sha256"] for r in rows})==27
    pairs=same_path_evidence_pairs()
    assert len(pairs)==3 and all(x["product_status"]=="NOT_RUN" for x in pairs)
    return {"schema":"autoin.v1.word_pdf.fixture.v1","mode":"fixture_only",
            "status":"FIXTURE_PASS_PRODUCT_NOT_RUN","count":27,"distinct_sha256":27,
            "source_candidate_sha":current_candidate_sha(),"cases":rows,
            "product_acceptance_cases":[*ticket_gate_cases()["cases"],*inbound_queue_cases(),
                                         *word_review_cases()["cases"]],
            "same_path_digest_controls":pairs}


def main():
    arg=argparse.ArgumentParser()
    arg.add_argument("--check-fixture",action="store_true")
    arg.add_argument("--json-out",type=pathlib.Path)
    a=arg.parse_args()
    try: res=fixture_result()
    except Exception as e:
        print("V1_FIXTURE_FAIL "+type(e).__name__,file=sys.stderr)
        return 2
    text=json.dumps(res,ensure_ascii=False,sort_keys=True)
    if a.json_out:
        a.json_out.parent.mkdir(parents=True,exist_ok=True)
        a.json_out.write_text(text+"\n",encoding="utf-8")
    print("V1_FIXTURE_JSON "+text)
    print("TAP version 13\nok 1 - V1 Word/PDF synthetic fixture selfcheck # SKIP product/OA/Word-native\n1..1")
    return 0


if __name__=="__main__":
    raise SystemExit(main())
