"""Verify AI1 contract-shaped requests without real network or print effects."""
import io
import json
from urllib.error import HTTPError, URLError
import pytest
from agents.windows import backend_http


class Response:
    status = 200

    def __init__(self, data):
        self.buffer = io.BytesIO(json.dumps(data).encode('utf-8'))

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def read(self, n):
        return self.buffer.read(n)


def job():
    return {'job_id': 'job/1', 'order_id': 'order-1', 'revision': 2,
            'request_hash': 'a' * 64, 'approval_id': 'approval1',
            'printer_id': 'RMP7000', 'lease_token': 'SECRET-LEASE',
            'lease_seconds': 90, 'mode': 'simulation'}


def preflight_ticket(record, *, composition_evidence=True):
    evidence_sha = 'e' * 64
    value = {
        'allowed': True, 'job_id': record['job_id'],
        'revision': record['revision'], 'mode': record['mode'],
        'approval_id': record['approval_id'],
        'review_receipt': {
            'receipt_id': 'receipt-1', 'shop_id': 'shop-1',
            'order_id': record['order_id'], 'revision': record['revision'],
            'request_hash': record['request_hash'], 'evidence_sha256': evidence_sha,
            'reviewer_id': 'staff-1', 'reviewed_at': '2026-10-18T10:00:00Z',
            'decision': 'checked',
        },
        'trusted_evidence': {
            'schema': 'ai0.print_evidence.v1', 'shop_id': 'shop-1',
            'order_id': record['order_id'], 'revision': record['revision'],
            'request_hash': record['request_hash'], 'evidence_sha256': evidence_sha,
            'settings_sha256': '1' * 64, 'renderer_sha256': '2' * 64,
            'printer_capability_sha256': '3' * 64,
            'preview_sha256': ['4' * 64], 'printer_id': record['printer_id'],
        },
        'trusted_job': {
            'job_id': record['job_id'], 'shop_id': 'shop-1',
            'order_id': record['order_id'], 'revision': record['revision'],
            'request_hash': record['request_hash'],
            'approval_id': record['approval_id'], 'printer_id': record['printer_id'],
            'evidence_sha256': evidence_sha, 'mode': record['mode'],
            'state': 'NOT_SENT',
        },
    }
    if composition_evidence:
        value['document_evidence_verified'] = True
    return value


def test_wire_exact_body_and_routes(monkeypatch):
    captured = []

    def fake_urlopen(request, timeout):
        body = json.loads(request.data)
        captured.append((request.full_url, body, request.get_header('Authorization')))
        if request.full_url.endswith('/claim'):
            return Response({'job': job()})
        if request.full_url.endswith('/preflight'):
            return Response(preflight_ticket(job()))
        if request.full_url.endswith('/mark-sending'):
            return Response({'job_id': job()['job_id'], 'state': 'SENDING',
                             'mode': 'simulation'})
        return Response({'job_id': job()['job_id'], 'state': 'SIMULATED_DONE'})

    monkeypatch.setattr(backend_http, 'urlopen', fake_urlopen)
    c = backend_http.HttpBackendClient('https://backend.example', 'T' * 24)
    record = c.claim()
    assert record['lease_token'] == job()['lease_token']
    assert c.preflight(record)['allowed'] is True
    assert c.mark_sending(record)['state'] == 'SENDING'
    c.report(record, 'SIMULATED_DONE', {'evidence_kind': 'simulated'})
    assert captured[0][1]['printer_id'] == 'RMP7000'
    assert captured[0][1]['idempotency_key']
    assert captured[1][1] == {'expected_revision': 2, 'lease_token': 'SECRET-LEASE'}
    assert captured[2][1]['expected_revision'] == 2
    assert captured[2][1]['lease_token'] == 'SECRET-LEASE'
    assert len(captured[2][1]['idempotency_key']) == 64
    assert captured[3][1]['result'] == 'simulated_done'
    assert captured[3][1]['evidence_kind'] == 'simulated'
    assert all(header == 'Bearer ' + 'T' * 24 for _, _, header in captured)
    assert captured[2][0].endswith('/print-jobs/job%2F1/mark-sending')
    assert captured[3][0].endswith('/print-jobs/job%2F1/reports')


def test_unknown_maps_to_agent_uncertain(monkeypatch):
    seen = {}

    def fake_urlopen(request, timeout):
        seen.update(json.loads(request.data))
        return Response({'job_id': 'job/1', 'state': 'UNKNOWN'})

    monkeypatch.setattr(backend_http, 'urlopen', fake_urlopen)
    c = backend_http.HttpBackendClient('https://backend.example', 'T' * 24)
    c.report(job(), 'UNKNOWN', {'reason': 'crash'})
    assert seen['result'] == 'unknown'
    assert seen['evidence_kind'] == 'agent_uncertain'


def test_never_allow_verified_done_from_agent():
    c = backend_http.HttpBackendClient('https://backend.example', 'T' * 24)
    with pytest.raises(ValueError):
        c.report(job(), 'VERIFIED_DONE', {'evidence_kind': 'spooler'})


@pytest.mark.parametrize('url', [
    'http://127.0.0.1', 'https://user:pass@backend.example',
    'https://backend.example/?token=secret', 'https://backend.example/#data',
])
def test_reject_insecure_agent_urls(url):
    with pytest.raises(ValueError):
        backend_http.HttpBackendClient(url, 'T' * 24)


def test_bad_claim_shape_blocks(monkeypatch):
    monkeypatch.setattr(backend_http, 'urlopen', lambda *_a, **_k: Response({'job': 'invalid'}))
    client = backend_http.HttpBackendClient('https://backend.example', 'T' * 24)
    with pytest.raises(ValueError):
        client.claim()


class ClaimErrorJournal:
    """Any claim failure must stop before a journal boundary is recorded."""
    def __init__(self):
        self.calls = 0

    def _unexpected_call(self, message):
        self.calls += 1
        raise AssertionError(message)

    def get(self, *_args, **_kwargs):
        self._unexpected_call('claim failure must not inspect the journal')

    def begin(self, *_args, **_kwargs):
        self._unexpected_call('claim failure must not create a journal boundary')

    def state(self, *_args, **_kwargs):
        self._unexpected_call('claim failure must not change journal state')


def _claim_http_error(status, body):
    return HTTPError('https://backend.example/internal/v1/print-jobs/claim', status,
                     'claim rejected', {}, io.BytesIO(body))


def _run_agent_with_claim_error(monkeypatch, error):
    from agents.windows.agent import DryRunDriver, PrintAgent

    def fail_request(*_args, **_kwargs):
        raise error

    monkeypatch.setattr(backend_http, 'urlopen', fail_request)
    backend = backend_http.HttpBackendClient('https://backend.example', 'T' * 24)
    driver = DryRunDriver()
    journal = ClaimErrorJournal()
    agent = PrintAgent(backend, journal, driver)
    result = agent.run_once()
    assert journal.calls == 0
    return result, driver


def test_claim_stale_print_evidence_maps_to_blocked_without_driver(monkeypatch):
    body = json.dumps({'error': {'code': 'STALE_PRINT_EVIDENCE'}}).encode()
    result, driver = _run_agent_with_claim_error(monkeypatch, _claim_http_error(409, body))

    assert result == {'status': 'BLOCKED', 'reason': 'DOCUMENT_EVIDENCE_UNVERIFIED'}
    assert driver.calls == 0


@pytest.mark.parametrize('status,body', [
    (409, {'error': {'code': 'OTHER_CONFLICT'}}),
    (409, {'error': {'code': 'DOCUMENT_EVIDENCE_UNVERIFIED'}}),
    (409, {'error': {'code': 'UNKNOWN_ERROR'}}),
    (503, {'error': {'code': 'STALE_PRINT_EVIDENCE'}}),
    (500, {'error': {'code': 'STALE_PRINT_EVIDENCE'}}),
])
def test_other_claim_http_errors_remain_unknown_without_driver(monkeypatch, status, body):
    result, driver = _run_agent_with_claim_error(
        monkeypatch, _claim_http_error(status, json.dumps(body).encode()))

    assert result == {'status': 'UNKNOWN', 'reason': 'CLAIM_AMBIGUOUS'}
    assert driver.calls == 0


def test_ambiguous_duplicate_claim_error_code_remains_unknown(monkeypatch):
    body = b'{"error":{"code":"OTHER_CONFLICT","code":"STALE_PRINT_EVIDENCE"}}'
    result, driver = _run_agent_with_claim_error(monkeypatch, _claim_http_error(409, body))

    assert result == {'status': 'UNKNOWN', 'reason': 'CLAIM_AMBIGUOUS'}
    assert driver.calls == 0


def test_claim_ordinary_json_error_remains_unknown_without_driver(monkeypatch):
    body = json.dumps({'error': {'code': 'CLAIM_CONFLICT',
                                 'message': 'Claim is not available'}}).encode()
    result, driver = _run_agent_with_claim_error(monkeypatch, _claim_http_error(409, body))

    assert result == {'status': 'UNKNOWN', 'reason': 'CLAIM_AMBIGUOUS'}
    assert driver.calls == 0


def test_claim_error_body_over_limit_remains_unknown_without_driver(monkeypatch):
    body = (b'{"error":{"code":"STALE_PRINT_EVIDENCE"},"padding":"' +
            b'x' * 4096 + b'"}')
    assert len(body) > 4096
    assert json.loads(body)['error']['code'] == 'STALE_PRINT_EVIDENCE'

    result, driver = _run_agent_with_claim_error(monkeypatch, _claim_http_error(409, body))

    assert result == {'status': 'UNKNOWN', 'reason': 'CLAIM_AMBIGUOUS'}
    assert driver.calls == 0


@pytest.mark.parametrize('error', [
    URLError('network unavailable'),
    TimeoutError('claim timed out'),
])
def test_claim_network_and_timeout_remain_unknown_without_driver(monkeypatch, error):
    result, driver = _run_agent_with_claim_error(monkeypatch, error)

    assert result == {'status': 'UNKNOWN', 'reason': 'CLAIM_AMBIGUOUS'}
    assert driver.calls == 0


def test_bad_report_ack_is_not_marked_confirmed(monkeypatch):
    monkeypatch.setattr(backend_http, 'urlopen', lambda *_a, **_k: Response({'job_id': 'wrong', 'state': 'SIMULATED_DONE'}))
    client = backend_http.HttpBackendClient('https://backend.example', 'T' * 24)
    with pytest.raises(RuntimeError):
        client.report(job(), 'SIMULATED_DONE', {'evidence_kind': 'simulated'})


def test_end_to_end_agent_with_ai1_wire_mock(monkeypatch, tmp_path):
    from agents.windows.agent import DryRunDriver, Journal, PrintAgent
    server = {'state': 'NOT_SENT', 'calls': []}

    def route(request, timeout):
        body = json.loads(request.data)
        url = request.full_url
        server['calls'].append(url.split('/')[-1])
        if url.endswith('/claim'):
            assert body['printer_id'] == 'RMP7000' and body['idempotency_key']
            return Response({'job': job()})
        if url.endswith('/preflight'):
            assert body == {'expected_revision': 2, 'lease_token': 'SECRET-LEASE'}
            return Response(preflight_ticket(job()))
        if url.endswith('/mark-sending'):
            assert server['state'] == 'NOT_SENT'
            assert body['expected_revision'] == 2 and body['lease_token'] == 'SECRET-LEASE'
            server['state'] = 'SENDING'
            return Response({'job_id': 'job/1', 'state': 'SENDING', 'mode': 'simulation'})
        assert url.endswith('/reports')
        assert server['state'] == 'SENDING'
        assert body['evidence_kind'] == 'simulated' and body['result'] == 'simulated_done'
        server['state'] = 'SIMULATED_DONE'
        return Response({'job_id': 'job/1', 'state': 'SIMULATED_DONE'})

    monkeypatch.setattr(backend_http, 'urlopen', route)
    backend = backend_http.HttpBackendClient('https://backend.example', 'T' * 24)
    dry = DryRunDriver()
    agent = PrintAgent(backend, Journal(tmp_path / 'wire.sqlite'), dry,
                       evidence_gate=backend.evidence_verified)
    assert agent.run_once()['status'] == 'SIMULATED_DONE'
    assert server['state'] == 'SIMULATED_DONE'
    assert dry.calls == 1
    assert server['calls'] == ['claim', 'preflight', 'mark-sending', 'reports']



def test_agent_redirect_rejected_without_credential_forward():
    from urllib.error import HTTPError
    from urllib.request import Request
    request = Request('https://backend.example/internal/v1/print-jobs/claim',
                      headers={'Authorization': 'Bearer secret'}, method='POST')
    with pytest.raises(HTTPError):
        backend_http._RejectRedirects().redirect_request(
            request, None, 302, 'Moved', {}, 'https://attacker.example/capture')
