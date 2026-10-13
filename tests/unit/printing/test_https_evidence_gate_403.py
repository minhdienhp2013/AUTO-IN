"""AI3 CODE-403: strict authenticated HTTPS preflight evidence/lease cache.

Transport stub below replaces HTTPS I/O *at the boundary*; CLI TLS socket
tests separately exercise real certificate-verified localhost connections.
No real OA, Windows spooler or Ricoh printer.
"""
from __future__ import annotations

import io
import json
from urllib.error import HTTPError

import pytest

from agents.windows import backend_http
from agents.windows.agent import DryRunDriver, Journal, PrintAgent
from agents.windows.backend_http import HttpBackendClient


TOKEN = "S" * 24


def claimed():
    return {
        "job_id": "job-code403", "order_id": "order-code403",
        "revision": 3, "request_hash": "a" * 64,
        "approval_id": "staff-approval-code403",
        "lease_token": "trusted-lease-code403", "lease_seconds": 90,
        "mode": "simulation", "printer_id": "RMP7000",
    }


class _Response:
    status = 200

    def __init__(self, value):
        self.data = json.dumps(value).encode()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass

    def read(self, size):
        return self.data[:size]


class _Wire:
    def __init__(self, job=None):
        self.job = job or claimed()
        self.calls = []
        self.preflight = {
            "allowed": True,
            "job_id": self.job["job_id"],
            "revision": self.job["revision"],
            "approval_id": self.job["approval_id"],
            "mode": self.job["mode"],
            "document_evidence_verified": True,
        }
        self.error_code = None
        self.http_status = 409
        self.mark_error_code = None
        self.state = "NOT_SENT"
        self.mark_count = 0

    def __call__(self, request, timeout):
        action = request.full_url.split("/")[-1]
        body = json.loads(request.data)
        self.calls.append(action)
        assert request.get_header("Authorization") == "Bearer " + TOKEN
        if action == "claim":
            assert body["printer_id"] == "RMP7000"
            return _Response({"job": self.job.copy()})
        assert body["expected_revision"] == self.job["revision"]
        assert body["lease_token"] == self.job["lease_token"]
        if action == "preflight":
            if self.error_code is not None:
                raw = json.dumps({"error": {"code": self.error_code}}).encode()
                raise HTTPError(request.full_url, self.http_status, "preflight rejected",
                                {}, io.BytesIO(raw))
            return _Response(self.preflight)
        if action == "mark-sending":
            self.mark_count += 1
            if self.mark_error_code is not None:
                raw = json.dumps({"error": {"code": self.mark_error_code}}).encode()
                raise HTTPError(request.full_url, 409, "mark rejected", {}, io.BytesIO(raw))
            self.state = "SENDING"
            return _Response({"state": "SENDING", "job_id": self.job["job_id"],
                              "mode": "simulation"})
        if action == "reports":
            if self.state == "NOT_SENT":
                raise HTTPError(request.full_url, 409, "not sent", {}, io.BytesIO(b"{}"))
            self.state = "SIMULATED_DONE" if body["result"] == "simulated_done" else "UNKNOWN"
            return _Response({"state": self.state, "job_id": self.job["job_id"]})
        raise AssertionError(action)


def _agent(tmp_path, monkeypatch, wire):
    monkeypatch.setattr(backend_http, "urlopen", wire)
    client = HttpBackendClient("https://localhost:3443", TOKEN)
    driver = DryRunDriver()
    agent = PrintAgent(client, Journal(tmp_path / "journal.sqlite"), driver,
                       evidence_gate=client.evidence_verified)
    return agent, client, driver


def test_valid_authenticated_preflight_and_one_dryrun(tmp_path, monkeypatch):
    wire = _Wire()
    agent, client, driver = _agent(tmp_path, monkeypatch, wire)
    try:
        job = wire.job
        assert client.evidence_verified(job) is False
        done = agent.run_once()
        assert done["status"] == "SIMULATED_DONE"
        assert driver.calls == 1 and wire.mark_count == 1
        assert client.evidence_verified(job) is False  # consumed by mark-sending
        assert done["evidence"]["paper_verified"] is False
    finally:
        agent.journal.close()


@pytest.mark.parametrize("field,wrong", [
    ("document_evidence_verified", None),
    ("document_evidence_verified", False),
    ("document_evidence_verified", 1),
    ("document_evidence_verified", "true"),
    ("allowed", False),
    ("job_id", "other-job"),
    ("revision", 4),
    ("revision", True),
    ("approval_id", "other-approval"),
    ("mode", "live"),
])
def test_preflight_missing_false_identity_does_not_create_boundary(
        tmp_path, monkeypatch, field, wrong):
    wire = _Wire()
    if wrong is None:
        wire.preflight.pop(field)
    else:
        wire.preflight[field] = wrong
    agent, client, driver = _agent(tmp_path, monkeypatch, wire)
    try:
        result = agent.run_once()
        assert result["status"] == "BLOCKED"
        assert agent.journal.get(wire.job["job_id"]) is None
        assert wire.mark_count == 0 and driver.calls == 0
        assert client.evidence_verified(wire.job) is False
    finally:
        agent.journal.close()


@pytest.mark.parametrize("field,changed", [
    ("job_id", "different"),
    ("order_id", "another-order"),
    ("revision", 4),
    ("request_hash", "b" * 64),
    ("approval_id", "new-approval"),
    ("lease_token", "other-lease"),
])
def test_cache_bound_to_all_six_claimed_identity_fields(
        tmp_path, monkeypatch, field, changed):
    wire = _Wire()
    agent, client, _ = _agent(tmp_path, monkeypatch, wire)
    try:
        claimed_job = client.claim()
        assert client.evidence_verified(claimed_job) is False
        check = client.preflight(claimed_job)
        assert check["document_evidence_verified"] is True
        assert client.evidence_verified(claimed_job) is True
        changed_job = {**claimed_job, field: changed}
        assert client.evidence_verified(changed_job) is False
        with pytest.raises(RuntimeError, match="stale or missing"):
            client.mark_sending(changed_job)
        assert wire.mark_count == 0
        assert agent.journal.get(claimed_job["job_id"]) is None
    finally:
        agent.journal.close()


def test_new_claim_or_preflight_clears_old_cache(tmp_path, monkeypatch):
    wire = _Wire()
    agent, client, _ = _agent(tmp_path, monkeypatch, wire)
    try:
        job = client.claim()
        client.preflight(job)
        assert client.evidence_verified(job) is True
        second = client.claim()
        assert second == job
        assert client.evidence_verified(job) is False
        client.preflight(second)
        assert client.evidence_verified(second) is True
        wire.preflight["document_evidence_verified"] = False
        client.preflight(second)
        assert client.evidence_verified(second) is False
        assert wire.mark_count == 0
    finally:
        agent.journal.close()


@pytest.mark.parametrize("status,code", [
    (409, "DOCUMENT_EVIDENCE_UNVERIFIED"),
])
def test_exact_409_evidence_denial_blocks_without_journal_mark_or_driver(
        tmp_path, monkeypatch, status, code):
    wire = _Wire()
    wire.http_status = status
    wire.error_code = code
    agent, client, driver = _agent(tmp_path, monkeypatch, wire)
    try:
        result = agent.run_once()
        assert result == {
            "status": "BLOCKED", "job_id": wire.job["job_id"],
            "reason": "DOCUMENT_EVIDENCE_UNVERIFIED"
        }
        assert agent.journal.get(wire.job["job_id"]) is None
        assert wire.calls == ["claim", "preflight"] and wire.mark_count == 0
        assert driver.calls == 0 and client.evidence_verified(wire.job) is False
    finally:
        agent.journal.close()


@pytest.mark.parametrize("status,code", [
    (409, "STALE_REVISION"),
    (500, "DOCUMENT_EVIDENCE_UNVERIFIED"),
    (503, "DOCUMENT_EVIDENCE_GATE_UNAVAILABLE"),
])
def test_other_http_error_is_not_mislabeled_blocked(tmp_path, monkeypatch, status, code):
    wire = _Wire()
    wire.error_code = code
    wire.http_status = status
    agent, client, driver = _agent(tmp_path, monkeypatch, wire)
    try:
        with pytest.raises(HTTPError):
            agent.run_once()
        assert agent.journal.get(wire.job["job_id"]) is None
        assert driver.calls == wire.mark_count == 0
        assert client.evidence_verified(wire.job) is False
    finally:
        agent.journal.close()


def test_mark_sending_denied_after_journal_is_unknown_no_driver(tmp_path, monkeypatch):
    wire = _Wire()
    wire.mark_error_code = "DOCUMENT_EVIDENCE_UNVERIFIED"
    agent, client, driver = _agent(tmp_path, monkeypatch, wire)
    try:
        outcome = agent.run_once()
        assert outcome["status"] == "UNKNOWN"
        assert outcome.get("report_pending") is True
        assert agent.journal.get(wire.job["job_id"])["state"] == "UNKNOWN"
        assert wire.calls.count("mark-sending") == 1 and driver.calls == 0
        assert client.evidence_verified(wire.job) is False
        assert agent.run_once()["status"] == "UNKNOWN"
        assert driver.calls == 0 and wire.calls.count("mark-sending") == 1
    finally:
        agent.journal.close()


def test_network_failure_never_marks_or_runs_driver(tmp_path, monkeypatch):
    wire = _Wire()

    def offline(request, timeout):
        if request.full_url.endswith("/preflight"):
            raise ConnectionError("socket dropped after sending preflight")
        return wire(request, timeout)

    monkeypatch.setattr(backend_http, "urlopen", offline)
    client = HttpBackendClient("https://localhost:3443", TOKEN)
    driver = DryRunDriver()
    agent = PrintAgent(client, Journal(tmp_path / "journal.sqlite"), driver,
                       evidence_gate=client.evidence_verified)
    try:
        with pytest.raises(ConnectionError):
            agent.run_once()
        assert agent.journal.get(wire.job["job_id"]) is None
        assert driver.calls == wire.mark_count == 0
        assert client.evidence_verified(wire.job) is False
    finally:
        agent.journal.close()
