"""CODE-403 fake-only Windows spooler boundary tests. No OS printer calls."""
from dataclasses import replace
import hashlib

import pytest

from agents.windows.agent import Journal, PrintBlocked, SimulatedCrash
from agents.windows.controlled_spooler import (
    InMemorySpooler, ObservedPrinter, OneJobTicket, OneJobWindowsSpoolerSeam,
)


def digest(data):
    return hashlib.sha256(data).hexdigest()


MANIFEST = b'{"schema":"test-only-synthetic","files":[]}'
SOURCE = b'test source bytes (not a Ricoh print language)'
PREVIEW = b'synthetic preview bytes (not actual PNG)'


def ticket():
    return OneJobTicket(
        job_id='one-job', order_id='one-order', revision=2,
        request_hash='a' * 64, approval_id='one-approval',
        lease_token='fake-test-lease-only', printer_id='RMP7000',
        queue_name='SYNTHETIC-RMP7000', printer_model='Ricoh IM7000 fixture',
        printer_serial='MOCK-0001', driver_name='Mock PCL6 (not installed)',
        port_name='MOCK-PORT', manifest_sha256=digest(MANIFEST),
        source_sha256=digest(SOURCE), preview_sha256=digest(PREVIEW),
    )


def observed(t):
    return ObservedPrinter(
        printer_id=t.printer_id, queue_name=t.queue_name,
        printer_model=t.printer_model, printer_serial=t.printer_serial,
        driver_name=t.driver_name, port_name=t.port_name,
    )


def job(t):
    return {
        'job_id': t.job_id, 'order_id': t.order_id,
        'revision': t.revision, 'request_hash': t.request_hash,
        'approval_id': t.approval_id, 'lease_token': t.lease_token,
        'printer_id': t.printer_id, 'mode': 'simulation',
        'lease_seconds': 90,
    }


def preflight(j):
    return {'allowed': True, 'document_evidence_verified': True,
            'job_id': j['job_id'], 'revision': j['revision'],
            'approval_id': j['approval_id'], 'mode': 'simulation'}


def mark(j):
    return {'state': 'SENDING', 'job_id': j['job_id'], 'mode': 'simulation'}


def setup(tmp_path, *, t=None, o=None, f=None, m=None, spooler=None):
    t = t or ticket()
    spooler = spooler or InMemorySpooler()
    journal = Journal(tmp_path / 'one.sqlite')
    a = OneJobWindowsSpoolerSeam(
        journal=journal, spooler=spooler, ticket=t,
        observed_printer=o or observed(t),
        preflight=f or preflight, mark_sending=m or mark)
    return a, spooler


def submit(a, j=None, *, manifest=MANIFEST, source=SOURCE, preview=PREVIEW, **extra):
    return a.submit_once(j or job(a.ticket), manifest=manifest,
                         source=source, preview=preview, **extra)


def test_one_spooler_ack_is_unknown_not_verified_or_retried(tmp_path):
    adapter, spooler = setup(tmp_path)
    first = submit(adapter)
    assert first == {
        'status': 'UNKNOWN', 'job_id': 'one-job',
        'paper_verified': False, 'reason': 'SPOOLER_ACK_NOT_PAPER_EVIDENCE'
    }
    assert spooler.calls == [('one-job', 'SYNTHETIC-RMP7000')]
    saved = adapter.journal.get('one-job')
    assert saved['state'] == 'UNKNOWN'
    assert 'VERIFIED_DONE' not in saved['evidence']
    assert submit(adapter)['status'] == 'UNKNOWN'
    assert len(spooler.calls) == 1
    adapter.journal.close()
    restarted, same_spooler = setup(tmp_path, spooler=spooler)
    assert restarted.recover() == []
    assert submit(restarted)['reason'] == 'ONE_JOB_ALREADY_JOURNALED_NO_RETRY'
    assert len(same_spooler.calls) == 1
    restarted.journal.close()


@pytest.mark.parametrize(('field', 'wrong'), [
    ('job_id', 'job-from-another-order'),
    ('order_id', 'changed-order'),
    ('revision', 3),
    ('revision', True),
    ('request_hash', 'b' * 64),
    ('approval_id', 'wrong-approval'),
    ('lease_token', 'new-lease'),
    ('printer_id', 'different-printer'),
    ('mode', 'production'),
])
def test_untrusted_job_change_denied_before_journal_or_spooler(tmp_path, field, wrong):
    a, spooler = setup(tmp_path)
    changed = {**job(a.ticket), field: wrong}
    with pytest.raises(PrintBlocked):
        submit(a, changed)
    assert a.journal.get('one-job') is None
    assert spooler.calls == []
    a.journal.close()


@pytest.mark.parametrize('name', [
    'printer_id', 'queue_name', 'printer_model', 'printer_serial',
    'driver_name', 'port_name'
])
def test_observed_queue_driver_serial_mismatch_denied(tmp_path, name):
    t = ticket()
    wrong = replace(observed(t), **{name: 'UNKNOWN-DEVICE'})
    a, spooler = setup(tmp_path, t=t, o=wrong)
    with pytest.raises(PrintBlocked, match='Printer inventory mismatch'):
        submit(a)
    assert a.journal.get(t.job_id) is None
    assert spooler.calls == []
    a.journal.close()


@pytest.mark.parametrize(('field', 'value'), [
    ('manifest', b'modified manifest'),
    ('source', b'modified source'),
    ('preview', b'modified preview'),
    ('manifest', b''),
])
def test_source_manifest_preview_tampering_denied_before_boundary(tmp_path, field, value):
    a, spooler = setup(tmp_path)
    with pytest.raises(PrintBlocked, match='manifest/source/preview'):
        submit(a, **{field: value})
    assert spooler.calls == []
    assert a.journal.get('one-job') is None
    a.journal.close()


@pytest.mark.parametrize('tamper', [
    {'document_evidence_verified': False},
    {'document_evidence_verified': 1},
    {'document_evidence_verified': 'true'},
    {'allowed': False},
    {'job_id': 'other-job'},
    {'revision': 3},
    {'revision': True},
    {'approval_id': 'old-approval'},
    {'mode': 'production'},
])
def test_unverified_or_stale_server_preflight_denied_before_boundary(tmp_path, tamper):
    a, spooler = setup(tmp_path, f=lambda j: {**preflight(j), **tamper})
    assert submit(a)['status'] == 'BLOCKED'
    assert a.journal.get('one-job') is None
    assert spooler.calls == []
    a.journal.close()


def test_preflight_transport_error_never_spools(tmp_path):
    def fail(_):
        raise ConnectionError('synthetic preflight unavailable')
    a, spooler = setup(tmp_path, f=fail)
    assert submit(a)['reason'] == 'PREFLIGHT_UNAVAILABLE'
    assert spooler.calls == []
    assert a.journal.get('one-job') is None
    a.journal.close()


@pytest.mark.parametrize('kind', ['exception', 'wrong_job', 'wrong_mode'])
def test_mark_ack_uncertain_unknown_and_no_resend(tmp_path, kind):
    def mark_fake(j):
        if kind == 'exception':
            raise ConnectionError('synthetic lost ACK after mark side effect')
        return {**mark(j), **({'job_id': 'other'} if kind == 'wrong_job' else
                               {'mode': 'production'})}
    a, spooler = setup(tmp_path, m=mark_fake)
    assert submit(a)['reason'] == 'MARK_SENDING_ACK_UNCERTAIN'
    assert a.journal.get('one-job')['state'] == 'UNKNOWN'
    assert spooler.calls == []
    assert submit(a)['status'] == 'UNKNOWN'
    a.journal.close()
    restarted, _ = setup(tmp_path, spooler=spooler)
    assert submit(restarted)['status'] == 'UNKNOWN'
    assert spooler.calls == []
    restarted.journal.close()


@pytest.mark.parametrize('fault', [
    'after_boundary', 'after_mark', 'before_spooler', 'after_spooler'
])
def test_power_loss_recovery_unknown_never_resubmits(tmp_path, fault):
    a, spooler = setup(tmp_path)
    with pytest.raises(SimulatedCrash):
        submit(a, fault_at=fault)
    expected = 1 if fault == 'after_spooler' else 0
    assert len(spooler.calls) == expected
    assert a.journal.get('one-job')['state'] in ('BOUNDARY', 'ARMED', 'DRIVER_CALLED')
    a.journal.close()
    restarted, _ = setup(tmp_path, spooler=spooler)
    assert restarted.recover() == ['one-job']
    assert restarted.journal.get('one-job')['state'] == 'UNKNOWN'
    assert submit(restarted)['status'] == 'UNKNOWN'
    assert len(spooler.calls) == expected
    restarted.journal.close()


@pytest.mark.parametrize('settings', [
    {'lose_ack': True}, {'reject': True}
])
def test_spooler_lost_ack_or_reject_never_retries(tmp_path, settings):
    spooler = InMemorySpooler(**settings)
    a, _ = setup(tmp_path, spooler=spooler)
    assert submit(a)['reason'] == 'SPOOLER_RESULT_UNCERTAIN'
    assert len(spooler.calls) == 1
    assert a.journal.get('one-job')['state'] == 'UNKNOWN'
    assert submit(a)['status'] == 'UNKNOWN'
    assert len(spooler.calls) == 1
    a.journal.close()


def test_one_journal_denies_second_distinct_job(tmp_path):
    a, spooler = setup(tmp_path)
    submit(a)
    a.journal.close()
    second = replace(ticket(), job_id='second-job', order_id='second-order')
    new, _ = setup(tmp_path, t=second, spooler=spooler)
    assert submit(new)['reason'] == 'ONE_JOB_ALREADY_JOURNALED_NO_RETRY'
    assert len(spooler.calls) == 1
    assert new.journal.get('second-job') is None
    new.journal.close()


def test_environment_job_flags_cannot_enable_physical_transport(tmp_path, monkeypatch):
    monkeypatch.setenv('AUTO_IN_ENABLE_REAL_PRINT', '1')
    monkeypatch.setenv('AUTO_IN_WINDOWS_QUEUE', 'some-real-printer')
    t = ticket()
    a, spooler = setup(tmp_path)
    flagged = {**job(t), 'print_live': True, 'spooler': 'real',
               'driver': 'win32print', 'paper_verified': True}
    assert submit(a, flagged)['status'] == 'UNKNOWN'
    assert spooler.calls == [('one-job', 'SYNTHETIC-RMP7000')]
    a.journal.close()

    class SubclassWithArbitraryTransport(InMemorySpooler):
        pass

    with pytest.raises(PrintBlocked, match='Physical spooler'):
        OneJobWindowsSpoolerSeam(
            journal=Journal(tmp_path / 'different.sqlite'),
            spooler=SubclassWithArbitraryTransport(),
            ticket=t, observed_printer=observed(t),
            preflight=preflight, mark_sending=mark)


def test_journal_persists_no_automatic_recovery_spooler_call(tmp_path):
    a, spooler = setup(tmp_path)
    with pytest.raises(SimulatedCrash):
        submit(a, fault_at='before_spooler')
    a.journal.close()
    replay, _ = setup(tmp_path, spooler=spooler)
    assert replay.recover() == ['one-job']
    assert replay.recover() == []
    assert submit(replay)['status'] == 'UNKNOWN'
    assert spooler.calls == []
    replay.journal.close()


def test_two_interleaved_claims_cannot_bypass_one_job_boundary(tmp_path):
    """Nested preflight models contenders both passing the first empty check."""
    base = ticket()
    spooler = InMemorySpooler()
    outer_journal = Journal(tmp_path / 'shared.sqlite')
    inner_journal = Journal(tmp_path / 'shared.sqlite')
    counts = {'mark': 0}

    def once_mark(j):
        counts['mark'] += 1
        return mark(j)

    inner = OneJobWindowsSpoolerSeam(
        journal=inner_journal, spooler=spooler, ticket=base,
        observed_printer=observed(base), preflight=preflight,
        mark_sending=once_mark)
    interleaved_results = []

    def overlapping_preflight(j):
        interleaved_results.append(submit(inner))
        return preflight(j)

    outer = OneJobWindowsSpoolerSeam(
        journal=outer_journal, spooler=spooler, ticket=base,
        observed_printer=observed(base), preflight=overlapping_preflight,
        mark_sending=once_mark)
    try:
        result = submit(outer)
        assert result['reason'] == 'ONE_JOB_ALREADY_JOURNALED_NO_RETRY'
        assert interleaved_results[0]['reason'] == 'SPOOLER_ACK_NOT_PAPER_EVIDENCE'
        assert len(spooler.calls) == counts['mark'] == 1
        assert outer_journal.get(base.job_id)['state'] == 'UNKNOWN'
        assert outer_journal.db.execute('SELECT COUNT(*) FROM jobs').fetchone()[0] == 1
    finally:
        outer_journal.close()
        inner_journal.close()


def test_journal_write_failure_never_marks_or_submits(tmp_path, monkeypatch):
    """SQLite boundary error must stop before mark and fake spooler call."""
    a, spooler = setup(tmp_path)
    marked = []

    def fake_mark(j):
        marked.append(j['job_id'])
        return mark(j)

    a.mark_sending = fake_mark

    def fail_write(_job):
        import sqlite3
        raise sqlite3.OperationalError('synthetic durable journal write failed')

    monkeypatch.setattr(a.journal, 'begin', fail_write)
    try:
        with pytest.raises(Exception, match='journal write failed'):
            submit(a)
        assert spooler.calls == []
        assert marked == []
        assert a.journal.get('one-job') is None
    finally:
        a.journal.close()
