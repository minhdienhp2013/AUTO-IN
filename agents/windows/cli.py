"""SAFE mode CLI: all paths use DryRunDriver, never a physical printer.

Synthetic: python -m agents.windows.cli fixture.json --journal /secure/journal.sqlite
Internal API simulation: AUTO_IN_AGENT_TOKEN=... python -m agents.windows.cli \
  --api-base-url https://private-backend.example --journal /secure/journal.sqlite
"""
import argparse
import json
import os
from pathlib import Path

from .agent import DryRunDriver, FakeBackend, Journal, PrintAgent
from .backend_http import HttpBackendClient


def main() -> int:
    parser = argparse.ArgumentParser(description='AUTO-IN DRY RUN ONLY - NO PHYSICAL PRINT')
    parser.add_argument('job_json', nargs='?', help='Synthetic JSON fixture; never a real job')
    parser.add_argument('--api-base-url', help='HTTPS internal API for simulation only')
    parser.add_argument('--journal', required=True, help='Persistent local SQLite path, not a temp file')
    args = parser.parse_args()
    if (args.job_json is None) == (args.api_base_url is None):
        parser.error('Choose exactly one synthetic fixture or --api-base-url')
    if args.api_base_url:
        # Do not accept the scoped credential on the command line (shell history).
        token = os.environ.get('AUTO_IN_AGENT_TOKEN', '')
        backend = HttpBackendClient(args.api_base_url, token)
    else:
        job = json.loads(Path(args.job_json).read_text(encoding='utf-8'))
        backend = FakeBackend(job)
    journal = Journal(args.journal)
    try:
        agent = PrintAgent(backend, journal, DryRunDriver())
        previous = agent.recover()
        result = agent.run_once()
        print(json.dumps({'mode': 'simulation', 'recovered_as_unknown': previous,
                          'result': result}, ensure_ascii=False, indent=2))
        return 0 if result['status'] in ('SIMULATED_DONE', 'NO_JOB') else 2
    finally:
        journal.close()


if __name__ == '__main__':
    raise SystemExit(main())
