"""CODE-303 subprocess DryRun CLI output never leaks secrets/traceback."""
import json
from pathlib import Path
import subprocess
import sys


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
