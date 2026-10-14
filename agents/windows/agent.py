"""Crash-conservative print agent. No production print transport is implemented.

Backend owns authorization and atomically transitions to SENDING. Local SQLite
journal is durable BEFORE any driver side effect; unknown results NEVER retry.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import sqlite3
from typing import Any, Callable, Protocol

from .backend_http import DocumentEvidenceDenied


class PrintBlocked(RuntimeError):
    pass


class SimulatedCrash(RuntimeError):
    """Test-only crash boundary hook, never a real print action."""


def _hash_payload(value: dict[str, Any]) -> str:
    payload = json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
    return hashlib.sha256(payload.encode('utf-8')).hexdigest()


class BackendPort(Protocol):
    def claim(self) -> dict[str, Any] | None: ...
    def preflight(self, job: dict[str, Any]) -> dict[str, Any]: ...
    def mark_sending(self, job: dict[str, Any]) -> dict[str, Any]: ...
    def report(self, job: dict[str, Any], state: str, evidence: dict[str, Any]) -> None: ...


class DriverPort(Protocol):
    def send(self, job: dict[str, Any]) -> dict[str, Any]: ...


class Journal:
    """Unique stable job ID, persisted before mark-sending and driver call.

    Database must live on persistent local disk, not ephemeral/tmp/network cache.
    """
    def __init__(self, filename: str | Path):
        self.filename = Path(filename)
        self.filename.parent.mkdir(parents=True, exist_ok=True)
        # Runtime lease credentials require a restrictive on-disk journal.
        # Windows ACL needs validation before production; no real driver is enabled.
        if self.filename.is_symlink():
            raise PrintBlocked('Journal must not be a symbolic link')
        if os.name == 'posix':
            if self.filename.exists():
                if self.filename.stat().st_mode & 0o077:
                    raise PrintBlocked('Insecure journal file permissions')
            else:
                fd = os.open(self.filename, os.O_CREAT | os.O_EXCL | os.O_RDWR, 0o600)
                os.close(fd)
        self.db = sqlite3.connect(str(self.filename), isolation_level=None, timeout=10)
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.execute('CREATE TABLE IF NOT EXISTS jobs ('
                        'job_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, '
                        'request_hash TEXT NOT NULL, payload_hash TEXT NOT NULL, '
                        'state TEXT NOT NULL, evidence TEXT NOT NULL DEFAULT "{}", '
                        'job_json TEXT NOT NULL DEFAULT "{}")')

    def get(self, job_id: str) -> dict[str, Any] | None:
        row = self.db.execute('SELECT job_id, revision, request_hash, payload_hash, state, evidence, job_json '
                              'FROM jobs WHERE job_id=?', (job_id,)).fetchone()
        if not row:
            return None
        return dict(zip(('job_id', 'revision', 'request_hash', 'payload_hash', 'state', 'evidence', 'job_json'), row))

    def begin(self, job: dict[str, Any]) -> None:
        # Persist boundary before asking backend to mark-sending. A restart with
        # BOUNDARY is UNKNOWN until independently reconciled, never auto retried.
        if self.get(job['job_id']):
            raise PrintBlocked('Job already journaled; reconciliation required')
        try:
            self.db.execute('INSERT INTO jobs(job_id,revision,request_hash,payload_hash,state,job_json) '
                            'VALUES(?,?,?,?,?,?)',
                            (job['job_id'], job['revision'], job['request_hash'],
                             _hash_payload(job), 'BOUNDARY', json.dumps({key: job[key] for key in
                              ('job_id', 'order_id', 'revision', 'request_hash', 'approval_id',
                               'lease_token', 'mode', 'printer_id')})))
        except sqlite3.IntegrityError as exc:
            raise PrintBlocked('Duplicate journal job') from exc

    def state(self, job_id: str, state: str, evidence: dict[str, Any] | None = None) -> None:
        row = self.get(job_id)
        if row is None:
            raise PrintBlocked('Missing journal record')
        self.db.execute('UPDATE jobs SET state=?, evidence=? WHERE job_id=?',
                        (state, json.dumps(evidence or {}, ensure_ascii=False), job_id))

    def unresolved(self) -> list[str]:
        rows = self.db.execute("SELECT job_id FROM jobs WHERE state IN ('BOUNDARY','ARMED','DRIVER_CALLED')")
        return [r[0] for r in rows]

    def reportable(self) -> list[dict[str, Any]]:
        rows = self.db.execute("SELECT job_id FROM jobs WHERE state IN ('UNKNOWN','SIMULATED_DONE')")
        return [self.get(row[0]) for row in rows]

    def close(self) -> None:
        self.db.close()


class DryRunDriver:
    """Never touches Windows spooler/ports; useful for safe end-to-end testing."""
    calls: int = 0

    def send(self, job: dict[str, Any]) -> dict[str, Any]:
        self.calls += 1
        return {'evidence_kind': 'simulated', 'mode': 'simulation',
                'driver': 'dry_run', 'paper_verified': False}


class GuardedWindowsDriver:
    """Placeholder. Fail closed; no RAW-9100/PDF bytes or unverified COM automation."""
    def send(self, job: dict[str, Any]) -> dict[str, Any]:
        raise PrintBlocked('Real printing disabled pending verified Windows/Ricoh path and owner approval')


@dataclass
class PrintAgent:
    backend: BackendPort
    journal: Journal
    driver: DriverPort
    # CODE-403: optional *server-bound* evidence gate. The actual product
    # backend remains authoritative for approval/revision/manifest binding.
    # If provided, failure blocks BEFORE durable BOUNDARY/mark-sending/driver.
    # This callback is NOT taken from a job JSON field or customer/webhook.
    evidence_gate: Callable[[dict[str, Any]], bool] | None = None

    def recover(self) -> list[str]:
        pending = self.journal.unresolved()
        for job_id in pending:
            evidence = {'evidence_kind': 'agent_uncertain',
                        'reason': 'crash_boundary_cannot_prove_not_sent'}
            self.journal.state(job_id, 'UNKNOWN', evidence)
            # Report ambiguity without ever resending. A rejected report remains
            # in the journal for an operator to reconcile with the server.
            saved = self.journal.get(job_id)
            try:
                self.backend.report(json.loads(saved['job_json']), 'UNKNOWN', evidence)
            except Exception:
                pass
        # A server report is idempotent; a printer driver side effect is NOT.
        # Retransmit any locally persisted report after a restart without print.
        for saved in self.journal.reportable():
            try:
                job = json.loads(saved['job_json'])
                self.backend.report(job, saved['state'], json.loads(saved['evidence']))
            except Exception:
                # Non-SENDING server job or rejected lease needs staff reconciliation.
                pass
        return pending

    def run_once(self, *, fault_at: str | None = None) -> dict[str, Any]:
        job = self.backend.claim()
        if job is None:
            return {'status': 'NO_JOB'}
        self._verify_job(job)
        if (previous := self.journal.get(job['job_id'])):
            # Re-report known outcomes safely. NEVER repeat the driver side effect.
            if previous['payload_hash'] != _hash_payload(job):
                return {'status': 'UNKNOWN', 'job_id': job['job_id'], 'reason': 'JOB_PAYLOAD_CHANGED'}
            saved_state = previous['state']
            if saved_state in ('UNKNOWN', 'SIMULATED_DONE'):
                evidence = json.loads(previous['evidence'])
                try:
                    self.backend.report(job, saved_state, evidence)
                    return {'status': saved_state, 'job_id': job['job_id'], 'reconciled': True}
                except Exception:
                    return {'status': saved_state, 'job_id': job['job_id'], 'report_pending': True}
            return {'status': 'UNKNOWN', 'job_id': job['job_id'],
                    'reason': 'EXISTING_JOURNAL_NO_AUTOMATIC_RETRY'}
        # Server preflight must be authoritative, not a client-provided approved flag.
        try:
            check = self.backend.preflight(job)
        except DocumentEvidenceDenied:
            # Only a signed HTTPS server's exact 409 evidence code is BLOCKED
            # before journal; other HTTP/network/ACK errors propagate UNKNOWN.
            return {'status': 'BLOCKED', 'job_id': job['job_id'],
                    'reason': 'DOCUMENT_EVIDENCE_UNVERIFIED'}
        if (check.get('allowed') is not True or check.get('job_id') != job['job_id']
                or check.get('revision') != job['revision'] or check.get('mode') != 'simulation'
                or check.get('approval_id') != job['approval_id']):
            return {'status': 'BLOCKED', 'job_id': job['job_id'], 'reason': 'SERVER_PREFLIGHT_DENIED'}
        if self.evidence_gate is not None:
            try:
                # Reject truthy dictionaries such as {"status":"NEEDS_HUMAN"}.
                # Only an exact boolean True from a trusted evidence verifier
                # is acceptable. Never grant print approval here.
                if self.evidence_gate(job) is not True:
                    return {'status': 'BLOCKED', 'job_id': job['job_id'],
                            'reason': 'DOCUMENT_EVIDENCE_UNVERIFIED'}
            except Exception:
                return {'status': 'BLOCKED', 'job_id': job['job_id'],
                        'reason': 'DOCUMENT_EVIDENCE_UNVERIFIED'}
        self.journal.begin(job)
        if fault_at == 'before_mark_sending':
            raise SimulatedCrash('before_mark_sending')
        try:
            marked = self.backend.mark_sending(job)
            if (marked.get('state') != 'SENDING' or marked.get('job_id') != job['job_id']
                    or marked.get('mode') != 'simulation'):
                return self._uncertain(job, 'MARK_SENDING_NOT_CONFIRMED')
        except Exception:
            return self._uncertain(job, 'MARK_SENDING_AMBIGUOUS')
        self.journal.state(job['job_id'], 'ARMED')
        if fault_at == 'after_mark_sending':
            raise SimulatedCrash('after_mark_sending')
        self.journal.state(job['job_id'], 'DRIVER_CALLED')
        if fault_at == 'after_journal_before_driver':
            raise SimulatedCrash('after_journal_before_driver')
        try:
            evidence = self.driver.send(job)
            if fault_at == 'after_driver':
                raise SimulatedCrash('after_driver')
            if (evidence.get('mode') != 'simulation' or
                    evidence.get('evidence_kind') != 'simulated' or
                    evidence.get('paper_verified') is not False):
                # A DryRun may NEVER assert real paper even if a subclass,
                # fixture or backend accidentally marks it verified.
                raise PrintBlocked('Unverified driver evidence')
            status = 'SIMULATED_DONE'
        except SimulatedCrash:
            raise
        except Exception:
            evidence = {'evidence_kind': 'agent_uncertain', 'reason': 'DRIVER_RESULT_AMBIGUOUS'}
            status = 'UNKNOWN'
        self.journal.state(job['job_id'], status, evidence)
        try:
            self.backend.report(job, status, evidence)
        except Exception:
            # Journal is authoritative for recovery. Never call the driver again.
            return {'status': status, 'job_id': job['job_id'], 'report_pending': True}
        return {'status': status, 'job_id': job['job_id'], 'evidence': evidence}

    def _uncertain(self, job: dict[str, Any], reason: str) -> dict[str, Any]:
        evidence = {'evidence_kind': 'agent_uncertain', 'reason': reason}
        self.journal.state(job['job_id'], 'UNKNOWN', evidence)
        try:
            self.backend.report(job, 'UNKNOWN', evidence)
        except Exception:
            return {'status': 'UNKNOWN', 'job_id': job['job_id'], 'report_pending': True}
        return {'status': 'UNKNOWN', 'job_id': job['job_id']}

    def _verify_job(self, job: dict[str, Any]) -> None:
        if job.get('mode') != 'simulation' or not isinstance(self.driver, DryRunDriver):
            raise PrintBlocked('Real driver paths intentionally disabled')
        if job.get('printer_id') != 'RMP7000':
            raise PrintBlocked('Invalid printer identity')
        # Never trust client flags for approval or manual lock; AI1 server validates.
        for field in ('job_id', 'order_id', 'approval_id', 'lease_token', 'request_hash'):
            if not isinstance(job.get(field), str) or not job[field]:
                raise PrintBlocked(f'Missing {field}')
        if (type(job.get('revision')) is not int or job['revision'] < 1 or
                type(job.get('lease_seconds')) is not int or job['lease_seconds'] <= 0 or
                not isinstance(job.get('request_hash'), str) or
                len(job['request_hash']) != 64 or
                any(c not in '0123456789abcdef' for c in job['request_hash'])):
            raise PrintBlocked('Invalid revision or hash')


class FakeBackend:
    """Test-only backend; never accepts a real network credential."""
    def __init__(self, job: dict[str, Any]):
        self.job = job.copy()
        self.state = 'NOT_SENT'
        self.reports: list[tuple[str, dict[str, Any]]] = []
        self.allow_preflight = True
        self.fail_mark = False
        self.fail_report = False

    def claim(self) -> dict[str, Any] | None:
        # Returning once can simulate a repeated network delivery: agent journal blocks it.
        return self.job.copy()

    def preflight(self, job: dict[str, Any]) -> dict[str, Any]:
        return {'allowed': self.allow_preflight and self.state == 'NOT_SENT'
                and job == self.job, 'job_id': job['job_id'], 'revision': job['revision'],
                'mode': self.job['mode'], 'approval_id': self.job['approval_id']}

    def mark_sending(self, job: dict[str, Any]) -> dict[str, Any]:
        if self.fail_mark:
            self.state = 'SENDING'
            raise ConnectionError('Simulated lost mark-sending response')
        if self.state != 'NOT_SENT' or job != self.job:
            return {'allowed': False}
        self.state = 'SENDING'
        return {'state': 'SENDING', 'job_id': job['job_id'], 'mode': job['mode']}

    def report(self, job: dict[str, Any], state: str, evidence: dict[str, Any]) -> None:
        if self.fail_report:
            raise ConnectionError('Simulated reporting outage')
        if state not in ('SIMULATED_DONE', 'UNKNOWN'):
            raise PrintBlocked('Fake server rejects physical print evidence')
        if self.state != 'SENDING' and self.state != state:
            raise PrintBlocked('Server rejects report for NOT_SENT/nonmatching state')
        self.state = state
        self.reports.append((state, evidence))
