"""Strict stdin/stdout contract tests; never simulate a successful Word render."""
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
import zipfile

from workers.documents import native_word_review_cli as cli
from workers.documents.bridge import _canonical

ROOT = Path(__file__).resolve().parents[3]
OUTPUT_KEYS = {
    "schema", "preview_schema", "status", "reason_code", "source_format",
    "print_source_format", "shop_id", "order_id", "active_revision",
    "request_hash", "source_sha256", "source_size_bytes",
    "input_manifest_sha256", "artifact_ref", "manifest_sha256",
    "settings_sha256", "preview_artifacts", "document_pages", "printed_faces",
    "physical_sheets", "requires_price_confirmation", "renderer_identity",
    "native_word_verified", "ready", "allowed_to_print", "allowed_to_simulate",
    "requires_staff_review", "physical_print_verified",
}


def _sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _docx() -> bytes:
    """A synthetic DOCX package for input validation only; it is never rendered."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("[Content_Types].xml", "<Types/>")
        archive.writestr("word/document.xml", "<document/>")
    return buffer.getvalue()


def _snapshot_json() -> dict:
    source = _docx()
    source_ref = "bundle-1/source.docx"
    manifest_ref = "bundle-1/manifest.json"
    request_data = {"documents": [{"artifact_name": source_ref, "copies": 1,
                                    "duplex": False, "paper": "A4"}]}
    request_hash = _sha(_canonical(request_data).encode("utf-8"))
    source_facts = {"format": "DOCX", "artifact_ref": source_ref,
                    "sha256": _sha(source), "size_bytes": len(source)}
    manifest_bytes = json.dumps({
        "schema": "ai0.word_review_manifest.v1",
        "manifest_ref": manifest_ref,
        "shop_id": "shop-synthetic",
        "order_id": "order-synthetic",
        "active_revision": 2,
        "request_hash": request_hash,
        "source": source_facts,
    }, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return {
        "schema": "ai0.word_review_source.v1",
        "shop_id": "shop-synthetic",
        "order_id": "order-synthetic",
        "active_revision": 2,
        "request_hash": request_hash,
        "request_data": request_data,
        "source": source_facts,
        "manifest": {"ref": manifest_ref, "sha256": _sha(manifest_bytes)},
        "private_bytes": {
            "source_base64": base64.b64encode(source).decode("ascii"),
            "manifest_base64": base64.b64encode(manifest_bytes).decode("ascii"),
        },
    }


def _cli(root: Path, body: bytes, *, allow_word_launch: bool = False
         ) -> subprocess.CompletedProcess:
    command = [sys.executable, "-m", "workers.documents.native_word_review_cli",
               "--artifact-root", str(root)]
    if allow_word_launch:
        command.append("--allow-word-launch")
    return subprocess.run(command, cwd=ROOT, input=body, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, timeout=30, check=False)


class NativeWordReviewCliTests(unittest.TestCase):
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

    def test_cli_defaults_to_no_word_launch_and_emits_one_safe_json_line(self):
        snapshot = _snapshot_json()
        source_bytes = base64.b64decode(snapshot["private_bytes"]["source_base64"])
        manifest_bytes = base64.b64decode(snapshot["private_bytes"]["manifest_base64"])
        result = _cli(self.root, json.dumps(snapshot, separators=(",", ":")).encode())

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, b"")
        self.assertEqual(result.stdout.count(b"\n"), 1)
        output = json.loads(result.stdout)
        self.assertEqual(set(output), OUTPUT_KEYS)
        self.assertEqual(output["schema"], "ai3.native_word_review_cli.v1")
        self.assertEqual(output["preview_schema"], "ai3.native_word_preview.v1")
        self.assertEqual(output["status"], "NEEDS_HUMAN")
        self.assertEqual(output["reason_code"], "WORD_LAUNCH_NOT_AUTHORIZED")
        self.assertEqual(output["shop_id"], snapshot["shop_id"])
        self.assertEqual(output["order_id"], snapshot["order_id"])
        self.assertEqual(output["active_revision"], snapshot["active_revision"])
        self.assertEqual(output["request_hash"], snapshot["request_hash"])
        self.assertEqual(output["source_sha256"], snapshot["source"]["sha256"])
        self.assertEqual(output["input_manifest_sha256"], snapshot["manifest"]["sha256"])
        self.assertEqual(output["preview_artifacts"], [])
        self.assertIsNone(output["artifact_ref"])
        self.assertIsNone(output["manifest_sha256"])
        self.assert_no_print_authority(output)
        self.assertEqual(list(self.root.iterdir()), [])

        # No input bytes, base64 payloads, customer request or configured root
        # are reflected to stdout/stderr. Source locator is private too.
        for secret in (source_bytes, manifest_bytes,
                       snapshot["private_bytes"]["source_base64"].encode(),
                       snapshot["private_bytes"]["manifest_base64"].encode(),
                       b"bundle-1/source.docx", b"request_data", str(self.root).encode()):
            self.assertNotIn(secret, result.stdout + result.stderr)
        self.assertLess(len(result.stdout), cli.MAX_OUTPUT_JSON_BYTES)

    @unittest.skipIf(sys.platform == "win32", "never launch Word from a unit test")
    def test_explicit_word_flag_on_non_windows_host_stays_held_without_artifacts(self):
        snapshot = _snapshot_json()
        result = _cli(self.root, json.dumps(snapshot).encode(), allow_word_launch=True)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, b"")
        self.assertEqual(result.stdout.count(b"\n"), 1)
        output = json.loads(result.stdout)
        self.assertEqual(set(output), OUTPUT_KEYS)
        self.assertEqual(output["status"], "NEEDS_HUMAN")
        self.assertEqual(output["reason_code"], "WORD_WINDOWS_NOT_AVAILABLE")
        self.assert_no_print_authority(output)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_json_cannot_enable_word_or_choose_artifact_root(self):
        for injected in ({"allow_word_launch": True}, {"artifact_root": str(self.root)}):
            snapshot = {**_snapshot_json(), **injected}
            output = cli.process_request(snapshot, artifact_root=str(self.root))
            self.assertEqual(output["status"], "NEEDS_HUMAN")
            self.assertEqual(output["reason_code"], "SOURCE_SNAPSHOT_SHAPE_INVALID")
            self.assertEqual(set(output), OUTPUT_KEYS)
            self.assert_no_print_authority(output)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_duplicate_keys_and_nonfinite_json_are_rejected(self):
        for payload in (b'{"schema":"ai0.word_review_source.v1",'
                        b'"schema":"ai0.word_review_source.v1"}', b'{"n":NaN}'):
            result = _cli(self.root, payload)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(result.stderr, b"")
            self.assertEqual(result.stdout.count(b"\n"), 1)
            output = json.loads(result.stdout)
            self.assertEqual(output["reason_code"], "REQUEST_JSON_INVALID")
            self.assertEqual(set(output), OUTPUT_KEYS)
            self.assert_no_print_authority(output)

    def test_duplicate_manifest_keys_are_rejected_by_word_source_adapter(self):
        snapshot = _snapshot_json()
        manifest = base64.b64decode(snapshot["private_bytes"]["manifest_base64"])
        duplicate = manifest.replace(b'"schema":', b'"schema":"unexpected","schema":', 1)
        snapshot["manifest"]["sha256"] = _sha(duplicate)
        snapshot["private_bytes"]["manifest_base64"] = base64.b64encode(duplicate).decode()
        result = _cli(self.root, json.dumps(snapshot).encode())

        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stderr, b"")
        self.assertEqual(result.stdout.count(b"\n"), 1)
        output = json.loads(result.stdout)
        self.assertEqual(output["status"], "NEEDS_HUMAN")
        self.assertEqual(output["reason_code"], "WORD_SOURCE_SNAPSHOT_UNVERIFIED")
        self.assertEqual(set(output), OUTPUT_KEYS)
        self.assert_no_print_authority(output)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_bad_base64_is_held_without_echoing_payload(self):
        snapshot = _snapshot_json()
        malformed = ["not-base64!", snapshot["private_bytes"]["source_base64"] + "\n"]
        for encoded in malformed:
            with self.subTest(encoded=encoded[:16]):
                snapshot["private_bytes"]["source_base64"] = encoded
                body = json.dumps(snapshot).encode("utf-8")
                result = _cli(self.root, body)
                self.assertEqual(result.returncode, 0)
                self.assertEqual(result.stderr, b"")
                output = json.loads(result.stdout)
                self.assertEqual(output["status"], "NEEDS_HUMAN")
                self.assertEqual(output["reason_code"], "SOURCE_BASE64_INVALID")
                self.assertNotIn(encoded.encode(), result.stdout + result.stderr)
                self.assert_no_print_authority(output)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_source_and_manifest_size_caps_fail_closed(self):
        snapshot = _snapshot_json()
        self.assertEqual(cli.MAX_SOURCE_BYTES, 25 * 1024 * 1024)
        self.assertEqual(cli.MAX_MANIFEST_BYTES, 256 * 1024)

        snapshot["private_bytes"]["source_base64"] = base64.b64encode(b"four").decode()
        with patch.object(cli, "MAX_SOURCE_BYTES", 3):
            output = cli.process_request(snapshot, artifact_root=str(self.root))
        self.assertEqual(output["reason_code"], "PRIVATE_BYTES_TOO_LARGE")
        self.assert_no_print_authority(output)

        snapshot = _snapshot_json()
        snapshot["private_bytes"]["manifest_base64"] = base64.b64encode(b"four").decode()
        with patch.object(cli, "MAX_MANIFEST_BYTES", 3):
            output = cli.process_request(snapshot, artifact_root=str(self.root))
        self.assertEqual(output["reason_code"], "PRIVATE_BYTES_TOO_LARGE")
        self.assert_no_print_authority(output)

    def test_json_stream_limit_is_bounded(self):
        with patch.object(cli, "MAX_REQUEST_JSON_BYTES", 3):
            output = cli.run_json_stream(io.BytesIO(b"1234"), artifact_root=str(self.root))
        self.assertEqual(output["status"], "NEEDS_HUMAN")
        self.assertEqual(output["reason_code"], "INPUT_TOO_LARGE")
        self.assertEqual(set(output), OUTPUT_KEYS)
        self.assert_no_print_authority(output)

    def test_word_adapter_exception_never_echoes_paths_or_source_text(self):
        snapshot = _snapshot_json()
        secret = "do-not-return /private/customer/source.docx"
        with patch.object(cli, "prepare_native_word_review_from_snapshot",
                          side_effect=RuntimeError(secret)):
            output = cli.process_request(snapshot, artifact_root=str(self.root))
        encoded = json.dumps(output)
        self.assertEqual(output["status"], "NEEDS_HUMAN")
        self.assertEqual(output["reason_code"], "WORD_PREVIEW_UNVERIFIED")
        self.assertNotIn(secret, encoded)
        self.assertNotIn(str(self.root), encoded)
        self.assertEqual(set(output), OUTPUT_KEYS)
        self.assert_no_print_authority(output)

    def test_missing_artifact_root_configuration_is_held(self):
        output = cli.process_request(_snapshot_json(), artifact_root="")
        self.assertEqual(output["reason_code"], "ARTIFACT_ROOT_CONFIGURATION_REQUIRED")
        self.assertEqual(set(output), OUTPUT_KEYS)
        self.assert_no_print_authority(output)

        invalid_config = subprocess.run(
            [sys.executable, "-m", "workers.documents.native_word_review_cli",
             "--artifact-root", str(self.root), "--unexpected-secret-path"],
            cwd=ROOT, input=b"{}", stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            timeout=30, check=False)
        self.assertEqual(invalid_config.returncode, 0)
        self.assertEqual(invalid_config.stderr, b"")
        self.assertEqual(invalid_config.stdout.count(b"\n"), 1)
        output = json.loads(invalid_config.stdout)
        self.assertEqual(output["reason_code"], "CLI_CONFIGURATION_INVALID")
        self.assertNotIn(b"--unexpected-secret-path", invalid_config.stdout)
        self.assertEqual(set(output), OUTPUT_KEYS)
        self.assert_no_print_authority(output)

        result = subprocess.run(
            [sys.executable, "-m", "workers.documents.native_word_review_cli"],
            cwd=ROOT, input=b"{}", stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            timeout=30, check=False)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stderr, b"")
        self.assertEqual(result.stdout.count(b"\n"), 1)
        output = json.loads(result.stdout)
        self.assertEqual(output["reason_code"], "ARTIFACT_ROOT_CONFIGURATION_REQUIRED")
        self.assertEqual(set(output), OUTPUT_KEYS)
        self.assert_no_print_authority(output)


if __name__ == "__main__":
    unittest.main()
