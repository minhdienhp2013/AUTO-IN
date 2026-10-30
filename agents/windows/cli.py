"""SAFE mode CLI: all paths use DryRunDriver, never a physical printer.

Synthetic: python -m agents.windows.cli fixture.json --journal /secure/journal.sqlite
Internal API simulation (localhost by default): AUTO_IN_AGENT_TOKEN=... python -m agents.windows.cli \
  --api-base-url https://127.0.0.1:3443 --journal /secure/journal.sqlite
Remote HTTPS simulation requires --allow-remote-simulation and an exact origin in
AUTO_IN_AGENT_ALLOWED_ORIGINS (comma-separated if multiple origins are needed).
"""
import argparse
import json
import os
from pathlib import Path
from urllib.parse import urlsplit

from .agent import DryRunDriver, FakeBackend, Journal, PrintAgent
from .backend_http import HttpBackendClient


_LOCALHOST_NAMES = ('localhost', '127.0.0.1', '::1')
_ALLOWED_ORIGINS_ENV = 'AUTO_IN_AGENT_ALLOWED_ORIGINS'


def _https_origin_key(value: str) -> tuple[str, int]:
    """Parse one HTTPS origin, rejecting paths and URL features that broaden it."""
    if (not isinstance(value, str) or not value or value != value.strip() or
            any(ord(character) < 32 or character.isspace() for character in value) or
            '\\' in value):
        raise ValueError('Invalid HTTPS origin')
    parsed = urlsplit(value)
    if (parsed.scheme != 'https' or not parsed.hostname or
            parsed.username is not None or parsed.password is not None or
            '@' in parsed.netloc or parsed.query or parsed.fragment or
            parsed.path not in ('', '/') or '?' in value or '#' in value):
        raise ValueError('Expected an HTTPS origin without credentials, path, query, or fragment')
    try:
        port = parsed.port
    except ValueError as error:
        raise ValueError('Invalid HTTPS origin port') from error
    if port == 0:
        raise ValueError('HTTPS origin port must be between 1 and 65535')
    # An omitted port is HTTPS's standard 443. Comparing effective ports makes
    # :443 equivalent to the canonical no-port form while rejecting other ports.
    return parsed.hostname.lower(), 443 if port is None else port


def _validate_api_base_url(base_url: str, *, allow_remote_simulation: bool,
                           allowed_origins: str) -> None:
    """Keep the CLI local-only unless the operator opts into an exact HTTPS origin."""
    key = _https_origin_key(base_url)
    hostname, _port = key
    if hostname in _LOCALHOST_NAMES:
        # Preserve CODE-303's explicit-port localhost rule.
        if not urlsplit(base_url).port:
            raise ValueError('Local simulation agent API requires an explicit HTTPS port')
        return
    if not allow_remote_simulation:
        raise ValueError('Remote simulation requires --allow-remote-simulation')
    if not allowed_origins:
        raise ValueError(f'Remote simulation requires {_ALLOWED_ORIGINS_ENV}')
    try:
        origins = {_https_origin_key(item) for item in allowed_origins.split(',')}
    except ValueError as error:
        raise ValueError(f'Invalid {_ALLOWED_ORIGINS_ENV} entry') from error
    if key not in origins:
        raise ValueError('Remote simulation origin is not exactly allowlisted')


def main() -> int:
    parser = argparse.ArgumentParser(description='AUTO-IN DRY RUN ONLY - NO PHYSICAL PRINT')
    parser.add_argument('job_json', nargs='?', help='Synthetic JSON fixture; never a real job')
    parser.add_argument('--api-base-url', help='HTTPS internal API for simulation only')
    parser.add_argument('--allow-remote-simulation', action='store_true',
                        help='Allow a remote HTTPS API only when its exact origin is in ' +
                             _ALLOWED_ORIGINS_ENV)
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
            # Localhost remains the default. Remote credentials are sent only
            # after both the explicit simulation opt-in and exact origin match.
            _validate_api_base_url(
                args.api_base_url,
                allow_remote_simulation=args.allow_remote_simulation,
                allowed_origins=os.environ.get(_ALLOWED_ORIGINS_ENV, ''),
            )
            # Never accept the scoped credential in argv or weaken HTTPS/TLS.
            backend = HttpBackendClient(args.api_base_url,
                                        os.environ.get('AUTO_IN_AGENT_TOKEN', ''),
                                        timeout=args.http_timeout_seconds)
        else:
            job = json.loads(Path(args.job_json).read_text(encoding='utf-8'))
            backend = FakeBackend(job)
        journal = Journal(args.journal)
        agent = PrintAgent(
            backend, journal, DryRunDriver(),
            # A validated preflight response is cached only by the authenticated
            # HTTPS client, never by the job's caller-controlled JSON. FakeBackend
            # and local fixture paths intentionally have no evidence callback.
            evidence_gate=backend.evidence_verified if args.api_base_url else None,
        )
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
