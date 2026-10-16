"""One-job *simulated* Windows spooler contract. NO Windows or Ricoh I/O.

Not connected to PrintAgent/CLI. The only accepted transport is the exact
InMemorySpooler test double; implementing a real Windows adapter needs a new,
explicitly reviewed contract and owner authorization. A job/env flag cannot
enable physical printing.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import sqlite3
from typing import Callable

from .agent import Journal, PrintBlocked, SimulatedCrash


def _sha256(blob: bytes) -> str:
    return hashlib.sha256(blob).hexdigest()


def _valid_sha256(value: object) -> bool:
    return (type(value) is str and len(value) == 64 and
            all(ch in '0123456789abcdef' for ch in value))


@dataclass(frozen=True)
class OneJobTicket:
    """Independent test harness authorization; NOT a customer/job JSON field."""
    job_id: str
    order_id: str
    revision: int
    request_hash: str
    approval_id: str
    lease_token: str
    printer_id: str
    queue_name: str
    printer_model: str
    printer_serial: str
    driver_name: str
    port_name: str
    manifest_sha256: str
    source_sha256: str
    preview_sha256: str


@dataclass(frozen=True)
class ObservedPrinter:
    """Mock inventory snapshot, NOT proof of a machine at an IP address."""
    printer_id: str
    queue_name: str
    printer_model: str
    printer_serial: str
    driver_name: str
    port_name: str


class InMemorySpooler:
    """Exact-type test double; stores metadata, never imports Windows or opens ports."""

    def __init__(self, *, lose_ack: bool = False, reject: bool = False):
        self.calls: list[tuple[str, str]] = []
        self.lose_ack = lose_ack
        self.reject = reject

    def submit(self, *, job_id: str, queue_name: str) -> dict[str, object]:
        self.calls.append((job_id, queue_name))
        if self.lose_ack:
            raise ConnectionError('synthetic spooler acknowledgement lost')
        if self.reject:
            return {'accepted': False}
        return {'accepted': True, 'spooler_job_id': 'synthetic-spool-' + str(len(self.calls))}


class OneJobWindowsSpoolerSeam:
    """Fail-closed proof/mark/journal boundary for ONE fake spooler submission.

    Caller must independently supply sealed ticket + trusted preflight and
    mark-sending callbacks; these are simulated tests, not a real approval.
    The same persistent journal cannot ever submit another job, including after
    process restart, uncertain ACK, or an interrupted side-effect boundary.
    """

    def __init__(self, *, journal: Journal, spooler: InMemorySpooler,
                 ticket: OneJobTicket, observed_printer: ObservedPrinter,
                 preflight: Callable[[dict], dict],
                 mark_sending: Callable[[dict], dict]):
        if type(spooler) is not InMemorySpooler:
            raise PrintBlocked('Physical spooler adapter is not implemented or authorized')
        self.journal = journal
        self.spooler = spooler
        self.ticket = ticket
        self.observed_printer = observed_printer
        self.preflight = preflight
        self.mark_sending = mark_sending

    def _validate_before_journal(self, job: dict, *, manifest: bytes,
                                 source: bytes, preview: bytes) -> None:
        t = self.ticket
        if (job.get('mode') != 'simulation' or
                job.get('printer_id') != 'RMP7000' or
                t.printer_id != 'RMP7000' or
                type(job.get('revision')) is not int or
                type(t.revision) is not int or t.revision < 1 or
                not all(_valid_sha256(x) for x in
                        (t.request_hash, t.manifest_sha256, t.source_sha256,
                         t.preview_sha256))):
            raise PrintBlocked('Invalid mode, printer, revision or evidence digest')
        identity = ('job_id', 'order_id', 'revision', 'request_hash',
                    'approval_id', 'lease_token', 'printer_id')
        if any(job.get(name) != getattr(t, name) for name in identity):
            raise PrintBlocked('Job differs from independently sealed one-job ticket')
        if (not all(type(getattr(t, k)) is str and getattr(t, k) for k in
                    ('job_id', 'order_id', 'approval_id', 'lease_token',
                     'queue_name', 'printer_model', 'printer_serial',
                     'driver_name', 'port_name')) or
                not isinstance(manifest, bytes) or
                not isinstance(source, bytes) or
                not isinstance(preview, bytes) or
                not manifest or not source or not preview or
                (_sha256(manifest), _sha256(source), _sha256(preview)) !=
                (t.manifest_sha256, t.source_sha256, t.preview_sha256)):
            raise PrintBlocked('Missing or changed manifest/source/preview bytes')
        observed = self.observed_printer
        if any(getattr(observed, name) != getattr(t, name)
               for name in ('printer_id', 'queue_name', 'printer_model',
                            'printer_serial', 'driver_name', 'port_name')):
            raise PrintBlocked('Printer inventory mismatch; do not submit')

    def recover(self) -> list[str]:
        """Read-only physical outcome: unfinished boundary becomes UNKNOWN."""
        pending = self.journal.unresolved()
        for job_id in pending:
            self.journal.state(job_id, 'UNKNOWN',
                               {'evidence_kind': 'agent_uncertain',
                                'reason': 'restart_no_automatic_resend'})
        return pending

    def submit_once(self, job: dict, *, manifest: bytes,
                    source: bytes, preview: bytes,
                    fault_at: str | None = None) -> dict:
        self._validate_before_journal(job, manifest=manifest,
                                      source=source, preview=preview)
        # Do not even run preflight for an already journaled job or second job.
        # BEGIN IMMEDIATE serializes contenders across processes sharing the
        # persistent SQLite journal. A crash leaves the boundary for recovery.
        self.journal.db.execute('BEGIN IMMEDIATE')
        try:
            previous = self.journal.db.execute('SELECT job_id FROM jobs LIMIT 1').fetchone()
            if previous:
                self.journal.db.execute('COMMIT')
                return {'status': 'UNKNOWN', 'job_id': job['job_id'],
                        'reason': 'ONE_JOB_ALREADY_JOURNALED_NO_RETRY'}
            self.journal.db.execute('COMMIT')
        except Exception:
            self.journal.db.execute('ROLLBACK')
            raise
        try:
            proof = self.preflight(job)
            if (proof.get('allowed') is not True or
                    proof.get('document_evidence_verified') is not True or
                    proof.get('job_id') != job['job_id'] or
                    type(proof.get('revision')) is not int or
                    proof['revision'] != job['revision'] or
                    proof.get('approval_id') != job['approval_id'] or
                    proof.get('mode') != 'simulation'):
                return {'status': 'BLOCKED', 'job_id': job['job_id'],
                        'reason': 'PREFLIGHT_UNVERIFIED'}
        except Exception:
            return {'status': 'BLOCKED', 'job_id': job['job_id'],
                    'reason': 'PREFLIGHT_UNAVAILABLE'}

        # Atomic one-job check+write. This is the irreversible local boundary;
        # never attempt another fake spooler call even if mark ACK is lost.
        self.journal.db.execute('BEGIN IMMEDIATE')
        try:
            if self.journal.db.execute('SELECT job_id FROM jobs LIMIT 1').fetchone():
                self.journal.db.execute('COMMIT')
                return {'status': 'UNKNOWN', 'job_id': job['job_id'],
                        'reason': 'ONE_JOB_ALREADY_JOURNALED_NO_RETRY'}
            self.journal.begin(job)
            self.journal.db.execute('COMMIT')
        except Exception:
            self.journal.db.execute('ROLLBACK')
            raise
        if fault_at == 'after_boundary':
            raise SimulatedCrash('synthetic power loss after durable boundary')
        try:
            marked = self.mark_sending(job)
            if (marked.get('state') != 'SENDING' or
                    marked.get('job_id') != job['job_id'] or
                    marked.get('mode') != 'simulation'):
                raise PrintBlocked('Backend mark-sending ACK mismatch')
        except Exception:
            self.journal.state(job['job_id'], 'UNKNOWN',
                               {'evidence_kind': 'agent_uncertain',
                                'reason': 'mark_sending_ack_uncertain'})
            return {'status': 'UNKNOWN', 'job_id': job['job_id'],
                    'reason': 'MARK_SENDING_ACK_UNCERTAIN'}
        self.journal.state(job['job_id'], 'ARMED')
        if fault_at == 'after_mark':
            raise SimulatedCrash('synthetic crash after confirmed mark')
        self.journal.state(job['job_id'], 'DRIVER_CALLED')
        if fault_at == 'before_spooler':
            raise SimulatedCrash('synthetic crash after durable send boundary')
        try:
            ack = self.spooler.submit(job_id=job['job_id'],
                                     queue_name=self.ticket.queue_name)
            if fault_at == 'after_spooler':
                raise SimulatedCrash('synthetic crash after fake spooler side effect')
            accepted = (ack.get('accepted') is True and
                        isinstance(ack.get('spooler_job_id'), str) and
                        bool(ack['spooler_job_id']))
        except SimulatedCrash:
            raise
        except Exception:
            accepted = False
        # Even a positive spooler ACK is NOT proof that one sheet came out.
        # No VERIFIED_DONE and no automatic report of physical paper.
        reason = ('SPOOLER_ACK_NOT_PAPER_EVIDENCE' if accepted
                  else 'SPOOLER_RESULT_UNCERTAIN')
        self.journal.state(job['job_id'], 'UNKNOWN',
                           {'evidence_kind': 'agent_uncertain', 'reason': reason,
                            'paper_verified': False})
        return {'status': 'UNKNOWN', 'job_id': job['job_id'],
                'paper_verified': False, 'reason': reason}
