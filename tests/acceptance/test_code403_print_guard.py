"""AI5 independent CODE-403, synthetic-only. No physical printer, OA, or Windows spooler."""
import pytest

from agents.windows.agent import DryRunDriver, FakeBackend, Journal, PrintAgent
from agents.windows.backend_http import DocumentEvidenceDenied


def claimed():
    return {
        "job_id": "ai5-code403-job", "order_id": "ai5-code403-order",
        "revision": 4, "request_hash": "a" * 64,
        "approval_id": "ai5-staff-approval", "lease_token": "ai5-lease-token",
        "lease_seconds": 90, "mode": "simulation", "printer_id": "RMP7000"
    }


def build(tmp_path, backend, driver):
    return PrintAgent(backend, Journal(tmp_path / "journal.sqlite"), driver,
                      evidence_gate=lambda job: (
                          job["revision"] == 4
                          and job["request_hash"] == "a" * 64
                          and job["approval_id"] == "ai5-staff-approval"))


@pytest.mark.parametrize("scenario,override", [
    ("stale_revision", {"revision": 5}),
    ("request_hash_mismatch", {"request_hash": "b" * 64}),
    ("wrong_approval", {"approval_id": "stale-approval"}),
])
def test_identity_mismatch_never_calls_dryrun_driver(tmp_path, scenario, override):
    backend = FakeBackend({**claimed(), **override})
    driver = DryRunDriver()
    agent = build(tmp_path, backend, driver)
    try:
        result = agent.run_once()
        assert result["status"] == "BLOCKED", (scenario, result)
        assert result["reason"] == "DOCUMENT_EVIDENCE_UNVERIFIED"
        assert driver.calls == 0
        assert backend.state == "NOT_SENT"
        assert agent.journal.get(backend.job["job_id"]) is None
        assert backend.reports == []
    finally:
        agent.journal.close()


def test_mark_sending_ack_lost_then_fresh_agent_restart_never_prints(tmp_path):
    backend = FakeBackend(claimed())
    backend.fail_mark = True
    driver = DryRunDriver()
    original = build(tmp_path, backend, driver)
    try:
        first = original.run_once()
        assert first["status"] == "UNKNOWN"
        assert driver.calls == 0
        assert original.journal.get(backend.job["job_id"])["state"] == "UNKNOWN"
    finally:
        original.journal.close()
    backend.fail_mark = False
    restarted = build(tmp_path, backend, driver)
    try:
        # The journal is authoritative even if an in-flight mark reached the
        # backend but the acknowledgment vanished.
        assert restarted.recover() == []
        repeat = restarted.run_once()
        assert repeat["status"] == "UNKNOWN"
        assert driver.calls == 0
        assert restarted.journal.get(backend.job["job_id"])["state"] == "UNKNOWN"
        assert backend.state == "UNKNOWN"
    finally:
        restarted.journal.close()


def test_unknown_job_cannot_retry_even_when_server_claim_repeats(tmp_path):
    backend = FakeBackend(claimed())
    backend.fail_mark = True
    driver = DryRunDriver()
    agent = build(tmp_path, backend, driver)
    try:
        assert agent.run_once()["status"] == "UNKNOWN"
        assert driver.calls == 0
        backend.fail_mark = False
        for _ in range(3):
            replay = agent.run_once()
            assert replay["status"] == "UNKNOWN"
            assert driver.calls == 0
        assert agent.journal.get(backend.job["job_id"])["state"] == "UNKNOWN"
    finally:
        agent.journal.close()


def test_preflight_document_denial_does_not_mark_or_journal(tmp_path):
    backend = FakeBackend(claimed())
    driver = DryRunDriver()

    def reject_document(_job):
        raise DocumentEvidenceDenied("DOCUMENT_EVIDENCE_UNVERIFIED")

    backend.preflight = reject_document
    agent = build(tmp_path, backend, driver)
    try:
        result = agent.run_once()
        assert result["status"] == "BLOCKED"
        assert result["reason"] == "DOCUMENT_EVIDENCE_UNVERIFIED"
        assert backend.state == "NOT_SENT"
        assert driver.calls == 0
        assert agent.journal.get(backend.job["job_id"]) is None
    finally:
        agent.journal.close()


@pytest.mark.parametrize("tamper,reason", [
    ("source", "SOURCE_CHANGED"),
    ("preview", "PREVIEW_CHANGED"),
])
def test_tampered_sealed_document_cannot_reach_driver(tmp_path, tamper, reason):
    """Real AI3 generated PDF snapshot and preview, with real product evidence
    verifier wired to the actual PrintAgent gate, not a mocked verdict.
    No PostgreSQL/HTTPS here; those are separate exact-SHA composition suites.
    """
    import importlib.util
    from pathlib import Path
    from workers.documents.evidence_guard import verify_approved_evidence

    helper_path = Path(__file__).resolve().parents[1] / "unit/documents/test_evidence_guard_403.py"
    loader = importlib.util.spec_from_file_location("ai5_403_fixture_helpers", helper_path)
    assert loader and loader.loader, "real document fixture module must exist"
    module = importlib.util.module_from_spec(loader)
    loader.loader.exec_module(module)
    incoming, output = module.prepared(tmp_path, [("source.pdf", "pdf", 2)])
    _, trusted, manifest = module.published(incoming, output, [
        {"artifact_name": "source.pdf"}
    ])
    initial = verify_approved_evidence(trusted, artifact_root=output)
    assert initial["status"] == "READY", initial
    ref = (manifest["files"][0]["source_artifact_ref"] if tamper == "source"
           else manifest["previews"][0]["ref"])
    target = output / ref
    original = target.read_bytes()
    assert original
    target.chmod(0o600)
    target.write_bytes(original[:-1] + bytes([original[-1] ^ 1]))
    corrupted = verify_approved_evidence(trusted, artifact_root=output)
    assert corrupted["status"] == "NEEDS_HUMAN", corrupted
    assert corrupted["reason_code"] == reason, corrupted

    backend = FakeBackend(claimed())
    driver = DryRunDriver()
    agent = PrintAgent(backend, Journal(tmp_path / "guard.sqlite"), driver,
                       evidence_gate=lambda _job: (
                           verify_approved_evidence(trusted, artifact_root=output)["status"] == "READY"))
    try:
        result = agent.run_once()
        assert result["status"] == "BLOCKED", (tamper, result)
        assert result["reason"] == "DOCUMENT_EVIDENCE_UNVERIFIED"
        assert driver.calls == 0, "tampered source/preview must NEVER reach DryRunDriver"
        assert backend.state == "NOT_SENT"
        assert backend.reports == []
        assert agent.journal.get(backend.job["job_id"]) is None
    finally:
        agent.journal.close()
