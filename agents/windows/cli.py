"""SAFE mode CLI: all paths use DryRunDriver, never a physical printer.

Synthetic: python -m agents.windows.cli fixture.json --journal /secure/journal.sqlite
Internal API simulation: AUTO_IN_AGENT_TOKEN=... python -m agents.windows.cli \
  --api-base-url https://private-backend.example --journal /secure/journal.sqlite
"""
import argparse
import json
import os
from pathlib import Path
from urllib.parse import urlsplit

from .agent import DryRunDriver, FakeBackend, Journal, PrintAgent
from .backend_http import HttpBackendClient


def main() -> int:
    parser = argparse.ArgumentParser(description='AUTO-IN DRY RUN ONLY - NO PHYSICAL PRINT')
    parser.add_argument('job_json', nargs='?', help='Synthetic JSON fixture; never a real job')
    parser.add_argument('--api-base-url', help='HTTPS internal API for simulation only')
    parser.add_argument('--journal', required=True, help='Persistent local SQLite path, not a temp file')
    parser.add_argument('--http-timeout-seconds', type=int, default=10,
                        help='HTTPS request deadline (1..30 seconds)')
    args = parser.parse_args()
    if (args.job_json is None) == (args.api_base_url is None):
        parser.error('Choose exactly one synthetic fixture or --api-base-url')
    if not 1 <= args.http_timeout_seconds <= 30:
        parser.error('--http-timeout-seconds must be in 1..30')
    previous = []
    journal = None
    result = {'status': 'UNKNOWN', 'reason_code': 'AGENT_UNVERIFIED_FAILURE'}
    try:
        if args.api_base_url:
            # CODE-303 is localhost-only simulation; prevent an accidentally
            # copied production address from receiving a scoped agent token.
            origin = urlsplit(args.api_base_url)
            if (origin.scheme != 'https' or
                    origin.hostname not in ('localhost', '127.0.0.1', '::1') or
                    origin.username or origin.password or origin.query or
                    origin.fragment or origin.path not in ('', '/') or
                    not origin.port):
                raise ValueError('Simulation agent API requires HTTPS localhost with explicit port')
            # Never accept the scoped credential in argv or weaken HTTPS/TLS.
            backend = HttpBackendClient(args.api_base_url,
                                        os.environ.get('AUTO_IN_AGENT_TOKEN', ''),
                                        timeout=args.http_timeout_seconds)
        else:
            job = json.loads(Path(args.job_json).read_text(encoding='utf-8'))
            backend = FakeBackend(job)
        journal = Journal(args.journal)
        agent = PrintAgent(backend, journal, DryRunDriver())
        previous = agent.recover()
        result = agent.run_once()
    except Exception:
        # NEVER put a traceback, file path, lease, bearer token or document into
        # stderr/stdout. If a boundary may have been journaled, uncertainty is
        # retained for the next startup's report-only reconciliation.
        result = {'status': 'UNKNOWN', 'reason_code': 'AGENT_UNVERIFIED_FAILURE',
                  'requires_reconciliation': True}
    finally:
        if journal is not None:
            journal.close()
    print(json.dumps({'mode': 'simulation', 'recovered_as_unknown': previous,
                      'result': result}, ensure_ascii=False, separators=(',', ':')))
    return 0 if result.get('status') in ('SIMULATED_DONE', 'NO_JOB') else 2


if __name__ == '__main__':
    raise SystemExit(main())
