"""Synthetic Core over real loopback HTTP; never connects to OA or a printer."""
from __future__ import annotations

import hashlib
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import tempfile
import threading
import unittest

from agents.windows.pilot_cli import run_pilot_dryrun_once
from workers.documents.bridge import _canonical


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _fixture():
    source = (Path(__file__).parent / "fixtures" / "pilot-word-pdf" /
              "public-one-page.pdf").read_bytes()
    source_sha = _sha(source)
    settings = {"copies": 2, "duplex": False, "paper": "A4", "color": "black_white"}
    settings_sha = _sha(_canonical(settings).encode("utf-8"))
    candidate = {
        "shop_id": "synthetic-shop", "oa_id": "synthetic-oa",
        "customer_id": "synthetic-customer", "conversation_id": "synthetic-conversation",
        "order_id": "synthetic-order", "revision": 3,
        "request_hash": "a" * 64,
        "source": {"format": "PDF", "artifact_ref": "public/synthetic.pdf",
                   "sha256": source_sha, "size_bytes": len(source),
                   "provider_event_id": "synthetic-file-event"},
        "settings": settings, "settings_sha256": settings_sha,
        "printer_id": "RMP7000",
    }
    job = {"job_id": "synthetic-job", "order_id": candidate["order_id"],
           "revision": candidate["revision"], "request_hash": candidate["request_hash"],
           "printer_id": candidate["printer_id"], "lease_token": "synthetic-lease",
           "lease_seconds": 60, "mode": "simulation"}
    authorization = {
        "schema": "ai0.pilot_print_authorization.v1", "shop_id": candidate["shop_id"],
        "oa_id": candidate["oa_id"], "customer_id": candidate["customer_id"],
        "order_id": candidate["order_id"], "revision": candidate["revision"],
        "request_hash": candidate["request_hash"], "source_sha256": source_sha,
        "settings_sha256": settings_sha, "evidence_sha256": "e" * 64,
        "printer_id": candidate["printer_id"], "code_window_id": "synthetic-window",
        "provider_event_id": "synthetic-code-event", "authorized_at": "2026-10-21T00:00:00Z",
        "job_id": job["job_id"],
    }
    return source, job, candidate, authorization


class PilotBackendHttpTests(unittest.TestCase):
    def test_loopback_core_http_to_pilot_agent_dryrun(self):
        source, job, candidate, authorization = _fixture()
        calls = []

        class CoreHandler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def _json(self, value, status=200):
                raw = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def do_GET(self):
                assert self.path == "/internal/v1/pilot/print-jobs/synthetic-job/source"
                assert self.headers.get("Authorization") == "Bearer " + "S" * 24
                assert self.headers.get("X-AUTO-IN-Pilot-Lease") == job["lease_token"]
                calls.append(("source", None))
                self.send_response(200)
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Cache-Control", "private, no-store")
                self.send_header("X-AUTO-IN-Source-SHA256", candidate["source"]["sha256"])
                self.send_header("X-AUTO-IN-Source-Size", str(len(source)))
                self.send_header("Content-Length", str(len(source)))
                self.end_headers()
                self.wfile.write(source)

            def do_POST(self):
                assert self.headers.get("Authorization") == "Bearer " + "S" * 24
                raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                body = json.loads(raw)
                if self.path == "/internal/v1/pilot/print-jobs/claim":
                    assert body["printer_id"] == "RMP7000"
                    assert body["idempotency_key"]
                    calls.append(("claim", body))
                    return self._json({"schema": "ai0.pilot_agent_claim.v1",
                                       "work": {"job": job, "candidate": candidate,
                                                "authorization": authorization}})
                suffix = self.path.rsplit("/", 1)[-1]
                calls.append((suffix, body))
                if suffix in ("preflight", "mark-sending"):
                    assert set(body) == {"expected_revision", "lease_token", "request_hash",
                                         "source_sha256", "settings_sha256", "evidence_sha256",
                                         "printer_id"}
                    assert body["lease_token"] == job["lease_token"]
                    state = "AUTHORIZED" if suffix == "preflight" else "SENDING"
                    return self._json({
                        "schema": "ai0.pilot_agent_gate_receipt.v1", "state": state,
                        "job_id": job["job_id"], "order_id": job["order_id"],
                        "revision": job["revision"], "request_hash": job["request_hash"],
                        "source_sha256": candidate["source"]["sha256"],
                        "settings_sha256": candidate["settings_sha256"],
                        "evidence_sha256": authorization["evidence_sha256"],
                        "printer_id": job["printer_id"],
                    })
                assert suffix == "reports"
                assert body["schema"] == "ai0.pilot_agent_report.v1"
                assert body["lease_token"] == job["lease_token"]
                assert body["state"] == "SIMULATED_DONE"
                assert body["evidence"] == {
                    "driver_called": False, "spooler_ack": False,
                    "reason_code": "PILOT_DRY_RUN"}
                assert "source" not in body and "code" not in body
                return self._json({"job_id": job["job_id"], "state": body["state"]})

        server = ThreadingHTTPServer(("127.0.0.1", 0), CoreHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as folder:
                result = run_pilot_dryrun_once(
                    api_base_url=f"http://127.0.0.1:{server.server_port}",
                    token="S" * 24, journal_path=Path(folder) / "pilot.sqlite")
        finally:
            server.shutdown()
            thread.join(timeout=2)
            server.server_close()

        self.assertEqual(result, {"mode": "simulation", "driver_called": False,
                                  "result": {"status": "SIMULATED_DONE",
                                             "driver_called": False}})
        self.assertEqual([name for name, _ in calls],
                         ["claim", "source", "preflight", "mark-sending", "reports"])
        self.assertIs(calls[-1][1]["evidence"]["spooler_ack"], False)
