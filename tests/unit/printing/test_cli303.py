"""CODE-303 subprocess DryRun CLI output never leaks secrets/traceback."""
import json
from pathlib import Path
import subprocess
import sys

import pytest


ROOT = Path(__file__).resolve().parents[3]


def _run(*args, env=None):
    return subprocess.run([sys.executable, "-m", "agents.windows.cli", *args],
                          cwd=ROOT, capture_output=True, timeout=15, env=env)


def test_dryrun_cli_emits_one_json_line_and_does_not_leak_lease(tmp_path):
    fixture = {
        "job_id": "job-303", "order_id": "order-303", "revision": 1,
        "request_hash": "a"*64, "approval_id": "approved-by-staff",
        "lease_token": "synthetic-super-secret-lease",
        "lease_seconds": 60, "mode": "simulation", "printer_id": "RMP7000",
    }
    path = tmp_path / "job.json"
    path.write_text(json.dumps(fixture), encoding="utf-8")
    completed = _run(str(path), "--journal", str(tmp_path / "journal.sqlite"))
    assert completed.returncode == 0, completed.stderr
    assert completed.stderr == b""
    assert completed.stdout.count(b"\n") == 1
    data = json.loads(completed.stdout)
    assert data["result"]["status"] == "SIMULATED_DONE"
    assert data["result"]["evidence"]["paper_verified"] is False
    assert b"synthetic-super-secret-lease" not in completed.stdout


def test_dryrun_cli_invalid_url_or_token_fail_closed_json_no_traceback(tmp_path):
    import os
    env = {**os.environ}
    env["AUTO_IN_AGENT_TOKEN"] = "A"*24
    for url in ("http://localhost:4444", "https://user:pass@localhost:4444",
                "https://backend.example:4444", "https://localhost:4444/path"):
        db = tmp_path / ("journal-" + str(len(url)) + ".sqlite")
        completed = _run("--api-base-url", url, "--journal", str(db), env=env)
        assert completed.returncode == 2
        assert completed.stderr == b""
        body = json.loads(completed.stdout)
        assert body["result"]["status"] == "UNKNOWN"
        assert body["result"]["requires_reconciliation"] is True
        assert not db.exists()
        assert b"A"*24 not in completed.stdout


def test_remote_https_simulation_requires_explicit_opt_in_and_exact_origin():
    from agents.windows.cli import _validate_api_base_url

    allowlist = "https://backend.example:8443"
    with pytest.raises(ValueError, match="allow-remote-simulation"):
        _validate_api_base_url(
            "https://backend.example:8443",
            allow_remote_simulation=False, allowed_origins=allowlist)

    _validate_api_base_url(
        "https://backend.example:8443",
        allow_remote_simulation=True, allowed_origins=allowlist)


@pytest.mark.parametrize("url,allowlist", [
    ("https://other.example:8443", "https://backend.example:8443"),
    ("https://backend.example:8443/api", "https://backend.example:8443"),
    ("https://user:pass@backend.example:8443", "https://backend.example:8443"),
    ("https://backend.example:9443", "https://backend.example:8443"),
])
def test_remote_https_origin_path_userinfo_or_port_mismatch_rejected(url, allowlist):
    from agents.windows.cli import _validate_api_base_url

    with pytest.raises(ValueError):
        _validate_api_base_url(
            url, allow_remote_simulation=True, allowed_origins=allowlist)


def test_allowlisted_remote_cli_still_uses_only_dryrun_driver(tmp_path, monkeypatch, capsys):
    from agents.windows import cli
    from agents.windows.agent import DryRunDriver, FakeBackend

    fixture = {
        "job_id": "job-remote-sim", "order_id": "order-remote-sim", "revision": 1,
        "request_hash": "a" * 64, "approval_id": "synthetic-approval",
        "lease_token": "synthetic-lease", "lease_seconds": 60,
        "mode": "simulation", "printer_id": "RMP7000",
    }
    backend = FakeBackend(fixture)
    backend.evidence_verified = lambda _job: True

    class ObservedDryRunDriver(DryRunDriver):
        pass

    driver = ObservedDryRunDriver()
    monkeypatch.setattr(cli, "HttpBackendClient", lambda *_args, **_kwargs: backend)
    monkeypatch.setattr(cli, "DryRunDriver", lambda: driver)
    monkeypatch.setenv("AUTO_IN_AGENT_TOKEN", "synthetic-token-1234567890")
    monkeypatch.setenv("AUTO_IN_AGENT_ALLOWED_ORIGINS", "https://backend.example")
    monkeypatch.setattr(sys, "argv", [
        "auto-in", "--api-base-url", "https://backend.example",
        "--allow-remote-simulation", "--journal", str(tmp_path / "remote.sqlite"),
    ])

    assert cli.main() == 0
    output = json.loads(capsys.readouterr().out)
    assert output["mode"] == "simulation"
    assert output["result"]["status"] == "SIMULATED_DONE"
    assert output["result"]["evidence"]["paper_verified"] is False
    assert driver.calls == 1


def test_dryrun_cli_restart_never_replays_driver(tmp_path):
    fixture = {
        "job_id": "job-303", "order_id": "order-303", "revision": 1,
        "request_hash": "a"*64, "approval_id": "a1",
        "lease_token": "synthetic-lease", "lease_seconds": 10,
        "mode": "simulation", "printer_id": "RMP7000",
    }
    path = tmp_path / "job.json"
    path.write_text(json.dumps(fixture), encoding="utf-8")
    journal = str(tmp_path / "durable.sqlite")
    first = _run(str(path), "--journal", journal)
    second = _run(str(path), "--journal", journal)
    assert first.returncode == 0 and second.returncode == 0
    assert json.loads(first.stdout)["result"]["status"] == "SIMULATED_DONE"
    assert json.loads(second.stdout)["result"]["status"] == "SIMULATED_DONE"
    # The real durability/no-repeat assertion is additionally tested in
    # test_agent.py and test_localhost_tls.py with a shared DryRunDriver counter.
