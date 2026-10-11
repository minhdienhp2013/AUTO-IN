"""Backend HTTP Port for AI1's concrete print-job wire contract.

This is a transport only; connecting this client never unlocks physical printing.
All authorization, approval, shop schedule and atomic SENDING checks remain server-side.
"""
from __future__ import annotations

import hashlib
import json
import uuid
from typing import Any
from urllib.parse import quote, urlsplit
from urllib.error import HTTPError
from urllib.request import Request, build_opener, HTTPRedirectHandler


class _RejectRedirects(HTTPRedirectHandler):
    """Never forward a scoped Authorization token to a redirect target."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise HTTPError(req.full_url, code, "Redirects forbidden for agent API", headers, fp)


def urlopen(request, timeout):
    return build_opener(_RejectRedirects()).open(request, timeout=timeout)


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

    def claim(self) -> dict[str, Any] | None:
        # New idempotency key on each independent poll. Never retry an ambiguous
        # POST without reconciling it with server and local journal first.
        data = self._post('/internal/v1/print-jobs/claim',
                          {'printer_id': self.printer_id, 'idempotency_key': uuid.uuid4().hex})
        job = data.get('job')
        if job is not None and not isinstance(job, dict):
            raise ValueError('Invalid claim response')
        return job

    def preflight(self, job: dict[str, Any]) -> dict[str, Any]:
        return self._post(self._job_path(job, 'preflight'), self._lease_payload(job))

    def mark_sending(self, job: dict[str, Any]) -> dict[str, Any]:
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
