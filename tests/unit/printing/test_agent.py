import copy
import pytest
from agents.windows.agent import (PrintBlocked, DryRunDriver, GuardedWindowsDriver,
                                 FakeBackend, Journal, PrintAgent, SimulatedCrash)


def job():
    return {'job_id': 'j1', 'order_id': 'o1', 'revision': 2,
            'request_hash': 'a' * 64, 'approval_id': 'a1', 'lease_token': 'synthetic-lease-secret', 'lease_seconds': 90,
            'mode': 'simulation', 'printer_id': 'RMP7000'}


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
    backend.preflight = lambda _: {'allowed': False, 'job_id': 'j1', 'revision': 2}
    agent = PrintAgent(backend, Journal(tmp_path / 's1.sqlite'), DryRunDriver())
    assert agent.run_once()['status'] == 'BLOCKED'
    # Local flags do not bypass the authoritative server's preflight decision.
    backend = FakeBackend(job()); backend.allow_preflight = False
    agent = PrintAgent(backend, Journal(tmp_path / 's2.sqlite'), DryRunDriver())
    assert agent.run_once()['status'] == 'BLOCKED'


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
    if fault_at != 'before_mark_sending':
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


def test_ai1_contract_claim_fields_no_client_approval_flags(tmp_path):
    record = job()
    assert 'manual_lock' not in record and 'print_state' not in record
    agent = PrintAgent(FakeBackend(record), Journal(tmp_path / 'ai1.sqlite'), DryRunDriver())
    assert agent.run_once()['status'] == 'SIMULATED_DONE'
    saved = agent.journal.get('j1')
    assert 'synthetic-lease-secret' in saved['job_json']


def test_preflight_rejects_wrong_mode_or_approval(tmp_path):
    for name, bad in [('mode', 'production'), ('approval_id', 'not-current')]:
        backend = FakeBackend(job())
        original = backend.preflight
        backend.preflight = lambda j, original=original, name=name, bad=bad: {
            **original(j), name: bad
        }
        agent = PrintAgent(backend, Journal(tmp_path / (name + '.sqlite')), DryRunDriver())
        assert agent.run_once()['status'] == 'BLOCKED'
        assert agent.driver.calls == 0


def test_mark_sending_mismatched_ack_is_unknown_not_printed(tmp_path):
    backend = FakeBackend(job())
    original = backend.mark_sending
    backend.mark_sending = lambda j: {**original(j), 'mode': 'production'}
    agent = make_agent(tmp_path, backend)
    result = agent.run_once()
    assert result['status'] == 'UNKNOWN'
    assert agent.driver.calls == 0
    assert agent.journal.get('j1')['state'] == 'UNKNOWN'


def test_journal_permissions_fail_closed(tmp_path):
    import os
    if os.name != 'posix':
        pytest.skip('POSIX mode test only')
    p = tmp_path / 'open.sqlite'
    p.write_text('not secure')
    p.chmod(0o644)
    with pytest.raises(PrintBlocked, match='Insecure journal'):
        Journal(p)
    j = Journal(tmp_path / 'new.sqlite')
    assert (tmp_path / 'new.sqlite').stat().st_mode & 0o077 == 0
    j.close()


def test_no_implicit_live_mode_even_with_all_approval_fields(tmp_path):
    for mode in ('controlled_test', 'production', 'safe'):
        pending = job(); pending['mode'] = mode
        agent = PrintAgent(FakeBackend(pending), Journal(tmp_path / (mode + '.sqlite')),
                           DryRunDriver())
        with pytest.raises(PrintBlocked):
            agent.run_once()


def test_cli_explicit_fixture_dry_run_only(tmp_path):
    import json
    import subprocess
    import sys
    path = tmp_path / 'synthetic.json'
    path.write_text(json.dumps(job()), encoding='utf-8')
    cmd = [sys.executable, '-m', 'agents.windows.cli', str(path),
           '--journal', str(tmp_path / 'cli.sqlite')]
    completed = subprocess.run(cmd, capture_output=True, text=True, check=False)
    assert completed.returncode == 0, completed.stderr
    result = json.loads(completed.stdout)
    assert result['mode'] == 'simulation'
    assert result['result']['status'] == 'SIMULATED_DONE'
    assert result['result']['evidence']['paper_verified'] is False


def test_cli_rejects_api_without_credential(tmp_path):
    import subprocess
    import sys
    import os
    env = {**os.environ}
    env.pop('AUTO_IN_AGENT_TOKEN', None)
    completed = subprocess.run([sys.executable, '-m', 'agents.windows.cli',
                                '--api-base-url', 'https://backend.example',
                                '--journal', str(tmp_path / 'cli.sqlite')],
                               capture_output=True, text=True, env=env)
    assert completed.returncode != 0
    assert not (tmp_path / 'cli.sqlite').exists()


def test_recovery_resends_only_lost_report(tmp_path):
    backend = FakeBackend(job()); backend.fail_report = True
    driver = DryRunDriver()
    agent = make_agent(tmp_path, backend, driver)
    assert agent.run_once()['report_pending'] is True
    assert driver.calls == 1
    agent.journal.close()
    backend.fail_report = False
    reopened = make_agent(tmp_path, backend, driver)
    assert reopened.recover() == []
    assert backend.state == 'SIMULATED_DONE'
    assert driver.calls == 1


def test_crash_before_mark_does_not_report_server_unknown(tmp_path):
    backend = FakeBackend(job())
    agent = make_agent(tmp_path, backend)
    with pytest.raises(SimulatedCrash):
        agent.run_once(fault_at='before_mark_sending')
    agent.journal.close()
    recovered = make_agent(tmp_path, backend)
    assert recovered.recover() == ['j1']
    assert backend.state == 'NOT_SENT'
    assert backend.reports == []
    assert recovered.journal.get('j1')['state'] == 'UNKNOWN'


def test_journal_rejects_symlink(tmp_path):
    link = tmp_path / 'journal-link.sqlite'
    target = tmp_path / 'journal-real.sqlite'
    target.touch(mode=0o600)
    try:
        link.symlink_to(target)
    except (OSError, NotImplementedError):
        pytest.skip('symlink not available')
    with pytest.raises(PrintBlocked, match='symbolic link'):
        Journal(link)
