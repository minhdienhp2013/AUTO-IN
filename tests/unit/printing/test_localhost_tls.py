"""CODE-303: real TLS socket + SQLite DryRun, never a Ricoh/Windows call.

Mock HTTP route tests are elsewhere. This exercises urllib HTTPS transport and
client/server acknowledgment through an actual localhost TLS socket, but it is
NOT the production Fastify/PostgreSQL backend acceptance test.
"""
from __future__ import annotations

from contextlib import contextmanager
import json
import os
from pathlib import Path
import shutil
import socket
import ssl
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit

import pytest

from agents.windows.agent import DryRunDriver, Journal, PrintAgent
from agents.windows.backend_http import HttpBackendClient


def _job():
    return {
        "job_id": "CODE303_TLS_JOB", "order_id": "CODE303_ORDER", "revision": 2,
        "request_hash": "a" * 64, "approval_id": "staff-confirmed",
        "lease_token": "synthetic-scoped-lease", "lease_seconds": 60,
        "mode": "simulation", "printer_id": "RMP7000",
    }


class _SimulatedApi(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, addr, handler):
        super().__init__(addr, handler)
        self.state = "NOT_SENT"
        self.calls: list[str] = []
        self.drop_mark_ack = False
        self.drop_report_ack = False
        self.reject_preflight_evidence = False
        self.preflight_evidence = True
        self.reject_mark = False


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        # Never log Authorization, request JSON or source docs.
        pass

    def do_POST(self):
        raw_length = self.headers.get("Content-Length", "0")
        if (not raw_length.isdigit() or
                not 1 <= int(raw_length) <= 8192 or
                self.headers.get("Authorization") != "Bearer " + ("S" * 24)):
            self.send_error(403)
            return
        payload = json.loads(self.rfile.read(int(raw_length)))
        action = unquote(urlsplit(self.path).path.split("/")[-1])
        server = self.server
        server.calls.append(action)
        if action == "claim":
            assert payload["printer_id"] == "RMP7000" and payload["idempotency_key"]
            answer = {"job": _job()}
        else:
            assert payload["expected_revision"] == 2
            assert payload["lease_token"] == "synthetic-scoped-lease"
            if action == "preflight":
                if server.reject_preflight_evidence:
                    raw = json.dumps({"error": {
                        "code": "DOCUMENT_EVIDENCE_UNVERIFIED"
                    }}).encode()
                    self.send_response(409)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(raw)))
                    self.end_headers()
                    self.wfile.write(raw)
                    return
                answer = {
                    "allowed": server.state == "NOT_SENT",
                    "job_id": _job()["job_id"], "revision": 2,
                    "approval_id": _job()["approval_id"], "mode": "simulation",
                    "document_evidence_verified": server.preflight_evidence,
                }
            elif action == "mark-sending":
                assert server.state == "NOT_SENT"
                assert payload["idempotency_key"]
                if server.reject_mark:
                    raw = json.dumps({"error": {
                        "code": "DOCUMENT_EVIDENCE_UNVERIFIED"
                    }}).encode()
                    self.send_response(409)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(raw)))
                    self.end_headers()
                    self.wfile.write(raw)
                    return
                server.state = "SENDING"
                if server.drop_mark_ack:
                    # The server committed SENDING, but TCP ACK/body is lost.
                    self.close_connection = True
                    self.connection.shutdown(socket.SHUT_RDWR)
                    self.connection.close()
                    return
                answer = {"job_id": _job()["job_id"],
                          "state": "SENDING", "mode": "simulation"}
            elif action == "reports":
                assert server.state in ("SENDING", "UNKNOWN", "SIMULATED_DONE")
                assert payload["idempotency_key"]
                assert payload["result"] in ("unknown", "simulated_done")
                assert payload["evidence_kind"] == (
                    "simulated" if payload["result"] == "simulated_done"
                    else "agent_uncertain"
                )
                server.state = "SIMULATED_DONE" if payload["result"] == "simulated_done" else "UNKNOWN"
                if server.drop_report_ack:
                    server.drop_report_ack = False
                    self.close_connection = True
                    self.connection.shutdown(socket.SHUT_RDWR)
                    self.connection.close()
                    return
                answer = {"job_id": _job()["job_id"], "state": server.state}
            else:
                self.send_error(404)
                return
        raw = json.dumps(answer).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


@contextmanager
def tls_backend(tmp_path, monkeypatch):
    if shutil.which("openssl") is None:
        pytest.skip("openssl binary unavailable for test certificate")
    cert = tmp_path / "cert.pem"
    key = tmp_path / "key.pem"
    cmd = [
        "openssl", "req", "-x509", "-newkey", "rsa:2048",
        "-keyout", str(key), "-out", str(cert), "-days", "1", "-nodes",
        "-subj", "/CN=localhost",
        "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ]
    subprocess.run(cmd, capture_output=True, check=True, timeout=20)
    monkeypatch.setenv("SSL_CERT_FILE", str(cert))
    server = _SimulatedApi(("127.0.0.1", 0), _Handler)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(cert, key)
    server.socket = context.wrap_socket(server.socket, server_side=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server, f"https://localhost:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)


def _agent(url, journal, driver):
    return PrintAgent(HttpBackendClient(url, "S"*24, timeout=3),
                      Journal(journal), driver)


def test_real_tls_transport_dryrun_and_repeat_never_reprints(tmp_path, monkeypatch):
    with tls_backend(tmp_path, monkeypatch) as (server, url):
        driver = DryRunDriver()
        journal = tmp_path / "job.sqlite"
        agent = _agent(url, journal, driver)
        value = agent.run_once()
        assert value["status"] == "SIMULATED_DONE"
        assert value["evidence"]["paper_verified"] is False
        assert driver.calls == 1
        assert server.state == "SIMULATED_DONE"
        agent.journal.close()
        restarted = _agent(url, journal, driver)
        restarted.recover()
        assert restarted.run_once()["status"] == "SIMULATED_DONE"
        assert driver.calls == 1
        assert server.calls.count("mark-sending") == 1
        restarted.journal.close()


def test_real_tls_loss_of_mark_ack_unknown_never_reprints(tmp_path, monkeypatch):
    with tls_backend(tmp_path, monkeypatch) as (server, url):
        server.drop_mark_ack = True
        driver = DryRunDriver()
        journal = tmp_path / "job.sqlite"
        agent = _agent(url, journal, driver)
        value = agent.run_once()
        assert value["status"] == "UNKNOWN"
        assert driver.calls == 0
        agent.journal.close()
        restarted = _agent(url, journal, driver)
        restarted.recover()
        assert restarted.run_once()["status"] == "UNKNOWN"
        assert driver.calls == 0
        assert server.calls.count("mark-sending") == 1
        restarted.journal.close()


def test_no_http_transport_bypass_even_on_loopback():
    with pytest.raises(ValueError, match="HTTPS"):
        HttpBackendClient("http://localhost:3000", "S"*24)


def test_real_tls_lost_report_ack_then_restart_no_second_dryrun(tmp_path, monkeypatch):
    with tls_backend(tmp_path, monkeypatch) as (server, url):
        server.drop_report_ack = True
        driver = DryRunDriver()
        journal = tmp_path / "lost-report.sqlite"
        first = _agent(url, journal, driver)
        result = first.run_once()
        assert result["status"] == "SIMULATED_DONE"
        assert result["report_pending"] is True
        assert driver.calls == 1
        assert server.state == "SIMULATED_DONE"
        first.journal.close()
        recovered = _agent(url, journal, driver)
        assert recovered.recover() == []
        assert recovered.run_once()["status"] in ("NO_JOB", "SIMULATED_DONE")
        assert driver.calls == 1
        assert server.calls.count("mark-sending") == 1
        recovered.journal.close()


@pytest.mark.parametrize("fault,expected_calls", [
    ("before_mark_sending", 0),
    ("after_mark_sending", 0),
    ("after_journal_before_driver", 0),
    ("after_driver", 1),
])
def test_real_tls_crash_restart_reports_unknown_once_no_repeat(tmp_path, monkeypatch, fault, expected_calls):
    from agents.windows.agent import SimulatedCrash
    with tls_backend(tmp_path, monkeypatch) as (server, url):
        driver = DryRunDriver()
        journal = tmp_path / "crash.sqlite"
        first = _agent(url, journal, driver)
        with pytest.raises(SimulatedCrash):
            first.run_once(fault_at=fault)
        assert driver.calls == expected_calls
        first.journal.close()
        restarted = _agent(url, journal, driver)
        assert restarted.recover() == ["CODE303_TLS_JOB"]
        assert restarted.journal.get("CODE303_TLS_JOB")["state"] == "UNKNOWN"
        again = restarted.run_once()
        assert again["status"] in ("UNKNOWN", "NO_JOB")
        assert driver.calls == expected_calls
        assert server.calls.count("mark-sending") <= 1
        restarted.journal.close()



def _cli_run(url, journal, *, token="S"*24):
    """Real CLI subprocess over TLS socket, trusted cert, no physical printer."""
    env = {**os.environ, "AUTO_IN_AGENT_TOKEN": token}
    return subprocess.run([
        __import__("sys").executable, "-m", "agents.windows.cli",
        "--api-base-url", url, "--journal", str(journal),
    ], cwd=Path(__file__).resolve().parents[3], env=env, capture_output=True,
       timeout=25, check=False)


def test_https_cli_verified_preflight_then_dryrun_and_restart(tmp_path, monkeypatch):
    with tls_backend(tmp_path, monkeypatch) as (server, url):
        journal = tmp_path / "valid-https-cli.sqlite"
        first = _cli_run(url, journal)
        assert first.returncode == 0 and first.stderr == b""
        value = json.loads(first.stdout)
        assert value["result"]["status"] == "SIMULATED_DONE"
        assert value["result"]["evidence"]["paper_verified"] is False
        assert server.calls.count("mark-sending") == 1
        again = _cli_run(url, journal)
        assert again.returncode == 0 and again.stderr == b""
        assert json.loads(again.stdout)["result"]["status"] == "SIMULATED_DONE"
        assert server.calls.count("mark-sending") == 1


@pytest.mark.parametrize("denial", ["missing_flag", "false_flag", "http409"])
def test_https_cli_missing_flag_or_exact_409_blocks_without_mark_or_journal(
        tmp_path, monkeypatch, denial):
    with tls_backend(tmp_path, monkeypatch) as (server, url):
        if denial == "http409":
            server.reject_preflight_evidence = True
        else:
            server.preflight_evidence = None if denial == "missing_flag" else False
        journal = tmp_path / f"deny-{denial}.sqlite"
        blocked = _cli_run(url, journal)
        assert blocked.returncode == 2 and blocked.stderr == b""
        output = json.loads(blocked.stdout)
        assert output["result"]["status"] == "BLOCKED"
        if denial == "http409":
            assert output["result"]["reason"] == "DOCUMENT_EVIDENCE_UNVERIFIED"
        assert server.calls == ["claim", "preflight"]
        import sqlite3
        with sqlite3.connect(journal) as db:
            assert db.execute("SELECT COUNT(*) FROM jobs").fetchone()[0] == 0


def test_https_cli_mark_denied_after_journal_keeps_unknown_no_repeat(tmp_path, monkeypatch):
    with tls_backend(tmp_path, monkeypatch) as (server, url):
        server.reject_mark = True
        journal = tmp_path / "mark-denied.sqlite"
        first = _cli_run(url, journal)
        assert first.returncode == 2 and first.stderr == b""
        assert json.loads(first.stdout)["result"]["status"] == "UNKNOWN"
        import sqlite3
        with sqlite3.connect(journal) as db:
            assert db.execute("SELECT state FROM jobs").fetchone()[0] == "UNKNOWN"
        assert server.calls.count("mark-sending") == 1
        again = _cli_run(url, journal)
        assert again.returncode == 2
        assert json.loads(again.stdout)["result"]["status"] == "UNKNOWN"
        assert server.calls.count("mark-sending") == 1


def test_https_cli_lost_mark_ack_retains_unknown_no_second_driver(tmp_path, monkeypatch):
    with tls_backend(tmp_path, monkeypatch) as (server, url):
        server.drop_mark_ack = True
        journal = tmp_path / "lost-mark-cli.sqlite"
        first = _cli_run(url, journal)
        assert first.returncode == 2
        assert json.loads(first.stdout)["result"]["status"] == "UNKNOWN"
        assert server.calls.count("mark-sending") == 1
        second = _cli_run(url, journal)
        assert second.returncode == 2
        assert json.loads(second.stdout)["result"]["status"] == "UNKNOWN"
        assert server.calls.count("mark-sending") == 1
