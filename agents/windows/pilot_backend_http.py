"""HTTP client for the isolated AI0 V1 pilot Agent lane.

The existing approval-based print-job API remains in ``backend_http``. This
client uses only the distinct shop-code pilot routes and never retries an
ambiguous POST. Source bytes are fetched separately and bound to the active
lease before they are handed to ``PilotPrintAgent``.
"""
from __future__ import annotations

import hashlib
import ipaddress
import json
import math
import uuid
from copy import deepcopy
from typing import Any
from urllib.error import HTTPError
from urllib.parse import quote, urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler

from .pilot_native_print import PilotPrintWork
from workers.documents.pilot_source_ticket import MAX_PUBLIC_SOURCE_BYTES


class _RejectRedirects(HTTPRedirectHandler):
    """Do not forward a scoped agent token or lease to a redirect target."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise HTTPError(req.full_url, code, "Redirects forbidden for pilot Agent", headers, fp)


def urlopen(request, timeout):
    return build_opener(_RejectRedirects()).open(request, timeout=timeout)


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON key")
        result[key] = value
    return result


def _decode_json(raw: bytes) -> dict[str, Any]:
    value = json.loads(raw, object_pairs_hook=_unique_object,
                       parse_constant=lambda _value: (_ for _ in ()).throw(
                           ValueError("Non-finite JSON number")))
    if not isinstance(value, dict) or "error" in value:
        raise ValueError("Invalid pilot Core response")
    return value


def _loopback(hostname: str | None) -> bool:
    if hostname == "localhost":
        return True
    if not hostname:
        return False
    try:
        return ipaddress.ip_address(hostname).is_loopback
    except ValueError:
        return False


def _plain_evidence(evidence: object) -> dict[str, str | int | float | bool | None]:
    if not isinstance(evidence, dict):
        raise ValueError("Pilot report evidence must be an object")
    result: dict[str, str | int | float | bool | None] = {}
    forbidden = {"code", "raw_code", "source", "source_bytes", "credential", "token"}
    for key, value in evidence.items():
        if type(key) is not str or not key or key.casefold() in forbidden:
            raise ValueError("Sensitive pilot evidence field")
        if (value is not None and type(value) not in (str, int, float, bool)):
            raise ValueError("Pilot report evidence value is not scalar")
        if type(value) is float and not math.isfinite(value):
            raise ValueError("Non-finite pilot report evidence")
        if type(value) is str and len(value) > 1024:
            raise ValueError("Oversized pilot report evidence")
        result[key] = value
    return result


class PilotHttpBackendClient:
    """Call the locked ``/internal/v1/pilot/print-jobs`` wire over HTTP(S).

    Plain HTTP is permitted only for a loopback simulation server. A nonlocal
    Core must use HTTPS. This client is transport-only; Core owns authorization.
    """

    _JOB_FIELDS = {"job_id", "order_id", "revision", "request_hash", "printer_id",
                   "lease_token", "lease_seconds", "mode"}
    _CANDIDATE_FIELDS = {"shop_id", "oa_id", "customer_id", "conversation_id", "order_id",
                         "revision", "request_hash", "source", "settings",
                         "settings_sha256", "printer_id"}
    _SOURCE_FIELDS = {"format", "artifact_ref", "sha256", "size_bytes", "provider_event_id"}
    _AUTH_FIELDS = {"schema", "shop_id", "oa_id", "customer_id", "order_id", "revision",
                    "request_hash", "source_sha256", "settings_sha256", "evidence_sha256",
                    "printer_id", "code_window_id", "provider_event_id", "authorized_at", "job_id"}
    _GATE_FIELDS = {"schema", "state", "job_id", "order_id", "revision", "request_hash",
                    "source_sha256", "settings_sha256", "evidence_sha256", "printer_id"}

    def __init__(self, base_url: str, token: str, printer_id: str = "RMP7000",
                 timeout: float = 10):
        parsed = urlsplit(base_url)
        if (parsed.scheme not in ("https", "http") or not parsed.hostname or
                parsed.username or parsed.password or parsed.query or parsed.fragment or
                parsed.path not in ("", "/")):
            raise ValueError("Pilot Core URL invalid")
        if parsed.scheme == "http" and not _loopback(parsed.hostname):
            raise ValueError("Pilot HTTP is allowed only for loopback simulation")
        if type(token) is not str or len(token) < 20 or "\r" in token or "\n" in token:
            raise ValueError("Scoped pilot Agent token required")
        if printer_id != "RMP7000":
            raise ValueError("Only configured pilot printer identity is supported")
        if type(timeout) not in (int, float) or not 1 <= timeout <= 30:
            raise ValueError("Pilot HTTP timeout must be in 1..30 seconds")
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.printer_id = printer_id
        self.timeout = float(timeout)
        self._claimed_snapshot: tuple[dict[str, Any], dict[str, Any], dict[str, Any]] | None = None

    def _request(self, method: str, suffix: str, *, body: dict[str, Any] | None = None,
                 accept: str = "application/json"):
        raw = None if body is None else json.dumps(
            body, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
            allow_nan=False).encode("utf-8")
        headers = {"Authorization": "Bearer " + self.token, "Accept": accept,
                   "Cache-Control": "no-store"}
        if body is not None:
            headers["Content-Type"] = "application/json"
        request = Request(self.base_url + suffix, data=raw, headers=headers, method=method)
        return urlopen(request, timeout=self.timeout)

    @staticmethod
    def _read_json(response) -> dict[str, Any]:
        if response.status != 200:
            raise RuntimeError("Unexpected pilot Core response")
        payload = response.read(1024 * 1024 + 1)
        if len(payload) > 1024 * 1024:
            raise ValueError("Oversized pilot Core response")
        return _decode_json(payload)

    @staticmethod
    def _validate_envelope(value: object) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]] | None:
        if (not isinstance(value, dict) or
                set(value) != {"schema", "work"} or
                value.get("schema") != "ai0.pilot_agent_claim.v1"):
            raise ValueError("Invalid pilot claim response")
        envelope = value.get("work")
        if envelope is None:
            return None
        if not isinstance(envelope, dict) or set(envelope) != {"job", "candidate", "authorization"}:
            raise ValueError("Invalid pilot claim envelope")
        job, candidate, authorization = (envelope["job"], envelope["candidate"],
                                         envelope["authorization"])
        if (not all(isinstance(item, dict) for item in (job, candidate, authorization)) or
                set(job) != PilotHttpBackendClient._JOB_FIELDS or
                set(candidate) != PilotHttpBackendClient._CANDIDATE_FIELDS or
                not isinstance(candidate.get("source"), dict) or
                set(candidate["source"]) != PilotHttpBackendClient._SOURCE_FIELDS or
                not isinstance(authorization, dict) or
                set(authorization) != PilotHttpBackendClient._AUTH_FIELDS):
            raise ValueError("Invalid pilot claim ticket shape")
        if ("approval_id" in job or type(job.get("job_id")) is not str or
                not job["job_id"] or type(job.get("order_id")) is not str or
                type(job.get("revision")) is not int or job["revision"] < 1 or
                type(job.get("request_hash")) is not str or
                type(job.get("printer_id")) is not str or
                type(job.get("lease_token")) is not str or not job["lease_token"] or
                type(job.get("lease_seconds")) is not int or job["lease_seconds"] < 1 or
                job.get("mode") not in {"simulation", "controlled_test", "production"}):
            raise ValueError("Invalid pilot Agent job")
        return deepcopy(job), deepcopy(candidate), deepcopy(authorization)

    @staticmethod
    def _claim_idempotency() -> str:
        return uuid.uuid4().hex

    @staticmethod
    def _job_suffix(job: dict[str, Any], action: str) -> str:
        return "/internal/v1/pilot/print-jobs/" + quote(job["job_id"], safe="") + "/" + action

    @staticmethod
    def _action_idempotency(job: dict[str, Any], action: str) -> str:
        raw = f"ai3:pilot:{action}:{job['job_id']}:{job['revision']}:{job['lease_token']}"
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()

    def _assert_claimed(self, work) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
        snapshot = self._claimed_snapshot
        if snapshot is None:
            raise RuntimeError("No active pilot Core lease")
        actual = (work.job, work.candidate, work.authorization)
        if actual != snapshot:
            raise RuntimeError("Pilot work does not match active Core lease")
        return snapshot

    def claim(self):
        # A new independent poll gets a fresh idempotency key; ambiguous claims
        # are never retried by this client.
        self._claimed_snapshot = None
        request = {"printer_id": self.printer_id,
                   "idempotency_key": self._claim_idempotency()}
        with self._request("POST", "/internal/v1/pilot/print-jobs/claim", body=request) as response:
            payload = self._read_json(response)
        ticket = self._validate_envelope(payload)
        if ticket is None:
            return None
        job, candidate, authorization = ticket
        source_path = self._job_suffix(job, "source")
        request = Request(self.base_url + source_path, method="GET", headers={
            "Authorization": "Bearer " + self.token,
            "X-AUTO-IN-Pilot-Lease": job["lease_token"],
            "Accept": "application/octet-stream",
            "Cache-Control": "no-store",
        })
        with urlopen(request, timeout=self.timeout) as response:
            if response.status != 200:
                raise RuntimeError("Unexpected pilot source response")
            headers = response.headers
            advertised_hash = headers.get("X-AUTO-IN-Source-SHA256") if headers else None
            advertised_size = headers.get("X-AUTO-IN-Source-Size") if headers else None
            cache_control = headers.get("Cache-Control", "") if headers else ""
            if (not isinstance(advertised_hash, str) or
                    not isinstance(advertised_size, str) or
                    "no-store" not in cache_control.casefold()):
                raise ValueError("Pilot source headers missing")
            try:
                size = int(advertised_size)
            except ValueError as exc:
                raise ValueError("Pilot source size header invalid") from exc
            if not 0 < size <= MAX_PUBLIC_SOURCE_BYTES:
                raise ValueError("Pilot source size invalid")
            source_bytes = response.read(MAX_PUBLIC_SOURCE_BYTES + 1)
            if len(source_bytes) > MAX_PUBLIC_SOURCE_BYTES or len(source_bytes) != size:
                raise ValueError("Pilot source body size mismatch")
            if advertised_hash != candidate["source"].get("sha256"):
                raise ValueError("Pilot source header hash mismatch")

        work = PilotPrintWork(job=job, candidate=candidate,
                              authorization=authorization, source_bytes=source_bytes)
        self._claimed_snapshot = (deepcopy(job), deepcopy(candidate), deepcopy(authorization))
        return work

    @staticmethod
    def _gate_request(work) -> dict[str, Any]:
        return {"expected_revision": work.job["revision"],
                "lease_token": work.job["lease_token"],
                "request_hash": work.job["request_hash"],
                "source_sha256": work.candidate["source"]["sha256"],
                "settings_sha256": work.candidate["settings_sha256"],
                "evidence_sha256": work.authorization["evidence_sha256"],
                "printer_id": work.job["printer_id"]}

    def _gate(self, work, action: str, expected_state: str) -> dict[str, Any]:
        job, _, _ = self._assert_claimed(work)
        with self._request("POST", self._job_suffix(job, action),
                           body=self._gate_request(work)) as response:
            value = self._read_json(response)
        if (set(value) != self._GATE_FIELDS or
                value.get("schema") != "ai0.pilot_agent_gate_receipt.v1" or
                value.get("state") != expected_state):
            raise ValueError("Invalid pilot gate receipt")
        return value

    def preflight(self, work) -> dict[str, Any]:
        return self._gate(work, "preflight", "AUTHORIZED")

    def mark_sending(self, work) -> dict[str, Any]:
        return self._gate(work, "mark-sending", "SENDING")

    def report(self, work, state: str, evidence: dict[str, Any]) -> None:
        job, _, _ = self._assert_claimed(work)
        if state not in {"SIMULATED_DONE", "SENT_UNVERIFIED", "UNKNOWN"}:
            raise ValueError("Agent cannot assert verified paper completion")
        request = {
            "schema": "ai0.pilot_agent_report.v1",
            "lease_token": job["lease_token"],
            "idempotency_key": self._action_idempotency(job, "report:" + state),
            "state": state,
            "evidence": _plain_evidence(evidence),
        }
        with self._request("POST", self._job_suffix(job, "reports"), body=request) as response:
            receipt = self._read_json(response)
        if receipt.get("job_id") != job["job_id"] or receipt.get("state") != state:
            raise RuntimeError("Pilot report receipt was not confirmed")
