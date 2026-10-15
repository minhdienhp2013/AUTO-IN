"""AI3 CODE-403: two real sealed revisions for AI0 GET-stale-preview fixture.

No PostgreSQL/API stub here. AI0 owns real order/revision transitions and HTTP
409 assertion. This unit test proves the processor can produce both revision
artifacts with actual PNG pixels and immutable source/manifest digests.
"""
import hashlib
import io
import json

from PIL import Image

from workers.documents.bridge import SCHEMA, _canonical, process_request
from workers.documents.evidence_guard import verify_approved_evidence


def _request(copies):
    data = {"documents": [{"artifact_name": "synthetic.png",
                           "copies": copies, "paper": "A4", "duplex": False}]}
    return {"request_data": data, "expected_request_hash":
            hashlib.sha256(_canonical(data).encode("utf-8")).hexdigest()}


def _publication(input_root, artifact_root, revision, copies):
    answer = process_request(_request(copies), input_root=input_root,
                             artifact_root=artifact_root)
    assert answer["status"] == "READY", answer
    assert answer["schema"] == SCHEMA == "ai3.document_bridge.v1"
    plan = answer["plan"]
    assert plan["request_hash"] == _request(copies)["expected_request_hash"]
    manifest_bytes = (artifact_root / plan["artifact_ref"]).read_bytes()
    manifest = json.loads(manifest_bytes)
    assert manifest["schema"] == SCHEMA
    assert manifest["request_hash"] == plan["request_hash"]
    assert manifest["content_settings_sha256"] == answer["content_settings_sha256"]
    assert manifest["counts"]["physical_sheets"] == copies
    assert len(manifest["files"]) == len(manifest["previews"]) == 1

    frozen = manifest["files"][0]
    source_bytes = (artifact_root / frozen["source_artifact_ref"]).read_bytes()
    assert hashlib.sha256(source_bytes).hexdigest() == frozen["file_sha256"]
    assert frozen["size_bytes"] == len(source_bytes)
    assert frozen["source_artifact_ref"].startswith(plan["artifact_ref"].split("/")[0] + "/")

    preview = manifest["previews"][0]
    raster = (artifact_root / preview["ref"]).read_bytes()
    assert raster.startswith(b"\x89PNG\r\n\x1a\n")
    assert preview["bytes"] == len(raster)
    assert hashlib.sha256(raster).hexdigest() == preview["sha256"]
    assert preview["ref"].startswith(plan["artifact_ref"].split("/")[0] + "/")
    with Image.open(io.BytesIO(raster)) as pixels:
        assert pixels.format == "PNG"
        pixels.verify()

    trusted = {
        # AI0 must source these exact fields from authenticated PostgreSQL.
        "active_revision": revision, "approval_revision": revision,
        "request_hash": plan["request_hash"], "approval_id": "synthetic-only",
        "manifest_ref": plan["artifact_ref"],
        "manifest_sha256": hashlib.sha256(manifest_bytes).hexdigest(),
        "plan": plan,
    }
    check = verify_approved_evidence(trusted, artifact_root=artifact_root)
    assert check["status"] == "READY", check
    assert check["metadata"]["paper_verified"] is False
    return trusted, manifest, manifest_bytes, raster


def test_real_sealed_preview_old_revision_rejected_after_revision_advance(tmp_path):
    incoming, published = tmp_path / "incoming", tmp_path / "private-preview-artifacts"
    incoming.mkdir(mode=0o700)
    published.mkdir(mode=0o700)

    # Actual Pillow-encoded source; no stub manifest or faked raster.
    with Image.new("RGB", (320, 480), "white") as image:
        image.putpixel((12, 21), (245, 40, 60))
        image.save(incoming / "synthetic.png", format="PNG")

    old, old_manifest, old_bytes, old_png = _publication(
        incoming, published, revision=2, copies=1)
    new, new_manifest, _, _ = _publication(
        incoming, published, revision=3, copies=2)

    assert old["request_hash"] != new["request_hash"]
    assert old["manifest_sha256"] != new["manifest_sha256"]
    assert old["manifest_ref"] != new["manifest_ref"]
    assert old_manifest["files"][0]["file_sha256"] == new_manifest["files"][0]["file_sha256"]
    assert old_manifest["previews"][0]["sha256"] == new_manifest["previews"][0]["sha256"]
    assert old_manifest["paper_plan"][0]["copies"] == 1
    assert new_manifest["paper_plan"][0]["copies"] == 2

    # The old bytes remain intact (AI3 must not delete or rewrite them),
    # but a trusted active-revision change invalidates their approval proof.
    assert (published / old["manifest_ref"]).read_bytes() == old_bytes
    assert (published / old_manifest["previews"][0]["ref"]).read_bytes() == old_png
    stale = verify_approved_evidence(
        {**old, "active_revision": 3}, artifact_root=published)
    assert stale["status"] == "NEEDS_HUMAN"
    assert stale["reason_code"] == "STALE_REVISION"
    assert verify_approved_evidence(new, artifact_root=published)["status"] == "READY"

    # This is NOT an HTTP assertion: AI0 must mutate core_orders.active_revision
    # in isolated PostgreSQL and check GET old catalog/index yields
    # 409 STALE_OR_UNVERIFIED_PREVIEW on the REAL Fastify endpoint.
