"""Opt-in HTTPS/PG product print-agent test against AI0 CODE-006 PR #21.

This is NOT a mock. AI0 must start its Fastify server on HTTPS localhost with an
isolated autoin_test PostgreSQL DB, a scoped print_agent identity and ONE freshly
confirmed/approved simulation job. No driver other than DryRunDriver is imported.

Run once per fixture/scenario; never point the test at production.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from urllib.parse import urlsplit

import pytest

from agents.windows.agent import (
    DryRunDriver, Journal, PrintAgent, SimulatedCrash,
)
from agents.windows.backend_http import HttpBackendClient


SCENARIOS = {
    "normal", "cli", "lost_mark_ack", "lost_report_ack",
    "before_mark_sending", "after_mark_sending",
    "after_journal_before_driver", "after_driver",
}


def _target():
    if os.environ.get("AUTOIN_CODE303_RUN_PRODUCT_DRYRUN") != "YES_SIMULATION_ONLY":
        pytest.skip("External AI0 Fastify/PostgreSQL HTTPS fixture not enabled")
    base = os.environ.get("AUTOIN_CODE303_HTTPS_URL", "")
    token = os.environ.get("AUTOIN_CODE303_AGENT_TOKEN", "")
    scenario = os.environ.get("AUTOIN_CODE303_SCENARIO", "normal")
    if not base or not token:
        pytest.fail("Product gate enabled but HTTPS URL or scoped agent token missing")
    try:
        parts = urlsplit(base)
        safe = (parts.scheme == "https"
                and parts.hostname in ("localhost", "127.0.0.1", "::1")
                and parts.port is not None
                and parts.path in ("", "/")
                and not (parts.username or parts.password or parts.query or parts.fragment))
    except ValueError:
        safe = False
    if not safe:
        pytest.fail("Only HTTPS localhost with explicit port and trusted TLS is allowed")
    if scenario not in SCENARIOS:
        pytest.fail("Unknown CODE-303 scenario")
    # The same trusted system SSL store/SSL_CERT_FILE handles all HTTPS requests.
    # Do not disable certificate verification, follow redirects or use HTTP.
    return base, token, scenario


class _DropMarkAck(HttpBackendClient):
    def mark_sending(self, job):
        super().mark_sending(job)  # Real AI1 marks SENDING atomically in PostgreSQL.
        raise ConnectionError("Synthetic ACK lost AFTER backend committed SENDING")


class _DropReportAck(HttpBackendClient):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.dropped = False

    def report(self, job, state, evidence):
        super().report(job, state, evidence)  # Real AI1 commits the result.
        if not self.dropped:
            self.dropped = True
            raise ConnectionError("Synthetic report ACK lost AFTER backend committed")


def test_product_https_claim_preflight_mark_journal_dryrun_report(tmp_path):
    base, token, scenario = _target()
    journal_path = tmp_path / "durable-product.sqlite"

    if scenario == "cli":
        # Actually execute the Windows-agent CLI subprocess (simulation only).
        env = {**os.environ, "AUTO_IN_AGENT_TOKEN": token}
        command = [
            sys.executable, "-m", "agents.windows.cli",
            "--api-base-url", base, "--journal", str(journal_path),
            "--http-timeout-seconds", "10",
        ]
        first = subprocess.run(command, env=env, capture_output=True,
                               timeout=35, check=False)
        assert first.returncode == 0, (first.returncode, first.stderr)
        assert first.stderr == b""
        output = json.loads(first.stdout)
        assert output["mode"] == "simulation"
        assert output["result"]["status"] == "SIMULATED_DONE", output
        assert output["result"]["evidence"]["paper_verified"] is False
        assert token.encode() not in first.stdout
        restarted = subprocess.run(command, env=env, capture_output=True,
                                   timeout=35, check=False)
        assert restarted.returncode == 0, (restarted.returncode, restarted.stderr)
        after = json.loads(restarted.stdout)
        assert after["result"]["status"] in ("NO_JOB", "SIMULATED_DONE"), after
        assert token.encode() not in restarted.stdout
        return

    transport = (_DropMarkAck if scenario == "lost_mark_ack" else
                 _DropReportAck if scenario == "lost_report_ack" else
                 HttpBackendClient)
    backend = transport(base, token, timeout=5)
    driver = DryRunDriver()
    agent = PrintAgent(backend, Journal(journal_path), driver)
    try:
        agent.recover()
        if scenario in ("normal", "lost_mark_ack", "lost_report_ack"):
            outcome = agent.run_once()
        else:
            with pytest.raises(SimulatedCrash):
                agent.run_once(fault_at=scenario)
            outcome = {"status": "CRASH_INJECTED"}

        if scenario == "normal":
            assert outcome["status"] == "SIMULATED_DONE", outcome
            assert outcome["evidence"]["paper_verified"] is False
            assert driver.calls == 1
        elif scenario == "lost_mark_ack":
            assert outcome["status"] == "UNKNOWN", outcome
            assert driver.calls == 0
            assert agent.journal.reportable()[0]["state"] == "UNKNOWN"
        elif scenario == "lost_report_ack":
            assert outcome["status"] == "SIMULATED_DONE", outcome
            assert outcome.get("report_pending") is True
            assert driver.calls == 1
        else:
            assert outcome["status"] == "CRASH_INJECTED"
            assert driver.calls == (1 if scenario == "after_driver" else 0)
    finally:
        agent.journal.close()

    restarted = PrintAgent(backend, Journal(journal_path), driver)
    try:
        unresolved = restarted.recover()
        if scenario in ("before_mark_sending", "after_mark_sending",
                        "after_journal_before_driver", "after_driver"):
            assert unresolved and restarted.journal.get(unresolved[0])["state"] == "UNKNOWN"
        if scenario == "lost_mark_ack":
            assert restarted.journal.reportable()[0]["state"] == "UNKNOWN"
        # This call may get NO_JOB after AI1 commit or duplicate claim while lease
        # still alive. Both outcomes must not call the driver a second time.
        again = restarted.run_once()
        assert again["status"] in ("NO_JOB", "UNKNOWN", "SIMULATED_DONE"), again
        assert driver.calls == (0 if scenario in (
            "lost_mark_ack", "before_mark_sending",
            "after_mark_sending", "after_journal_before_driver") else 1)
    finally:
        restarted.journal.close()
