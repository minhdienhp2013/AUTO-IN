"""CODE-303: actual subprocess JSON CLI fixtures; no customer files or printer."""
from __future__ import annotations

import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys

import fitz
from PIL import Image
import pytest

from workers.documents import bridge


ROOT = Path(__file__).resolve().parents[3]


def fixture(tmp_path, kind):
    incoming = tmp_path / "in"
    outgoing = tmp_path / "artifacts"
    incoming.mkdir()
    outgoing.mkdir()
    if kind == "pdf":
        name = "sample.pdf"
        with fitz.open() as pdf:
            for _ in range(3):
                page = pdf.new_page()
                page.draw_rect(fitz.Rect(30, 30, 140, 140))
            pdf.save(incoming / name)
    else:
        name = "sample.png"
        Image.new("RGB", (320, 480), "white").save(incoming / name)
    payload = {"documents": [{"artifact_name": name, "copies": 3, "duplex": True}]}
    request = {"request_data": payload, "expected_request_hash": hashlib.sha256(
        bridge._canonical(payload).encode("utf-8")).hexdigest()}
    return incoming, outgoing, name, request


def cli(incoming, outgoing, body: bytes, *options):
    # No secrets in argv or environment. Local artifact paths are test-only.
    return subprocess.run(
        [sys.executable, "-m", "workers.documents.bridge",
         "--input-root", str(incoming), "--artifact-root", str(outgoing),
         *options],
        cwd=ROOT, input=body, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        timeout=25, check=False,
    )


@pytest.mark.parametrize("kind,sheets,pages", [("pdf", 6, 3), ("image", 3, 1)])
def test_json_cli_pdf_image_verified_outputs(tmp_path, kind, sheets, pages):
    incoming, outgoing, name, request = fixture(tmp_path, kind)
    result = cli(incoming, outgoing, json.dumps(request).encode("utf-8"))
    assert result.returncode == 0, (result.stdout, result.stderr)
    assert result.stderr == b""
    assert result.stdout.count(b"\n") == 1, result.stdout
    parsed = json.loads(result.stdout)
    assert parsed["status"] == "READY"
    assert parsed["plan"]["request_hash"] == request["expected_request_hash"]
    assert parsed["plan"]["document_pages"] == pages
    assert parsed["plan"]["physical_sheets"] == sheets
    assert parsed["plan"]["ready"] is True
    manifest = json.loads((outgoing / parsed["plan"]["artifact_ref"]).read_text())
    assert manifest["counts"]["physical_sheets"] == sheets
    assert manifest["request_hash"] == request["expected_request_hash"]
    assert parsed["preview_artifacts"]
    assert all((outgoing / p["ref"]).is_file() for p in parsed["preview_artifacts"])
    # Response/stdio do not disclose original artifact filenames or content.
    assert name.encode() not in result.stdout
    assert b"sample.pdf" not in result.stderr


@pytest.mark.parametrize("raw", [
    b"{",
    b'{"request_data":{},"request_data":{},"expected_request_hash":"ignored"}',
    b'{"request_data":{"documents":[]},"expected_request_hash":NaN}',
    b'{"request_data":{"documents":[]},"expected_request_hash":Infinity}',
    b"\xff",
])
def test_invalid_json_is_single_safe_machine_readable_response(tmp_path, raw):
    incoming = tmp_path / "in"; outgoing = tmp_path / "out"
    incoming.mkdir(); outgoing.mkdir()
    result = cli(incoming, outgoing, raw)
    assert result.returncode == 2
    assert result.stderr == b""
    decoded = json.loads(result.stdout)
    assert decoded == {
        "schema": bridge.SCHEMA, "status": "NEEDS_HUMAN",
        "reason_code": "INVALID_JSON", "ready": False
    }


def test_cli_input_limit(tmp_path):
    incoming = tmp_path / "in"; outgoing = tmp_path / "out"
    incoming.mkdir(); outgoing.mkdir()
    result = cli(incoming, outgoing, b" " * (bridge.MAX_REQUEST + 1))
    assert result.returncode == 2
    assert json.loads(result.stdout)["reason_code"] == "INPUT_TOO_LARGE"


def test_cli_missing_file_does_not_leak_path(tmp_path):
    incoming = tmp_path / "in"; outgoing = tmp_path / "out"
    incoming.mkdir(); outgoing.mkdir()
    body = {"documents": [{"artifact_name": "sensitive-customer.pdf"}]}
    request = {"request_data": body, "expected_request_hash": hashlib.sha256(
        bridge._canonical(body).encode()).hexdigest()}
    result = cli(incoming, outgoing, json.dumps(request).encode())
    assert result.returncode == 2
    parsed = json.loads(result.stdout)
    assert parsed["status"] == "NEEDS_HUMAN"
    assert "plan" not in parsed
    assert b"sensitive-customer.pdf" not in result.stdout + result.stderr


def test_deadline_error_is_machine_readable(monkeypatch, capsys, tmp_path):
    class FakeStdin:
        buffer = io.BytesIO(b"{}")

    monkeypatch.setattr(sys, "stdin", FakeStdin())
    monkeypatch.setattr(sys, "argv", [
        "bridge", "--input-root", str(tmp_path),
        "--artifact-root", str(tmp_path), "--timeout-seconds", "1"
    ])

    def expire(*_args, **_kwargs):
        raise bridge._ProcessorDeadline()

    monkeypatch.setattr(bridge, "run_json_stream", expire)
    assert bridge.main() == 2
    assert json.loads(capsys.readouterr().out)["reason_code"] == "PROCESSING_TIMEOUT"


def test_timeout_cleans_partial_output(tmp_path, monkeypatch):
    incoming, outgoing, name, request = fixture(tmp_path, "pdf")

    def fail_render(*_args, **_kwargs):
        raise bridge._ProcessorDeadline()

    monkeypatch.setattr(bridge.processor, "_inspect_data", fail_render)
    value = bridge.process_request(request, input_root=incoming, artifact_root=outgoing)
    assert value["reason_code"] == "PROCESSING_TIMEOUT"
    assert not any(outgoing.iterdir())


def test_same_evidence_hash_across_two_cli_runs(tmp_path):
    incoming, outgoing, _name, request = fixture(tmp_path, "image")
    cmd = json.dumps(request).encode("utf-8")
    first = json.loads(cli(incoming, outgoing, cmd).stdout)
    second = json.loads(cli(incoming, outgoing, cmd).stdout)
    assert first["status"] == second["status"] == "READY"
    assert first["content_settings_sha256"] == second["content_settings_sha256"]
    assert first["plan"]["artifact_ref"] != second["plan"]["artifact_ref"]
