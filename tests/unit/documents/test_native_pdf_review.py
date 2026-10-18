"""AI0 private PDF source contract: review-only; never a print authorization."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import fitz

from workers.documents.bridge import _canonical
import workers.documents.native_pdf_artifacts as artifacts
import workers.documents.native_pdf_review as review


def _sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _pdf(*, encrypted: bool = False) -> bytes:
    with fitz.open() as document:
        page = document.new_page()
        page.draw_rect(fitz.Rect(20, 20, 100, 120))
        if encrypted:
            return document.tobytes(encryption=fitz.PDF_ENCRYPT_AES_256,
                                    owner_pw="test-owner", user_pw="test-user")
        return document.tobytes()


def _snapshot(*, source: bytes | None = None, request: dict | None = None,
              manifest_raw: bytes | None = None,
              source_ref: str = "bundle-123/source.pdf",
              manifest_ref: str = "bundle-123/manifest.json") -> dict:
    source = source if source is not None else _pdf()
    request = request if request is not None else {"documents": [{
        "artifact_name": source_ref, "copies": 2, "duplex": True, "paper": "A4"}]}
    request_hash = _sha(_canonical(request).encode("utf-8"))
    source_facts = {"format": "PDF", "artifact_ref": source_ref,
                    "sha256": _sha(source), "size_bytes": len(source)}
    if manifest_raw is None:
        manifest_raw = json.dumps({"schema": "ai0.pdf_review_manifest.v1",
            "manifest_ref": manifest_ref, "shop_id": "shop-1", "order_id": "order-1",
            "active_revision": 7, "request_hash": request_hash, "source": source_facts},
            separators=(",", ":")).encode("utf-8")
    return {"schema": "ai0.pdf_review_source.v1", "shop_id": "shop-1",
        "order_id": "order-1", "active_revision": 7, "request_hash": request_hash,
        "request_data": request, "source": source_facts,
        "manifest": {"ref": manifest_ref, "sha256": _sha(manifest_raw)},
        "private_bytes": {"source": source, "manifest": manifest_raw}}


class NativePdfReviewTests(unittest.TestCase):
    def run_snapshot(self, snapshot: dict, root: Path) -> dict:
        return review.prepare_native_pdf_review_from_snapshot(snapshot=snapshot,
                                                              artifact_root=root)

    def assert_held_without_artifacts(self, snapshot: dict) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            result = self.run_snapshot(snapshot, root)
            self.assertEqual(result["status"], "NEEDS_HUMAN", result)
            self.assertIs(result["ready"], False)
            self.assertIs(result["allowed_to_print"], False)
            self.assertIs(result["requires_staff_review"], True)
            self.assertIs(result["physical_print_verified"], False)
            self.assertEqual(list(root.iterdir()), [])

    def test_verified_snapshot_returns_anchored_review_only_bundle(self):
        snapshot = _snapshot()
        request_data_before = json.loads(json.dumps(snapshot["request_data"]))
        request_hash_before = _sha(_canonical(snapshot["request_data"]).encode("utf-8"))
        source = snapshot["private_bytes"]["source"]
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            result = self.run_snapshot(snapshot, root)
            self.assertEqual(result["schema"], "ai3.native_pdf_preview.v1")
            self.assertEqual(result["status"], "REVIEW_REQUIRED", result)
            self.assertEqual((result["shop_id"], result["order_id"]), ("shop-1", "order-1"))
            self.assertEqual(result["active_revision"], 7)
            self.assertEqual(result["request_hash"], snapshot["request_hash"])
            self.assertEqual(snapshot["request_data"], request_data_before)
            self.assertEqual(snapshot["request_hash"], request_hash_before)
            self.assertEqual(result["source"], snapshot["source"])
            self.assertEqual(result["input_manifest"], snapshot["manifest"])
            self.assertEqual(result["source_sha256"], _sha(source))
            self.assertEqual(result["document_pages"], 1)
            self.assertEqual(result["printed_faces"], 2)
            self.assertEqual(result["physical_sheets"], 2)
            self.assertIs(result["ready"], False)
            self.assertIs(result["allowed_to_print"], False)
            self.assertIs(result["requires_staff_review"], True)
            self.assertIs(result["physical_print_verified"], False)
            self.assertNotIn("private_bytes", result)
            self.assertNotIn(source.decode("latin-1"), json.dumps(result, ensure_ascii=True))

            raw_manifest = (root / result["artifact_ref"]).read_bytes()
            self.assertEqual(_sha(raw_manifest), result["manifest_sha256"])
            manifest = json.loads(raw_manifest)
            self.assertEqual(manifest["schema"], "ai3.native_pdf_preview.v1")
            self.assertEqual(manifest["status"], "REVIEW_REQUIRED")
            self.assertEqual(manifest["settings_sha256"], _sha(_canonical({
                "copies": 2, "duplex": True, "paper": "A4"}).encode("utf-8")))
            plan = manifest["paper_plan"][0]
            self.assertEqual((plan["copies"], plan["duplex"], plan["paper"]),
                             (2, True, "A4"))
            self.assertEqual(manifest["source"], snapshot["source"])
            self.assertEqual(manifest["input_manifest"], snapshot["manifest"])
            self.assertEqual(manifest["active_revision"], 7)
            self.assertEqual(manifest["request_hash"], snapshot["request_hash"])
            self.assertIs(manifest["ready"], False)
            self.assertIs(manifest["allowed_to_print"], False)
            source_ref = manifest["files"][0]["source_artifact_ref"]
            self.assertEqual((root / source_ref).read_bytes(), source)
            self.assertEqual(manifest["files"][0]["file_sha256"], _sha(source))
            self.assertEqual(len(manifest["previews"]), 1)
            preview = manifest["previews"][0]
            preview_bytes = (root / preview["ref"]).read_bytes()
            self.assertTrue(preview_bytes.startswith(b"\x89PNG\r\n\x1a\n"))
            self.assertEqual(preview["sha256"], _sha(preview_bytes))

    def test_source_scope_manifest_and_request_mutations_fail_closed(self):
        mutations = [
            lambda value: value["private_bytes"].update(source=b"changed"),
            lambda value: value.update(active_revision=8),
            lambda value: value["source"].update(sha256="0" * 64),
            lambda value: value["source"].update(size_bytes=value["source"]["size_bytes"] + 1),
            lambda value: value["manifest"].update(ref="other/manifest.json"),
            lambda value: value["request_data"]["documents"][0].update(copies=3),
            lambda value: value["private_bytes"].update(source=[*value["private_bytes"]["source"]]),
        ]
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                snapshot = _snapshot()
                mutate(snapshot)
                self.assert_held_without_artifacts(snapshot)

    def test_duplicate_keys_manifest_binding_and_cross_bundle_refs_fail_closed(self):
        valid = _snapshot()
        duplicate = valid["private_bytes"]["manifest"].replace(
            b'"schema":', b'"schema":"unexpected","schema":', 1)
        snapshots = [
            _snapshot(manifest_raw=duplicate),
            _snapshot(manifest_raw=valid["private_bytes"]["manifest"].replace(
                b'"order-1"', b'"other-order"', 1)),
            _snapshot(source_ref="different-bundle/source.pdf"),
            _snapshot(source_ref="bundle-123/../source.pdf"),
            _snapshot(source_ref="https://example.test/source.pdf"),
            _snapshot(source_ref="bundle-123/nested/source.pdf"),
            _snapshot(source_ref="bundle-123/source.pdf?download=1"),
        ]
        for snapshot in snapshots:
            with self.subTest(ref=snapshot["source"]["artifact_ref"]):
                self.assert_held_without_artifacts(snapshot)

    def test_unsupported_multiple_or_non_pdf_request_is_held(self):
        requests = [
            {"documents": [
                {"artifact_name": "bundle-123/source.pdf", "copies": 1, "duplex": False, "paper": "A4"},
                {"artifact_name": "bundle-123/source.pdf", "copies": 1, "duplex": False, "paper": "A4"}]},
            {"documents": [{"artifact_name": "bundle-123/source.docx", "copies": 1,
                            "duplex": False, "paper": "A4"}]},
            {"files": [{"artifact_name": "source.pdf"}]},
        ]
        for request in requests:
            with self.subTest(request=request):
                self.assert_held_without_artifacts(_snapshot(request=request))

    def test_request_source_and_settings_must_match_verified_core_contract(self):
        wrong_source = {"documents": [{
            "artifact_name": "bundle-123/other.pdf", "copies": 2,
            "duplex": True, "paper": "A4"}]}
        snapshot = _snapshot(request=wrong_source)
        with tempfile.TemporaryDirectory() as temp:
            result = self.run_snapshot(snapshot, Path(temp))
            self.assertEqual(result["status"], "NEEDS_HUMAN", result)
            self.assertEqual(result["reason_code"], "PDF_REQUEST_SOURCE_MISMATCH")
            self.assertIs(result["ready"], False)
            self.assertIs(result["allowed_to_print"], False)
            self.assertIs(result["requires_staff_review"], True)
            self.assertIs(result["physical_print_verified"], False)
            self.assertEqual(list(Path(temp).iterdir()), [])

        invalid_requests = [
            ({"documents": [{"artifact_name": "bundle-123/source.pdf", "copies": True,
                             "duplex": True, "paper": "A4"}]}, "PDF_REQUEST_SETTINGS_INVALID"),
            ({"documents": [{"artifact_name": "bundle-123/source.pdf", "copies": 0,
                             "duplex": True, "paper": "A4"}]}, "PDF_REQUEST_SETTINGS_INVALID"),
            ({"documents": [{"artifact_name": "bundle-123/source.pdf", "copies": 2,
                             "duplex": 1, "paper": "A4"}]}, "PDF_REQUEST_SETTINGS_INVALID"),
            ({"documents": [{"artifact_name": "bundle-123/source.pdf", "copies": 2,
                             "duplex": True, "paper": "Letter"}]}, "PDF_REQUEST_SETTINGS_INVALID"),
            ({"documents": [{"artifact_name": "bundle-123/source.pdf", "copies": 2,
                             "duplex": True, "paper": "A4", "unknown": "value"}]},
             "PDF_REQUEST_SHAPE_UNSUPPORTED"),
            ({"documents": [{"artifact_name": "bundle-123/source.pdf", "copies": 2,
                             "duplex": True}]}, "PDF_REQUEST_SHAPE_UNSUPPORTED"),
            ({"documents": [{"artifact_name": "bundle-123/source.pdf", "copies": 2,
                             "duplex": True, "paper": "A4"}], "settings": {"paper": "A3"}},
             "PDF_REQUEST_SHAPE_UNSUPPORTED"),
        ]
        for request, expected_reason in invalid_requests:
            with self.subTest(request=request):
                with tempfile.TemporaryDirectory() as temp:
                    result = self.run_snapshot(_snapshot(request=request), Path(temp))
                    self.assertEqual(result["status"], "NEEDS_HUMAN", result)
                    self.assertEqual(result["reason_code"], expected_reason)
                    self.assertIs(result["ready"], False)
                    self.assertIs(result["allowed_to_print"], False)
                    self.assertIs(result["requires_staff_review"], True)
                    self.assertIs(result["physical_print_verified"], False)
                    self.assertEqual(list(Path(temp).iterdir()), [])

    def test_encrypted_pdf_and_uncertain_fonts_are_routed_to_staff(self):
        self.assert_held_without_artifacts(_snapshot(source=_pdf(encrypted=True)))
        with patch.object(artifacts, "_pdf_font_reliable", return_value=False):
            self.assert_held_without_artifacts(_snapshot())

    def test_renderer_failure_cleans_partial_private_bundle(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with patch.object(artifacts.processor, "_inspect_data",
                              return_value={"status": "NEEDS_HUMAN", "reason_code": "PDF_RENDER_FAILED"}) as inspect:
                result = self.run_snapshot(_snapshot(), root)
            self.assertEqual(result["status"], "NEEDS_HUMAN")
            inspect.assert_called_once()
            self.assertEqual(list(root.iterdir()), [])

    def test_private_uint8_views_are_copied_before_validation(self):
        snapshot = _snapshot()
        original_source = snapshot["private_bytes"]["source"]
        original_manifest = snapshot["private_bytes"]["manifest"]
        snapshot["private_bytes"] = {"source": memoryview(original_source),
                                      "manifest": bytearray(original_manifest)}
        with tempfile.TemporaryDirectory() as temp:
            result = self.run_snapshot(snapshot, Path(temp))
        self.assertEqual(result["status"], "REVIEW_REQUIRED", result)


if __name__ == "__main__":
    unittest.main()
