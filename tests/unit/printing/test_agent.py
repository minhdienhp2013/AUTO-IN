import copy
import pytest
from agents.windows.agent import (PrintBlocked, DryRunDriver, GuardedWindowsDriver,
                                 FakeBackend, Journal, PrintAgent, SimulatedCrash)


def job():
    return {'job_id': 'j1', 'order_id': 'o1', 'revision': 2,
            'request_hash': 'a' * 64, 'approval_id': 'a1', 'claim_id': 'c1',
            'mode': 'simulation', 'print_state': 'NOT_SENT', 'printer_id': 'RMP7000',
            'manual_lock': False}


def make_agent(tmp_path, backend=None, driver=None):
    backend = backend or FakeBackend(job()); driver = driver or DryRunDriver()
    return PrintAgent(backend, Journal(tmp_path / 'safe.sqlite'), driver)


def test_dry_run_never_verifies_paper(tmp_path):
    agent = make_agent(tmp_path)
    result = agent.run_once()
    assert result['status'] == 'SIMULATED_DONE'
    assert result['evidence']['paper_verified'] is False
    assert agent.backend.state == 'SIMULATED_DONE'
    assert agent.journal.get('j1')['state'] == 'SIMULATED_DONE'
    assert agent.driver.calls == 1
    assert agent.run_once()['status'] == 'SIMULATED_DONE'
    assert agent.driver.calls == 1


def test_preflight_denied_no_journal(tmp_path):
    backend = FakeBackend(job()); backend.allow_preflight = False
    agent = make_agent(tmp_path, backend)
    assert agent.run_once()['status'] == 'BLOCKED'
    assert agent.journal.get('j1') is None


def test_old_revision_and_locked_job_blocked(tmp_path):
    invalid = job(); invalid['revision'] = 1
    backend = FakeBackend(job()); backend.job = job()
    backend.preflight = lambda _: {'allow': False, 'job_id': 'j1', 'revision': 2}
    agent = PrintAgent(backend, Journal(tmp_path / 's1.sqlite'), DryRunDriver())
    assert agent.run_once()['status'] == 'BLOCKED'
    locked = job(); locked['manual_lock'] = True
    agent = PrintAgent(FakeBackend(locked), Journal(tmp_path / 's2.sqlite'), DryRunDriver())
    with pytest.raises(PrintBlocked):
        agent.run_once()


@pytest.mark.parametrize('fault_at', ['before_mark_sending', 'after_mark_sending',
                                      'after_journal_before_driver', 'after_driver'])
def test_crash_unknown_restart_never_reprints(tmp_path, fault_at):
    backend = FakeBackend(job()); driver = DryRunDriver()
    agent = make_agent(tmp_path, backend, driver)
    with pytest.raises(SimulatedCrash):
        agent.run_once(fault_at=fault_at)
    agent.journal.close()
    reopened = make_agent(tmp_path, backend, driver)
    assert reopened.recover() == ['j1']
    assert backend.reports[-1][0] == 'UNKNOWN'
    assert reopened.journal.get('j1')['state'] == 'UNKNOWN'
    assert reopened.run_once()['status'] == 'UNKNOWN'
    assert driver.calls <= 1


def test_mark_response_lost_is_unknown_no_driver(tmp_path):
    backend = FakeBackend(job()); backend.fail_mark = True
    agent = make_agent(tmp_path, backend)
    assert agent.run_once()['status'] == 'UNKNOWN'
    assert agent.driver.calls == 0


def test_report_lost_no_reprint(tmp_path):
    backend = FakeBackend(job()); backend.fail_report = True
    agent = make_agent(tmp_path, backend)
    result = agent.run_once()
    assert result['report_pending'] is True
    assert agent.journal.get('j1')['state'] == 'SIMULATED_DONE'
    assert agent.run_once()['status'] == 'SIMULATED_DONE'
    assert agent.driver.calls == 1


def test_real_driver_fail_closed(tmp_path):
    with pytest.raises(PrintBlocked):
        GuardedWindowsDriver().send(job())
    agent = PrintAgent(FakeBackend(job()), Journal(tmp_path / 'r.sqlite'), GuardedWindowsDriver())
    with pytest.raises(PrintBlocked):
        agent.run_once()
    j = job(); j['mode'] = 'production'
    agent = PrintAgent(FakeBackend(j), Journal(tmp_path / 'p.sqlite'), DryRunDriver())
    with pytest.raises(PrintBlocked):
        agent.run_once()
