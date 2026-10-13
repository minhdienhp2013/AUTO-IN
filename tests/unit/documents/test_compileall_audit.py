"""Run the real Python compileall command for all AI3 modules and unit tests.

This regression is executed by the product PostgreSQL CI pytest job so that
syntax gate evidence always belongs to the tested integrated commit SHA.
No customer data and no real Windows/Ricoh printer.
"""
from pathlib import Path
import subprocess
import sys


def test_compileall_workers_agents_and_ai3_tests():
    repo = Path(__file__).resolve().parents[3]
    command = [
        sys.executable, "-m", "compileall", "-q",
        "workers/documents", "agents/windows",
        "tests/unit/documents", "tests/unit/printing",
    ]
    result = subprocess.run(
        command, cwd=repo, capture_output=True, text=True,
        check=False, timeout=30,
    )
    assert result.returncode == 0, (
        f"AI3 compileall failed with exit code {result.returncode}: "
        f"{result.stderr[-1000:]}"
    )



def test_source_snapshot_audit_suite_runs_directly():
    """Explicit HEAD audit: execute the requested source-snapshot file by itself."""
    repo = Path(__file__).resolve().parents[3]
    result = subprocess.run(
        [sys.executable, "-m", "pytest", "-q",
         "tests/unit/documents/test_source_snapshots.py"],
        cwd=repo, capture_output=True, text=True,
        check=False, timeout=60,
    )
    assert result.returncode == 0, (
        "Direct snapshot audit FAILED: " + result.stdout[-1500:]
        + result.stderr[-500:]
    )
    assert "5 passed" in result.stdout, result.stdout[-1500:]
