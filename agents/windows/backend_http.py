"""Narrow transport for server-authoritative internal print-job routes.

This client is intentionally unusable without HTTPS + a scoped agent token.
It does NOT enable real driver printing. Response shapes may need AI0 mapping.
"""
from __future__ import annotations

import json
from typing import Any
from urllib.parse import quote, urlsplit
from urllib.request import Request, urlopen


class HttpBackendClient:
    def __init__(self, base_url: str, token: str, timeout: float = 10):
        parsed = urlsplit(base_url)
        if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError('Agent backend must use HTTPS with no URL credentials')
        if not token or len(token) < 20:
            raise ValueError('Scoped agent token required')
        self.base_url = base_url.rstrip('/')
        self.token = token
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
            if not isinstance(value, dict):
                raise ValueError('Invalid backend JSON')
            return value

    def claim(self) -> dict[str, Any] | None:
        data = self._post('/internal/v1/print-jobs/claim', {})
        return data.get('job')

    def preflight(self, job: dict[str, Any]) -> dict[str, Any]:
        return self._post(self._job_path(job, 'preflight'), self._identity(job))

    def mark_sending(self, job: dict[str, Any]) -> dict[str, Any]:
        return self._post(self._job_path(job, 'mark-sending'), self._identity(job))

    def report(self, job: dict[str, Any], state: str, evidence: dict[str, Any]) -> None:
        self._post(self._job_path(job, 'reports'), {**self._identity(job), 'state': state,
                                                   'evidence': evidence})

    @staticmethod
    def _identity(job: dict[str, Any]) -> dict[str, Any]:
        return {key: job[key] for key in ('job_id', 'order_id', 'revision',
                                          'request_hash', 'approval_id', 'claim_id')}

    @staticmethod
    def _job_path(job: dict[str, Any], action: str) -> str:
        return '/internal/v1/print-jobs/' + quote(job['job_id'], safe='') + '/' + action
