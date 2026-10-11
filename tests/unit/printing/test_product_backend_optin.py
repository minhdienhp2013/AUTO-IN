"""Optional CODE-303 PRODUCT backend HTTPS simulation adapter.

Unlike fake HTTP / _SimulatedApi, this does not create the server. Run only
against the AI0 CODE-006 integrated Fastify/PostgreSQL backend, pre-seeded with
a real APPROVED simulation print job (never physical print).
"""
from __future__ import annotations

import os
from urllib.parse import urlsplit

import pytest

from agents.windows.agent import DryRunDriver, Journal, PrintAgent
from agents.windows.backend_http import HttpBackendClient


def test_ai0_product_backend_claim_preflight_mark_journal_dryrun_report(tmp_path):
    base = os.environ.get("AUTOIN_CODE303_HTTPS_URL", "")
    token = os.environ.get("AUTOIN_CODE303_AGENT_TOKEN", "")
    flag = os.environ.get("AUTOIN_CODE303_RUN_PRODUCT_DRYRUN", "")
    if flag != "YES_SIMULATION_ONLY" or not base or not token:
        pytest.skip("AI0 CODE-006 product HTTPS simulation endpoint/credential not supplied")
    parts = urlsplit(base)
    if parts.scheme != "https" or parts.hostname not in ("localhost", "127.0.0.1", "::1"):
        pytest.fail("Product integration must use HTTPS localhost only, no TLS bypass")
    assert not (parts.username or parts.password or parts.query or parts.fragment)
    # Python/system TLS verifies the server cert. For a local test CA, supply
    # SSL_CERT_FILE to the test process; NEVER set verify=False.
    backend = HttpBackendClient(base, token, timeout=5)
    driver = DryRunDriver()
    db = tmp_path / "product-journal.sqlite"
    agent = PrintAgent(backend, Journal(db), driver)
    try:
        agent.recover()
        result = agent.run_once()
        if result["status"] == "NO_JOB":
            pytest.skip("No pre-approved simulation fixture in integrated PostgreSQL")
        assert result["status"] == "SIMULATED_DONE", result
        assert result["evidence"]["evidence_kind"] == "simulated"
        assert result["evidence"]["paper_verified"] is False
        assert driver.calls == 1
    finally:
        agent.journal.close()
    # Restart with exactly the same durable journal: report only, no resend.
    restarted = PrintAgent(backend, Journal(db), driver)
    try:
        restarted.recover()
        again = restarted.run_once()
        assert again["status"] in ("NO_JOB", "SIMULATED_DONE"), again
        assert driver.calls == 1
    finally:
        restarted.journal.close()
