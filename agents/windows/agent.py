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
import sys
from typing import Any, Protocol


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
                               'claim_id', 'mode', 'print_state', 'printer_id', 'manual_lock')})))
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

    def recover(self) -> list[str]:
        pending = self.journal.unresolved()
        for job_id in pending:
            evidence = {'evidence_kind': 'local_recovery',
                        'reason': 'crash_boundary_cannot_prove_not_sent'}
            self.journal.state(job_id, 'UNKNOWN', evidence)
            # Report ambiguity without ever resending. A rejected report remains
            # in the journal for an operator to reconcile with the server.
            saved = self.journal.get(job_id)
            try:
                self.backend.report(json.loads(saved['job_json']), 'UNKNOWN', evidence)
            except Exception:
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
        check = self.backend.preflight(job)
        if check.get('allow') is not True or check.get('job_id') != job['job_id'] or check.get('revision') != job['revision']:
            return {'status': 'BLOCKED', 'job_id': job['job_id'], 'reason': 'SERVER_PREFLIGHT_DENIED'}
        self.journal.begin(job)
        if fault_at == 'before_mark_sending':
            raise SimulatedCrash('before_mark_sending')
        try:
            marked = self.backend.mark_sending(job)
            if (marked.get('allowed') is not True or marked.get('job_id') != job['job_id']
                    or marked.get('revision') != job['revision']
                    or marked.get('request_hash') != job['request_hash']):
                self.journal.state(job['job_id'], 'UNKNOWN', {'reason': 'MARK_SENDING_NOT_CONFIRMED'})
                return {'status': 'UNKNOWN', 'job_id': job['job_id']}
        except Exception:
            self.journal.state(job['job_id'], 'UNKNOWN', {'reason': 'MARK_SENDING_AMBIGUOUS'})
            return {'status': 'UNKNOWN', 'job_id': job['job_id']}
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
            if evidence.get('mode') != 'simulation' or evidence.get('evidence_kind') != 'simulated':
                raise PrintBlocked('Unverified driver evidence')
            status = 'SIMULATED_DONE'
        except SimulatedCrash:
            raise
        except Exception:
            evidence = {'evidence_kind': 'local_error', 'reason': 'DRIVER_RESULT_AMBIGUOUS'}
            status = 'UNKNOWN'
        self.journal.state(job['job_id'], status, evidence)
        try:
            self.backend.report(job, status, evidence)
        except Exception:
            # Journal is authoritative for recovery. Never call the driver again.
            return {'status': status, 'job_id': job['job_id'], 'report_pending': True}
        return {'status': status, 'job_id': job['job_id'], 'evidence': evidence}

    def _verify_job(self, job: dict[str, Any]) -> None:
        if job.get('mode') != 'simulation' or not isinstance(self.driver, DryRunDriver):
            raise PrintBlocked('Real driver paths intentionally disabled')
        if (job.get('print_state') != 'NOT_SENT' or job.get('printer_id') != 'RMP7000'
                or job.get('manual_lock') is not False):
            raise PrintBlocked('Invalid printer, job state or manual lock')
        for field in ('job_id', 'order_id', 'approval_id', 'claim_id', 'request_hash'):
            if not isinstance(job.get(field), str) or not job[field]:
                raise PrintBlocked(f'Missing {field}')
        if (type(job.get('revision')) is not int or job['revision'] < 1 or
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
        return {'allow': self.allow_preflight and self.state == 'NOT_SENT'
                and job == self.job, 'job_id': job['job_id'], 'revision': job['revision']}

    def mark_sending(self, job: dict[str, Any]) -> dict[str, Any]:
        if self.fail_mark:
            self.state = 'SENDING'
            raise ConnectionError('Simulated lost mark-sending response')
        if self.state != 'NOT_SENT' or job != self.job:
            return {'allowed': False}
        self.state = 'SENDING'
        return {'allowed': True, 'job_id': job['job_id'], 'revision': job['revision'],
                'request_hash': job['request_hash']}

    def report(self, job: dict[str, Any], state: str, evidence: dict[str, Any]) -> None:
        if self.fail_report:
            raise ConnectionError('Simulated reporting outage')
        self.state = state
        self.reports.append((state, evidence))
