"""JSON stdin/stdout tests for the bounded native PDF preview route."""
from __future__ import annotations

import base64
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import fitz

from workers.documents import native_pdf_review_cli as cli
from workers.documents.bridge import _canonical

ROOT = Path(__file__).resolve().parents[3]
OUTPUT_KEYS = {
    "schema", "preview_schema", "status", "reason_code", "source_format",
    "print_source_format", "shop_id", "order_id", "active_revision",
    "request_hash", "source_sha256", "source_size_bytes",
    "input_manifest_sha256", "artifact_ref", "manifest_sha256",
    "preview_artifacts", "document_pages", "printed_faces", "physical_sheets",
    "requires_price_confirmation", "ready", "allowed_to_print",
    "allowed_to_simulate", "requires_staff_review", "physical_print_verified",
}


def _sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _snapshot_json() -> dict:
    with fitz.open() as document:
        page = document.new_page()
        page.draw_rect(fitz.Rect(20, 20, 100, 120))
        source = document.tobytes()
    source_ref = "bundle-1/source.pdf"
    manifest_ref = "bundle-1/manifest.json"
    request_data = {"documents": [{"artifact_name": source_ref, "copies": 2,
                                    "duplex": True, "paper": "A4"}]}
    request_hash = _sha(_canonical(request_data).encode("utf-8"))
    source_facts = {"format": "PDF", "artifact_ref": source_ref,
                    "sha256": _sha(source), "size_bytes": len(source)}
    manifest_bytes = json.dumps({
        "schema": "ai0.pdf_review_manifest.v1",
        "manifest_ref": manifest_ref,
        "shop_id": "shop-synthetic",
        "order_id": "order-synthetic",
        "active_revision": 3,
        "request_hash": request_hash,
        "source": source_facts,
    }, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return {
        "schema": "ai0.pdf_review_source.v1",
        "shop_id": "shop-synthetic",
        "order_id": "order-synthetic",
        "active_revision": 3,
        "request_hash": request_hash,
        "request_data": request_data,
        "source": source_facts,
        "manifest": {"ref": manifest_ref, "sha256": _sha(manifest_bytes)},
        "private_bytes": {
            "source_base64": base64.b64encode(source).decode("ascii"),
            "manifest_base64": base64.b64encode(manifest_bytes).decode("ascii"),
        },
    }


def _cli(root: Path, body: bytes) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-m", "workers.documents.native_pdf_review_cli",
         "--artifact-root", str(root)],
        cwd=ROOT, input=body, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        timeout=30, check=False,
    )


class NativePdfReviewCliTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def assert_no_print_authority(self, result: dict) -> None:
        self.assertIs(result["ready"], False)
        self.assertIs(result["allowed_to_print"], False)
        self.assertIs(result["allowed_to_simulate"], False)
        self.assertIs(result["requires_staff_review"], True)
        self.assertIs(result["physical_print_verified"], False)

    def test_valid_snapshot_emits_only_bounded_review_metadata(self):
        snapshot = _snapshot_json()
        request_bytes = json.dumps(snapshot, separators=(",", ":")).encode("utf-8")
        source_bytes = base64.b64decode(snapshot["private_bytes"]["source_base64"])
        result = _cli(self.root, request_bytes)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, b"")
        self.assertEqual(result.stdout.count(b"\n"), 1)
        output = json.loads(result.stdout)
        self.assertEqual(set(output), OUTPUT_KEYS)
        self.assertEqual(output["schema"], "ai3.native_pdf_review_cli.v1")
        self.assertEqual(output["status"], "REVIEW_REQUIRED", output)
        self.assertEqual(output["order_id"], "order-synthetic")
        self.assertEqual(output["active_revision"], 3)
        self.assertEqual(output["request_hash"], snapshot["request_hash"])
        self.assertEqual(output["source_sha256"], snapshot["source"]["sha256"])
        self.assertEqual(output["input_manifest_sha256"], snapshot["manifest"]["sha256"])
        self.assertGreaterEqual(output["document_pages"], 1)
        self.assertTrue(output["preview_artifacts"])
        self.assertTrue(all(set(item) == {"artifact_ref", "sha256", "size_bytes"}
                            for item in output["preview_artifacts"]))
        self.assertTrue((self.root / output["artifact_ref"]).is_file())
        self.assert_no_print_authority(output)

        # No request object, source bytes, encoded bytes, or filesystem root is
        # emitted. The only file locators are private relative artifact refs.
        self.assertNotIn(source_bytes, result.stdout)
        self.assertNotIn(snapshot["private_bytes"]["source_base64"].encode(), result.stdout)
        self.assertNotIn(snapshot["private_bytes"]["manifest_base64"].encode(), result.stdout)
        self.assertNotIn(str(self.root).encode(), result.stdout)
        self.assertNotIn(b"request_data", result.stdout)
        self.assertNotIn(b"bundle-1/source.pdf", result.stdout)
        self.assertLess(len(result.stdout), cli.MAX_OUTPUT_JSON_BYTES)

    def test_invalid_snapshot_is_parseable_and_stays_held(self):
        snapshot = _snapshot_json()
        snapshot["source"]["sha256"] = "0" * 64
        result = _cli(self.root, json.dumps(snapshot).encode("utf-8"))

        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stderr, b"")
        output = json.loads(result.stdout)
        self.assertEqual(output["status"], "NEEDS_HUMAN")
        self.assertEqual(output["reason_code"], "PDF_SOURCE_SNAPSHOT_UNVERIFIED")
        self.assertEqual(set(output), OUTPUT_KEYS)
        self.assertEqual(output["preview_artifacts"], [])
        self.assertIsNone(output["artifact_ref"])
        self.assertIsNone(output["manifest_sha256"])
        self.assert_no_print_authority(output)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_strict_shape_rejects_request_owned_artifact_root(self):
        snapshot = _snapshot_json()
        snapshot["artifact_root"] = str(self.root)
        output = cli.process_request(snapshot, artifact_root=str(self.root))

        self.assertEqual(output["status"], "NEEDS_HUMAN")
        self.assertEqual(output["reason_code"], "SOURCE_SNAPSHOT_SHAPE_INVALID")
        self.assertEqual(set(output), OUTPUT_KEYS)
        self.assertIsNone(output["artifact_ref"])
        self.assertNotIn(str(self.root), json.dumps(output))
        self.assert_no_print_authority(output)

    def test_duplicate_json_keys_are_rejected_with_one_json_line(self):
        result = _cli(self.root, b'{"schema":"ai0.pdf_review_source.v1",'
                      b'"schema":"ai0.pdf_review_source.v1"}')
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stderr, b"")
        self.assertEqual(result.stdout.count(b"\n"), 1)
        output = json.loads(result.stdout)
        self.assertEqual(output["reason_code"], "REQUEST_JSON_INVALID")
        self.assert_no_print_authority(output)

    def test_bad_base64_is_held_without_echoing_payload(self):
        snapshot = _snapshot_json()
        malformed = ["not-base64!", snapshot["private_bytes"]["source_base64"] + "\n"]
        for encoded in malformed:
            with self.subTest(encoded=encoded[:16]):
                request = dict(snapshot)
                request["private_bytes"] = {
                    **snapshot["private_bytes"], "source_base64": encoded}
                result = _cli(self.root, json.dumps(request).encode("utf-8"))
                self.assertEqual(result.returncode, 0)
                self.assertEqual(result.stderr, b"")
                output = json.loads(result.stdout)
                self.assertEqual(output["status"], "NEEDS_HUMAN")
                self.assertEqual(output["reason_code"], "SOURCE_BASE64_INVALID")
                self.assertNotIn(encoded.encode(), result.stdout + result.stderr)
                self.assert_no_print_authority(output)

    def test_source_and_manifest_size_caps_fail_closed(self):
        snapshot = _snapshot_json()
        # Shrink only the test-time guard to exercise the same pre-decode path
        # without constructing a 25 MiB fixture. Production constants remain
        # bound to processor.MAX_FILE (25 MiB) and 256 KiB.
        self.assertEqual(cli.MAX_SOURCE_BYTES, 25 * 1024 * 1024)
        self.assertEqual(cli.MAX_MANIFEST_BYTES, 256 * 1024)
        snapshot["private_bytes"]["source_base64"] = base64.b64encode(b"four").decode("ascii")
        with patch.object(cli, "MAX_SOURCE_BYTES", 3):
            output = cli.process_request(snapshot, artifact_root=str(self.root))
        self.assertEqual(output["status"], "NEEDS_HUMAN")
        self.assertEqual(output["reason_code"], "PRIVATE_BYTES_TOO_LARGE")
        self.assert_no_print_authority(output)

        snapshot = _snapshot_json()
        snapshot["private_bytes"]["manifest_base64"] = base64.b64encode(b"four").decode("ascii")
        with patch.object(cli, "MAX_MANIFEST_BYTES", 3):
            output = cli.process_request(snapshot, artifact_root=str(self.root))
        self.assertEqual(output["status"], "NEEDS_HUMAN")
        self.assertEqual(output["reason_code"], "PRIVATE_BYTES_TOO_LARGE")
        self.assert_no_print_authority(output)

    def test_json_stream_limit_is_bounded(self):
        with patch.object(cli, "MAX_REQUEST_JSON_BYTES", 3):
            output = cli.run_json_stream(io.BytesIO(b"1234"), artifact_root=str(self.root))
        self.assertEqual(output["status"], "NEEDS_HUMAN")
        self.assertEqual(output["reason_code"], "INPUT_TOO_LARGE")
        self.assert_no_print_authority(output)


if __name__ == "__main__":
    unittest.main()
