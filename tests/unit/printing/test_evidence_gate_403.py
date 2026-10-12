"""CODE-403: optional trusted document gate at DryRun send boundary.

Synthetic only. Fake AI1 backend, no Ricoh/Windows spooler.
The DB-backed preview/manifest service must be the gate authority.
"""
import pytest

from agents.windows.agent import (
    DryRunDriver, FakeBackend, Journal, PrintAgent, SimulatedCrash,
)


def _job():
    return {"job_id": "j403", "order_id": "o403", "revision": 4,
            "request_hash": "b" * 64, "approval_id": "approved-by-staff",
            "lease_token": "synthetic-token", "lease_seconds": 90,
            "mode": "simulation", "printer_id": "RMP7000"}


@pytest.mark.parametrize("verdict", [
    False, None, {"status": "NEEDS_HUMAN"}, {"ready": True},
])
def test_untrusted_evidence_blocks_before_mark_and_before_driver(tmp_path, verdict):
    backend = FakeBackend(_job())
    driver = DryRunDriver()
    agent = PrintAgent(backend, Journal(tmp_path / "safe.sqlite"), driver,
                       evidence_gate=lambda job: verdict)
    try:
        outcome = agent.run_once()
        assert outcome["status"] == "BLOCKED"
        assert outcome["reason"] == "DOCUMENT_EVIDENCE_UNVERIFIED"
        assert agent.journal.get("j403") is None
        assert backend.state == "NOT_SENT"
        assert driver.calls == 0
    finally:
        agent.journal.close()


def test_evidence_gate_storage_error_blocks_fail_closed(tmp_path):
    def unavailable(_job):
        raise OSError("synthetic storage failure")
    backend = FakeBackend(_job())
    driver = DryRunDriver()
    agent = PrintAgent(backend, Journal(tmp_path / "safe.sqlite"), driver,
                       evidence_gate=unavailable)
    try:
        assert agent.run_once()["status"] == "BLOCKED"
        assert agent.journal.get("j403") is None
        assert backend.state == "NOT_SENT" and driver.calls == 0
    finally:
        agent.journal.close()


def test_only_matching_revision_hash_and_approval_passes_verified_gate(tmp_path):
    backend = FakeBackend(_job())
    driver = DryRunDriver()
    calls = []

    def trusted(job):
        calls.append(job["job_id"])
        return (job["revision"] == 4 and job["request_hash"] == "b" * 64
                and job["approval_id"] == "approved-by-staff")

    agent = PrintAgent(backend, Journal(tmp_path / "safe.sqlite"), driver,
                       evidence_gate=trusted)
    try:
        done = agent.run_once()
        assert done["status"] == "SIMULATED_DONE"
        assert done["evidence"]["paper_verified"] is False
        assert driver.calls == 1
        assert calls == ["j403"]
        # Replayed claim has the journal boundary: cannot run gate/driver twice.
        assert agent.run_once()["status"] == "SIMULATED_DONE"
        assert driver.calls == 1 and calls == ["j403"]
    finally:
        agent.journal.close()


def test_changed_revision_blocks_trusted_gate_before_mark(tmp_path):
    backend = FakeBackend(_job())
    backend.job["revision"] = 5  # changed from approved revision 4
    driver = DryRunDriver()
    agent = PrintAgent(backend, Journal(tmp_path / "safe.sqlite"), driver,
                       evidence_gate=lambda job: job["revision"] == 4)
    try:
        assert agent.run_once()["status"] == "BLOCKED"
        assert backend.state == "NOT_SENT"
        assert agent.journal.get("j403") is None and driver.calls == 0
    finally:
        agent.journal.close()


def test_crash_after_accepted_gate_restart_never_reprints(tmp_path):
    backend = FakeBackend(_job())
    driver = DryRunDriver()
    disk = tmp_path / "persistent.sqlite"
    agent = PrintAgent(backend, Journal(disk), driver,
                       evidence_gate=lambda job: True)
    with pytest.raises(SimulatedCrash):
        agent.run_once(fault_at="after_driver")
    assert driver.calls == 1
    agent.journal.close()
    # After restart the evidence gate may be unavailable; durable UNKNOWN wins.
    restarted = PrintAgent(backend, Journal(disk), driver,
                           evidence_gate=lambda job: False)
    try:
        assert restarted.recover() == ["j403"]
        assert restarted.journal.get("j403")["state"] == "UNKNOWN"
        assert restarted.run_once()["status"] == "UNKNOWN"
        assert driver.calls == 1
        assert backend.state == "UNKNOWN"
    finally:
        restarted.journal.close()


def test_lost_report_ack_plus_restart_reports_without_second_send(tmp_path):
    backend = FakeBackend(_job())
    backend.fail_report = True
    driver = DryRunDriver()
    disk = tmp_path / "persistent.sqlite"
    agent = PrintAgent(backend, Journal(disk), driver,
                       evidence_gate=lambda job: True)
    assert agent.run_once()["report_pending"] is True
    assert driver.calls == 1
    agent.journal.close()
    backend.fail_report = False
    restarted = PrintAgent(backend, Journal(disk), driver,
                           evidence_gate=lambda job: False)
    try:
        assert restarted.recover() == []
        assert backend.state == "SIMULATED_DONE"
        assert restarted.run_once()["status"] == "SIMULATED_DONE"
        assert driver.calls == 1
    finally:
        restarted.journal.close()
