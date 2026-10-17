"""Backend HTTP Port for AI1's concrete print-job wire contract.

This is a transport only; connecting this client never unlocks physical printing.
All authorization, approval, shop schedule and atomic SENDING checks remain server-side.
"""
from __future__ import annotations

import hashlib
import json
import uuid
from copy import deepcopy
from typing import Any
from urllib.parse import quote, urlsplit
from urllib.error import HTTPError
from urllib.request import Request, build_opener, HTTPRedirectHandler

from .native_simulation_review import (
    is_safe_preflight_review_result,
    review_preflight_ticket_simulation_only,
)


class _RejectRedirects(HTTPRedirectHandler):
    """Never forward a scoped Authorization token to a redirect target."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise HTTPError(req.full_url, code, "Redirects forbidden for agent API", headers, fp)


def urlopen(request, timeout):
    return build_opener(_RejectRedirects()).open(request, timeout=timeout)


class DocumentEvidenceDenied(RuntimeError):
    """Only verified HTTPS preflight HTTP 409 with exact AI0 evidence code."""


class HttpBackendClient:
    """Use with a scoped print_agent server token and DryRunDriver only."""

    def __init__(self, base_url: str, token: str, printer_id: str = 'RMP7000',
                 timeout: float = 10):
        parsed = urlsplit(base_url)
        if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or
                parsed.password or parsed.query or parsed.fragment):
            raise ValueError('Agent backend must use HTTPS with no URL credentials')
        if not isinstance(token, str) or len(token) < 20 or '\n' in token or '\r' in token:
            raise ValueError('Scoped agent token required')
        if printer_id != 'RMP7000':
            raise ValueError('Only surveyed RMP7000 identity is configured for V1')
        self.base_url = base_url.rstrip('/')
        self.token = token
        self.printer_id = printer_id
        self.timeout = timeout
        # Authenticated preflight ticket is private, in-memory only. It is never
        # copied into the claimed job, journal, report, or log.
        self._preflight_ticket: dict[str, Any] | None = None
        self._preflight_identity: tuple[Any, ...] | None = None

    def _clear_preflight_ticket(self) -> None:
        self._preflight_ticket = None
        self._preflight_identity = None

    def _post(self, suffix: str, body: dict[str, Any]) -> dict[str, Any]:
        request = Request(self.base_url + suffix,
                          data=json.dumps(body, ensure_ascii=False).encode('utf-8'),
                          headers={'Authorization': 'Bearer ' + self.token,
                                   'Content-Type': 'application/json',
                                   'Accept': 'application/json'}, method='POST')
        with urlopen(request, timeout=self.timeout) as response:
            if response.status != 200:
                raise RuntimeError('Unexpected server response')
            payload = response.read(256 * 1024 + 1)
            if len(payload) > 256 * 1024:
                raise ValueError('Oversized backend JSON')
            value = json.loads(payload)
            if not isinstance(value, dict) or 'error' in value:
                raise ValueError('Invalid backend response')
            return value

    @staticmethod
    def _idempotency(job: dict[str, Any], action: str) -> str:
        # Stable across retries of the SAME claimed lease, not across new leases.
        raw = f"ai3:{action}:{job['job_id']}:{job['revision']}:{job['lease_token']}"
        return hashlib.sha256(raw.encode('utf-8')).hexdigest()

    @staticmethod
    def _job_path(job: dict[str, Any], action: str) -> str:
        return '/internal/v1/print-jobs/' + quote(job['job_id'], safe='') + '/' + action

    @staticmethod
    def _lease_payload(job: dict[str, Any]) -> dict[str, Any]:
        return {'expected_revision': job['revision'], 'lease_token': job['lease_token']}

    @staticmethod
    def _identity(job: dict[str, Any]) -> tuple[Any, ...]:
        # Include the entire claimed job/lease identity. A cached preflight for
        # an old lease, order, hash or approval is NEVER sufficient for sending.
        return tuple(job.get(name) for name in (
            'job_id', 'order_id', 'revision', 'request_hash',
            'approval_id', 'printer_id', 'lease_token'
        ))

    def evidence_verified(self, job: dict[str, Any]) -> bool:
        ticket = self._preflight_ticket
        if (ticket is None or self._preflight_identity is None or
                self._preflight_identity != self._identity(job)):
            return False
        try:
            result = review_preflight_ticket_simulation_only(
                preflight_ticket=ticket, claimed_job=job)
            if is_safe_preflight_review_result(result, preflight_ticket=ticket):
                return True
        except Exception:
            # Any local ticket validation error is a fail-closed denial.
            pass
        self._clear_preflight_ticket()
        return False

    def claim(self) -> dict[str, Any] | None:
        # Any new claim invalidates preflight proof, even if HTTP fails.
        self._clear_preflight_ticket()
        # New idempotency key on each independent poll. Never retry an ambiguous
        # POST without reconciling it with server and local journal first.
        data = self._post('/internal/v1/print-jobs/claim',
                          {'printer_id': self.printer_id, 'idempotency_key': uuid.uuid4().hex})
        job = data.get('job')
        if job is not None and not isinstance(job, dict):
            raise ValueError('Invalid claim response')
        return job

    def preflight(self, job: dict[str, Any]) -> dict[str, Any]:
        # Never carry preflight evidence across independent attempts.
        self._clear_preflight_ticket()
        try:
            value = self._post(self._job_path(job, 'preflight'),
                               self._lease_payload(job))
        except HTTPError as error:
            # Only this EXACT HTTP 409 wire error is a safe deterministic
            # denial. Malformed 409, 503, timeouts or lost ACK remain UNKNOWN
            # and must not be silently retried as an unapproved print.
            if error.code == 409:
                try:
                    raw = error.read(4097)
                    if len(raw) <= 4096:
                        payload = json.loads(raw)
                        if (isinstance(payload, dict) and
                                isinstance(payload.get('error'), dict) and
                                payload['error'].get('code') == 'DOCUMENT_EVIDENCE_UNVERIFIED'):
                            raise DocumentEvidenceDenied('DOCUMENT_EVIDENCE_UNVERIFIED')
                except (ValueError, UnicodeError, TypeError):
                    pass
            raise
        if (value.get('document_evidence_verified') is True and
                value.get('allowed') is True and
                value.get('job_id') == job.get('job_id') and
                type(value.get('revision')) is int and
                value['revision'] == job.get('revision') and
                value.get('approval_id') == job.get('approval_id') and
                value.get('mode') == job.get('mode') == 'simulation'):
            # Keep an isolated copy so callers cannot mutate the server ticket
            # returned by preflight after it has been bound to this lease.
            self._preflight_ticket = deepcopy(value)
            self._preflight_identity = self._identity(job)
        return value

    def mark_sending(self, job: dict[str, Any]) -> dict[str, Any]:
        # A new mark requires a fresh preflight and matching exact lease.
        # Clear proof even if HTTP fails/ACK is lost (UNKNOWN path).
        if not self.evidence_verified(job):
            raise RuntimeError('Preflight document proof stale or missing')
        self._clear_preflight_ticket()
        return self._post(self._job_path(job, 'mark-sending'),
                          {**self._lease_payload(job),
                           'idempotency_key': self._idempotency(job, 'mark-sending')})

    def report(self, job: dict[str, Any], state: str, evidence: dict[str, Any]) -> None:
        choices = {'SIMULATED_DONE': ('simulated_done', 'simulated'),
                   'UNKNOWN': ('unknown', 'agent_uncertain')}
        if state not in choices:
            raise ValueError('Agent cannot assert physical printer completion')
        result, kind = choices[state]
        response = self._post(self._job_path(job, 'reports'),
                              {**self._lease_payload(job), 'result': result,
                               'evidence_kind': kind,
                               'idempotency_key': self._idempotency(job, 'report:' + result)})
        if response.get('job_id') != job['job_id'] or response.get('state') != state:
            raise RuntimeError('Report response was not confirmed by server')
