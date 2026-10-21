"""One-job pilot HTTP DryRun; it never creates a native printer adapter.

Example (simulation Core on loopback):
    AUTO_IN_AGENT_TOKEN=... python -m agents.windows.pilot_cli \
      --api-base-url http://127.0.0.1:3000 --journal /secure/pilot.sqlite

Only loopback HTTP(S) or HTTPS Core URLs are accepted. DryRun requires Core to
return a job with ``mode=simulation``; the Agent reports SIMULATED_DONE with
``driver_called=false`` and does not inspect through Word or invoke any driver.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from urllib.parse import urlsplit

from .pilot_backend_http import PilotHttpBackendClient
from .pilot_native_print import PilotJournal, PilotPrintAgent


class _NativePrinterDisabled:
    """Fail closed if a future DryRun code path accidentally touches native I/O."""

    @staticmethod
    def prepare(*_args, **_kwargs):
        raise RuntimeError("PILOT_DRY_RUN_NATIVE_PRINTER_DISABLED")

    @staticmethod
    def send(*_args, **_kwargs):
        raise RuntimeError("PILOT_DRY_RUN_NATIVE_PRINTER_DISABLED")


def run_pilot_dryrun_once(*, api_base_url: str, token: str, journal_path: str | Path,
                          printer_id: str = "RMP7000", timeout: float = 10) -> dict:
    """Claim and process at most one simulation job through real Core HTTP routes."""
    journal = None
    try:
        backend = PilotHttpBackendClient(api_base_url, token, printer_id=printer_id,
                                         timeout=timeout)
        journal = PilotJournal(journal_path)
        agent = PilotPrintAgent(backend=backend, journal=journal,
                                printer=_NativePrinterDisabled(),
                                configured_printer_id=printer_id, dry_run=True)
        result = agent.run_once()
        public_result = {"status": result.get("status"), "driver_called": False}
        if isinstance(result.get("reason"), str):
            public_result["reason"] = result["reason"]
        if result.get("report_pending") is True:
            public_result["report_pending"] = True
        return {"mode": "simulation", "driver_called": False,
                "result": public_result}
    except Exception:
        # Do not expose exception messages, paths, transport bodies, credentials,
        # source documents or identifiers on stdout/stderr.
        return {"mode": "simulation", "driver_called": False,
                "result": {"status": "UNKNOWN", "reason": "PILOT_DRY_RUN_FAILED"}}
    finally:
        if journal is not None:
            journal.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="AUTO-IN pilot one-job DryRun only")
    parser.add_argument("--api-base-url", required=True)
    parser.add_argument("--journal", required=True,
                        help="Persistent local SQLite journal path")
    parser.add_argument("--http-timeout-seconds", type=int, default=10)
    args = parser.parse_args(argv)
    origin = urlsplit(args.api_base_url)
    if (origin.scheme not in ("https", "http") or not origin.hostname or
            origin.username or origin.password or origin.query or origin.fragment or
            origin.path not in ("", "/") or
            (origin.scheme == "http" and origin.hostname not in
             ("localhost", "127.0.0.1", "::1")) or
            not 1 <= args.http_timeout_seconds <= 30):
        parser.error("Use HTTPS Core or loopback simulation with a 1..30s timeout")
    result = run_pilot_dryrun_once(
        api_base_url=args.api_base_url,
        token=os.environ.get("AUTO_IN_AGENT_TOKEN", ""),
        journal_path=args.journal,
        timeout=args.http_timeout_seconds)
    print(json.dumps(result, separators=(",", ":"), sort_keys=True))
    return 0 if result["result"]["status"] in ("SIMULATED_DONE", "NO_JOB") else 2


if __name__ == "__main__":
    raise SystemExit(main())
