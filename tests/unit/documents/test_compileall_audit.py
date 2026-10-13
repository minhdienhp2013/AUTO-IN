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
