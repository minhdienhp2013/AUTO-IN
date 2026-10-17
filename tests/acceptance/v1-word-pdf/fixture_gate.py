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
import struct
import sys
import xml.etree.ElementTree as ET
import zipfile
import zlib

ROOT=pathlib.Path(__file__).resolve().parents[3]
MANIFEST=ROOT/"tests/fixtures/public/v1-word-pdf/matrix.json"
FORMATS={"pdf","docx","png","jpg","xlsx","zip"}
STATUS={"PASS","STALE","ALLOW","DENY","ONE","CONFLICT","HOLD","MANUAL"}
VERSION="autoin.v1.word_pdf.acceptance.matrix.v1"


def manifest():
    data=json.loads(MANIFEST.read_text(encoding="utf-8"))
    assert data["schema"]==VERSION
    cases=data["cases"]
    assert len(cases)==24 and len({c["id"] for c in cases})==24
    assert len({c["key"] for c in cases})==24
    assert [c["id"] for c in cases]==[f"V1-{i:03d}" for i in range(1,25)]
    assert {c["expected"] for c in cases}==STATUS
    for case in cases:
        assert case["format"] in FORMATS
        assert case["observed"]=="NOT_RUN", "Do not predeclare product PASS"
    assert any(c["key"]=="word_native" for c in cases)
    assert all(c["tier"] in {"product","windows","agent"} for c in cases)
    return data


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
        # Minimal non-photo sentinel only; MUST route manual, never auto-print.
        return b"\xff\xd8\xff\xe0"+label.encode()+b"\xff\xd9"
    if kind=="docx":
        xml=(f'<?xml version="1.0" encoding="UTF-8"?>'
             f'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
             f'<w:body><w:p><w:r><w:t>{label}</w:t></w:r></w:p></w:body></w:document>').encode()
        return _zip({"[Content_Types].xml":b'<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
                     "_rels/.rels":b'<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
                     "word/document.xml":xml})
    if kind=="xlsx": return _zip({"xl/workbook.xml":b"<workbook/>"})
    if kind=="zip": return _zip({f"synthetic_{i:02d}.pdf":_pdf(label+str(i)) for i in range(6)})
    raise ValueError("unsupported synthetic kind")


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
    assert len(rows)==24 and len({r["source_sha256"] for r in rows})==24
    return {"schema":"autoin.v1.word_pdf.fixture.v1","mode":"fixture_only",
            "status":"FIXTURE_PASS_PRODUCT_NOT_RUN","count":24,"distinct_sha256":24,
            "source_candidate_sha":data["source_candidate_sha"],"cases":rows}


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
