"""Dry-run CLI: python -m agents.windows.cli simulated-job.json --journal journal.sqlite"""
import argparse
import json
from pathlib import Path
from .agent import DryRunDriver, FakeBackend, Journal, PrintAgent


def main() -> int:
    parser = argparse.ArgumentParser(description='AUTO-IN DRY RUN ONLY - NO PHYSICAL PRINT')
    parser.add_argument('job_json')
    parser.add_argument('--journal', required=True)
    args = parser.parse_args()
    job = json.loads(Path(args.job_json).read_text(encoding='utf-8'))
    journal = Journal(args.journal)
    try:
        agent = PrintAgent(FakeBackend(job), journal, DryRunDriver())
        previous = agent.recover()
        result = agent.run_once()
        print(json.dumps({'mode': 'simulation', 'recovered_as_unknown': previous,
                          'result': result}, ensure_ascii=False, indent=2))
        return 0 if result['status'] in ('SIMULATED_DONE', 'NO_JOB') else 2
    finally:
        journal.close()


if __name__ == '__main__':
    raise SystemExit(main())
