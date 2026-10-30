# AUTO-IN VPS simulation host (2026-10-30)

This is a deployment profile for the existing **simulation-only** backend. It is a preparation and smoke-test guide, not an instruction to deploy or to connect a real OA/printer. The application rejects production mode and only accepts a numeric loopback PostgreSQL URL for an `autoin_test*` database. PostgreSQL remains on the VPS; Windows connects through HTTPS to the narrowly exposed print-agent API and must remain in DryRun/simulation mode.

```text
Windows agent (HTTPS, explicit simulation opt-in, DryRun)
        │
        ▼
    Caddy :443 ───── public DNS/TLS
        │ loopback only
        ▼
 AUTO-IN :3000 ───── systemd, simulation mode
        │ loopback only
        ▼
 PostgreSQL :5432 ─── autoin_test_vps only
```

The sample Caddy site exposes `GET /health`, `POST /internal/v1/print-jobs/claim`, and the per-job `preflight`, `mark-sending`, and `reports` POST routes. It returns 404 for all other paths, including staff APIs, pilot/source routes, and `/webhooks/zalo`. The backend still authenticates each agent request with a server-owned bearer credential. Do not add a wildcard proxy or expose port 3000/5432 publicly.

## Preparation steps for the owner

1. Provision a VPS and a DNS name reserved for simulation. Restrict the network firewall to SSH from the owner's address and public TCP 80/443 for Caddy. Do not add a Cloudflare Tunnel. Keep the provider console and SSH access under the owner's control.
2. Install a supported Node.js 24 release in the required `>=24.19.0 <25` range, PostgreSQL, and Caddy using their official package sources. Create a dedicated unprivileged `auto-in` OS account. Configure PostgreSQL to listen only on loopback and allow only a dedicated database role to connect to `autoin_test_vps`; never reuse production credentials or data.
3. Check out and verify the exact reviewed simulation commit into `/opt/auto-in/releases/<full-sha>`, install the lockfile dependencies with `npm ci`, and run `npm run build`. Point `/opt/auto-in/current` at that verified release. Do not deploy a branch tip or an unreviewed workspace snapshot.
4. Create an empty `autoin_test_vps` database and a dedicated role. Put the database URL in `/etc/auto-in/simulation.env` based on `simulation.env.example`; set that file to owner `root`, group `auto-in`, mode `0640`. Set `AUTOIN_ALLOW_PG_ACCEPTANCE=YES_ISOLATED_TEST_DB` only in the one migration command environment. The existing migration guard must accept the numeric loopback database before running `npm run db:migrate`; if it refuses the connection, stop and investigate rather than changing the guard. The migration runner does not create the database or bootstrap the owner account.
5. For a synthetic agent-only smoke check, create `/etc/auto-in/simulation-identities.json` from the example with a newly generated random bearer token and a synthetic `shop_id`. Keep the token outside chat and Git; set the file to owner `auto-in`, mode `0600`. Set its corresponding `AUTOIN_IDENTITIES_FILE` in the env file. The current Windows CLI reads `AUTO_IN_AGENT_TOKEN` from its process environment; it does not yet provide a credential vault. Until local token storage and startup are reviewed, use only a one-session manual simulation and do not configure automatic startup. Do not reuse OA, staff, or customer credentials. An empty/synthetic test database still needs an approved job fixture before `claim` can return a job.
6. Install `autoin-simulation.service` as `/etc/systemd/system/autoin-simulation.service`. Replace `simulation.example.com` in `Caddyfile.example` with the owner's simulation DNS name and install it in Caddy's config. Validate both configs before starting services. Caddy obtains HTTPS certificates for the configured DNS name. Keep Node bound to `127.0.0.1:3000` and PostgreSQL bound to `127.0.0.1:5432`.
7. After the owner approves the change window, start the service and check the local and public `/health` responses. The response must identify `mode: simulation` and `live_enabled: false`. Verify unlisted paths return 404 and the agent API rejects missing/invalid credentials. Then use only a synthetic job and the Windows DryRun client. Never infer successful paper output from a simulated response.

Before applying this profile, replace `simulation.example.com`, confirm the exact release SHA and clean checkout, validate Caddy/systemd configuration, and inspect the VPS firewall and PostgreSQL listener from the provider console. Do not copy real customer data into this environment. Do not create a real Zalo webhook, enable an outbound worker, or send a physical print job as part of this guide. Public webhook ingress, media fetching, live OA signature verification, production database handling, staff UI authentication/rate limiting, and Ricoh paper output remain separate release gates and are not configured here.
