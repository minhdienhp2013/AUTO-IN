"""Verify AI1 contract-shaped requests without real network or print effects."""
import io
import json
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


def test_wire_exact_body_and_routes(monkeypatch):
    captured = []

    def fake_urlopen(request, timeout):
        body = json.loads(request.data)
        captured.append((request.full_url, body, request.get_header('Authorization')))
        if request.full_url.endswith('/claim'):
            return Response({'job': job()})
        if request.full_url.endswith('/preflight'):
            return Response({'allowed': True, 'job_id': job()['job_id'],
                             'revision': 2, 'mode': 'simulation', 'approval_id': 'approval1',
                             'document_evidence_verified': True})
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
            return Response({'allowed': True, 'job_id': 'job/1', 'revision': 2,
                             'mode': 'simulation', 'approval_id': 'approval1',
                             'document_evidence_verified': True})
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
    agent = PrintAgent(backend, Journal(tmp_path / 'wire.sqlite'), dry)
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
