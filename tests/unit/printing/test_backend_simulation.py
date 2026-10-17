"""CODE-203: HTTP-wire simulation only, NOT a live backend or printer test."""
import json

from agents.windows import backend_http
from agents.windows.agent import DryRunDriver, Journal, PrintAgent, SimulatedCrash
import pytest


def _job():
    return {
        "job_id": "job-203", "order_id": "order-203", "revision": 2,
        "request_hash": "a" * 64, "approval_id": "approved-by-human",
        "lease_token": "synthetic-lease-token", "lease_seconds": 90,
        "mode": "simulation", "printer_id": "RMP7000",
    }


def _preflight_ticket(job, *, allowed=True):
    evidence_sha = "e" * 64
    return {
        "allowed": allowed, "job_id": job["job_id"],
        "revision": job["revision"], "mode": job["mode"],
        "approval_id": job["approval_id"], "document_evidence_verified": True,
        "review_receipt": {
            "receipt_id": "receipt-203", "shop_id": "shop-203",
            "order_id": job["order_id"], "revision": job["revision"],
            "request_hash": job["request_hash"], "evidence_sha256": evidence_sha,
            "reviewer_id": "staff-203", "reviewed_at": "2026-10-18T10:00:00Z",
            "decision": "checked",
        },
        "trusted_evidence": {
            "schema": "ai0.print_evidence.v1", "shop_id": "shop-203",
            "order_id": job["order_id"], "revision": job["revision"],
            "request_hash": job["request_hash"], "evidence_sha256": evidence_sha,
            "settings_sha256": "1" * 64, "renderer_sha256": "2" * 64,
            "printer_capability_sha256": "3" * 64,
            "preview_sha256": ["4" * 64], "printer_id": job["printer_id"],
        },
        "trusted_job": {
            "job_id": job["job_id"], "shop_id": "shop-203",
            "order_id": job["order_id"], "revision": job["revision"],
            "request_hash": job["request_hash"],
            "approval_id": job["approval_id"], "printer_id": job["printer_id"],
            "evidence_sha256": evidence_sha, "mode": job["mode"],
            "state": "NOT_SENT",
        },
    }


class _Response:
    status = 200

    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass

    def read(self, count):
        return json.dumps(self.payload).encode("utf-8")[:count]


class _SimulatedBackend:
    """Runs AI1 current request/response shapes with stateful server denials."""
    def __init__(self):
        self.state = "NOT_SENT"
        self.calls = []
        self.drop_mark_ack = False
        self.drop_report_ack = False

    def route(self, request, timeout):
        action = request.full_url.split("/")[-1]
        data = json.loads(request.data)
        self.calls.append(action)
        if action == "claim":
            assert data["printer_id"] == "RMP7000"
            assert data["idempotency_key"]
            return _Response({"job": _job()})
        assert request.get_header("Authorization") == "Bearer " + ("S" * 24)
        assert data["expected_revision"] == 2
        assert data["lease_token"] == "synthetic-lease-token"
        if action == "preflight":
            return _Response(_preflight_ticket(
                _job(), allowed=self.state == "NOT_SENT"))
        if action == "mark-sending":
            assert data["idempotency_key"]
            if self.state != "NOT_SENT":
                raise RuntimeError("Not a second mark from NOT_SENT")
            self.state = "SENDING"
            if self.drop_mark_ack:
                raise ConnectionError("Lost ACK after atomic SENDING")
            return _Response({"job_id": _job()["job_id"],
                              "state": "SENDING", "mode": "simulation"})
        if action == "reports":
            assert data["idempotency_key"]
            outcome = {
                "unknown": ("UNKNOWN", "agent_uncertain"),
                "simulated_done": ("SIMULATED_DONE", "simulated"),
            }
            state, evidence_kind = outcome[data["result"]]
            assert evidence_kind == data["evidence_kind"]
            assert self.state in ("SENDING", state)
            self.state = state
            if self.drop_report_ack:
                self.drop_report_ack = False
                raise ConnectionError("Report persisted but response lost")
            return _Response({"job_id": _job()["job_id"], "state": state})
        raise AssertionError(action)


def _make_agent(tmp_path, driver):
    from agents.windows.backend_http import HttpBackendClient
    client = HttpBackendClient("https://backend.example", "S" * 24)
    return PrintAgent(client, Journal(tmp_path / "persist.sqlite"), driver,
                      evidence_gate=client.evidence_verified)


def test_lost_mark_ack_never_drives_again_after_restart(monkeypatch, tmp_path):
    server = _SimulatedBackend()
    server.drop_mark_ack = True
    monkeypatch.setattr(backend_http, "urlopen", server.route)
    driver = DryRunDriver()
    agent = _make_agent(tmp_path, driver)
    assert agent.run_once()["status"] == "UNKNOWN"
    assert driver.calls == 0
    assert server.state == "UNKNOWN"
    agent.journal.close()
    restarted = _make_agent(tmp_path, driver)
    assert restarted.recover() == []
    assert restarted.run_once()["status"] == "UNKNOWN"
    assert driver.calls == 0
    assert server.calls.count("mark-sending") == 1
    restarted.journal.close()


def test_crash_after_driver_and_restart_records_unknown_not_second_send(monkeypatch, tmp_path):
    server = _SimulatedBackend()
    monkeypatch.setattr(backend_http, "urlopen", server.route)
    driver = DryRunDriver()
    agent = _make_agent(tmp_path, driver)
    with pytest.raises(SimulatedCrash):
        agent.run_once(fault_at="after_driver")
    assert driver.calls == 1 and server.state == "SENDING"
    agent.journal.close()
    restarted = _make_agent(tmp_path, driver)
    assert restarted.recover() == ["job-203"]
    assert server.state == "UNKNOWN"
    assert restarted.run_once()["status"] == "UNKNOWN"
    assert driver.calls == 1
    assert server.calls.count("mark-sending") == 1
    restarted.journal.close()


def test_lost_report_ack_reconcile_without_second_driver(monkeypatch, tmp_path):
    server = _SimulatedBackend()
    server.drop_report_ack = True
    monkeypatch.setattr(backend_http, "urlopen", server.route)
    driver = DryRunDriver()
    agent = _make_agent(tmp_path, driver)
    result = agent.run_once()
    assert result["status"] == "SIMULATED_DONE"
    assert result["report_pending"] is True
    assert server.state == "SIMULATED_DONE"
    agent.journal.close()
    restarted = _make_agent(tmp_path, driver)
    assert restarted.recover() == []
    assert restarted.run_once()["status"] == "SIMULATED_DONE"
    assert driver.calls == 1
    assert server.calls.count("mark-sending") == 1
    restarted.journal.close()
