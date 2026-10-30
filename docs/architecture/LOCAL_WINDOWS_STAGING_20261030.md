# Local Windows inbound staging (2026-10-30)

This entry point is for an **owner-operated local test on the Windows PC** that has Word and the Ricoh queue. It is separate from the normal simulation server. It accepts only a Zalo-signed inbound event whose OA and `user_id_by_app` are explicitly allow-listed, and writes through AI2's existing durable queue/quarantine ports.

**Machine split:** develop and review code on the Mac, publish the reviewed candidate branch to GitHub, then clone that branch onto the Windows PC and run this staging backend there. The webhook listener and its isolated PostgreSQL database stay on Windows; they do not run on the Mac or in cloud hosting. Windows must remain on while the local test is running. Updating code later means publishing a new candidate from the Mac and checking out its exact SHA on Windows.

It does not run a worker, expose staff/Core APIs, send outbound messages, or print. Health reports all those operations disabled. It does not fetch inbound media URLs. Unknown test users are rejected before the database write. Use a dedicated local test OA and test account; the allow-list identities must be synthetic. A real OA event must not be treated as a production order.

The signature adapter implements Zalo support's stated MAC-SHA256 formula but still lacks an official signed golden vector confirming the exact body bytes/timestamp representation. The staging process therefore requires an explicit local acknowledgement of that limitation. This is suitable only for a controlled test after the owner chooses to proceed; it is not a live-production approval.

The local staging listener reserves a 1.5-second response budget, uses a 350 ms PostgreSQL connection timeout, and applies 300 ms lock and 900 ms statement limits inside each transaction. During normal inbound processing it returns HTTP 200 only after the durable write commits. If the response budget expires or storage fails, it returns retryable HTTP 503; it never sends a success acknowledgement early. The one-shot discovery path is the exception: after the exact signed challenge is received, it returns HTTP 200 to intentionally discard that message without writing it. The HTTP timeout cannot cancel a database operation already in progress, so a write might finish after a 503; `(oa_id,event_id)` idempotency makes a Zalo retry safe. These are local safeguards, not a measurement of the full Zalo-to-Windows round trip.

## What Zalo has confirmed

The owner supplied a Zalo OA Support reply dated 2026-10-26. Zalo says Bot Flow actions such as “Go to scenario”, “Choice”, and “Confirm” are handled inside the flow and do not emit an independent webhook. To send that step's selected data to an external system, configure an **HTTP Request** card in that Bot Flow step. This is a request from the Bot Flow to an external endpoint; it does not change how the inbound OA webhook is configured.

Zalo Support confirms `user_id_by_app` is the stable user identity and each event includes `event_id` and `timestamp`. The integration uses `(oa_id,event_id)` for idempotency; `num_retry` is diagnostic only and must not be used as the event key. The [official webhook overview](https://developers.zalo.me/docs/official-account/webhook/tong-quan) says configure webhook delivery in the app, grant the linked OA the required access, respond with HTTP 200 within 2 seconds, and expect retries after 30 seconds, 5 minutes, 15 minutes, 30 minutes, and 1 hour when the connection fails. Retries add `num_retry`.

The [official message-event page](https://developers.zalo.me/docs/official-account/webhook/tin-nhan/su-kien-nguoi-dung-gui-tin-nhan) and the supplied Support screenshot state `X-ZEvent-Signature: mac=sha256(appId + data + timeStamp + OAsecretKey)`, with `data` being the JSON event string. The support email also describes the MAC as using the raw body together with app ID, timestamp, and user ID. These descriptions do not include a signed sample that shows the exact bytes and whether `user_id_by_app` is already covered only inside `data` or added separately. The page labels `timestamp` as milliseconds, but its example value is `154390853474`; the format and canonical bytes still need confirmation against a Zalo-signed vector. The current adapter assumes the exact raw HTTP body bytes plus the body timestamp. Do not relax its checks or call this production-verified until a signed vector or controlled OA delivery passes.

For `user_send_file`, Zalo says the attachment contains `size`, `name`, `checksum` (MD5), `type`, and a Zalo download `url`. This identifies the fields but does not establish URL host/authentication, redirect policy, expiry, download limits, retry behavior, or a trusted binding between downloaded bytes and the event. Staging still quarantines the event and does not fetch the URL; any future downloader must validate these properties and calculate its own SHA-256 over the bytes before custody.

## Windows PowerShell setup

Start with a **new folder** so an older checkout or local changes are left untouched. Run these commands in an ordinary PowerShell window. Use only the full candidate SHA supplied in the release handoff alongside this runbook; do not substitute the branch tip or another commit. Stop if the checked-out SHA differs. The project requires Node.js 24.19.0 or newer within major version 24; use the npm version bundled with Node.js. By default, the script uses Docker Desktop and the repository's PostgreSQL service bound to loopback. If Docker is not installed, use `-UseExistingPostgres` only when a local PostgreSQL service is already listening on `127.0.0.1:5432` and both `psql` and `createdb` are on `PATH`; that mode prompts for a database role with `CREATEDB` permission and a hidden password, then creates or reuses only `autoin_test_staging`.

```powershell
Set-Location $HOME\Documents
git clone --branch ai0/v1-color-intake-nodb-ci-20261025 https://github.com/minhdienhp2013/AUTO-IN.git AUTO-IN-V1
if ($LASTEXITCODE -ne 0) { throw 'Could not clone the reviewed V1 candidate' }
$expectedCandidate = Read-Host 'Enter the full candidate SHA supplied with this runbook'
if ($expectedCandidate -notmatch '^[0-9a-f]{40}$') { throw 'A full 40-character candidate SHA is required' }
git -C .\AUTO-IN-V1 checkout --detach $expectedCandidate
if ($LASTEXITCODE -ne 0) { throw 'Could not check out the reviewed V1 candidate' }
Set-Location .\AUTO-IN-V1
$actualCandidate = (git rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $actualCandidate -ne $expectedCandidate) {
  throw "Wrong candidate SHA: $actualCandidate"
}
.\scripts\windows-start-staging.ps1 -ExpectedCommit $expectedCandidate -Start
```

The script verifies the clean checkout, Node version, and selected local database; creates or reuses only the separate `autoin_test_staging` database; runs its migrations, checks, and build; prompts for test OA values (the secret prompt is hidden); then starts the listener on loopback. It does **not** open a tunnel, configure Zalo, download attachments, send messages, or print. Keep this PowerShell window open while testing and press Ctrl+C to stop the listener.

When the PC has local PostgreSQL but no Docker, add `-UseExistingPostgres` to the start command. The local PostgreSQL service must already be running on port 5432, and `psql` plus `createdb` must be available on `PATH`. The script asks for a local role with permission to create a database and its password using a hidden prompt; before creating or reusing the isolated staging database, it verifies the authenticated server reports exactly `listen_addresses=127.0.0.1` and `port=5432`. If either value cannot be read or differs, startup stops; the script never changes the PostgreSQL service configuration. It then verifies the role owns the isolated staging database before running migrations. If that database already existed, it must also have the exact `AUTO-IN-WINDOWS-LOCAL-STAGING-V1` marker; otherwise startup stops without migrating it. This mode does not create, alter, or stop a PostgreSQL service. If neither Docker nor a local PostgreSQL server is available, stop and install neither as part of this run; the owner must choose and authorize a database setup first.

Only when the Docker mode was selected, stop the local PostgreSQL container from the checkout folder if it is no longer needed. This keeps the named volume and isolated test data; do not add `-v`. Do not run this command in `-UseExistingPostgres` mode, because that mode uses a separately installed local service:

```powershell
docker compose -f .\compose.yaml down
```

If the test account's `user_id_by_app` is not known yet, first start discovery mode:

```powershell
.\scripts\windows-start-staging.ps1 -ExpectedCommit $expectedCandidate -Start -DiscoverTestUser
```

With an existing local PostgreSQL service, include both switches:

```powershell
.\scripts\windows-start-staging.ps1 -ExpectedCommit $expectedCandidate -Start -DiscoverTestUser -UseExistingPostgres
```

The script prints a fresh, random challenge such as `AUTO-IN-TEST-USER-...`. After independently opening a temporary tunnel and configuring only the dedicated test OA, send exactly that one-time text from the designated test account. The receiver captures the ID only from a correctly signed `user_send_text` for the exact challenge, prints only `user_id_by_app` locally, returns HTTP 200, and deliberately discards that challenge event without writing it to the database. If Zalo receives the 200 response, it should not retry the discarded event after the server restarts. Press Ctrl+C, start the script again without `-DiscoverTestUser`, enter that ID when prompted, restart/configure the tunnel if its temporary URL changed, and send a different test message. Discovery is one-shot per process and does not create an order or contact a customer. Do not send any ordinary messages to the test OA while discovery mode is open.

The remaining commands below are a manual equivalent/reference if you need to run the steps separately.

```powershell
$nodeVersionText = (node -p 'process.versions.node').Trim()
if ($LASTEXITCODE -ne 0) { throw 'Could not read Node.js version' }
$nodeVersion = [version]$nodeVersionText
if ($nodeVersion -lt [version]'24.19.0' -or $nodeVersion -ge [version]'25.0.0') {
  throw "Use Node.js >=24.19.0 and <25.0.0; found $nodeVersionText"
}
node --version
npm --version
foreach ($name in @('DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH',
  'COMPOSE_FILE','COMPOSE_ENV_FILES','COMPOSE_PROJECT_NAME','COMPOSE_PROFILES')) {
  if (Test-Path "Env:$name") { throw "Unset inherited $name before continuing" }
}
$dockerHost = (docker context inspect --format '{{.Endpoints.docker.Host}}').Trim()
if ($LASTEXITCODE -ne 0 -or $dockerHost -notlike 'npipe://*') {
  throw 'Select a local Windows Docker Desktop context; remote Docker contexts are not allowed'
}
docker info --format '{{.ServerVersion}}'
if ($LASTEXITCODE -ne 0) { throw 'Start Docker Desktop before continuing' }
docker compose version
if ($LASTEXITCODE -ne 0) { throw 'Docker Desktop is required by this setup; stop without installing it' }
npm ci
docker compose -f .\compose.yaml up -d postgres
```

Create a separate empty database in that local Compose PostgreSQL. The command is safe to repeat and does not use the sample `auto_in` database:

```powershell
$dbExists = docker compose -f .\compose.yaml exec -T postgres psql -U auto_in -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = 'autoin_test_staging'"
if ($LASTEXITCODE -ne 0) { throw 'Could not query local Compose PostgreSQL' }
if ($dbExists.Trim() -ne '1') {
  docker compose -f .\compose.yaml exec -T postgres createdb -U auto_in -O auto_in autoin_test_staging
  if ($LASTEXITCODE -ne 0) { throw 'Could not create the isolated staging database' }
}
```

Set connection and opt-in values **in this PowerShell session only**. Do not put secrets in a file, PowerShell profile, Git, screenshots, or chat. The OA app ID, OA ID, secret, and test-user ID must come from an OA and test account the owner is authorized to use. The numeric ID below is a placeholder, not a real user:

```powershell
$env:DATABASE_URL = 'postgresql://auto_in:development_only@127.0.0.1:5432/autoin_test_staging'
$env:AUTO_IN_MODE = 'staging_local'
$env:AUTOIN_STAGING_ENABLED = '1'
$env:AUTOIN_STAGING_ACK = 'OWNER_APPROVED_LOCAL_TEST_ONLY'
$env:AUTOIN_STAGING_DB_ACK = 'OWNER_APPROVED_LOCAL_ISOLATED_TEST_DB'
$env:AUTOIN_STAGING_SIGNATURE_ACK = 'OWNER_ACCEPTS_SUPPORT_FORMULA_PENDING_SIGNED_VECTOR'
$env:HOST = '127.0.0.1'
$env:PORT = '3001'
$env:AUTOIN_STAGING_APP_ID = Read-Host 'Zalo app ID for the test OA'
$env:AUTOIN_STAGING_OA_ID = Read-Host 'Test OA ID'
$env:AUTOIN_STAGING_TEST_OA_ID = $env:AUTOIN_STAGING_OA_ID
$env:AUTOIN_STAGING_TEST_USERS_JSON = '{"1234567890123456":{"customer_id":"staging-customer-demo","conversation_id":"staging-conversation-demo"}}'
$secure = Read-Host 'Test OA secret key' -AsSecureString
$secretPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try { $env:AUTOIN_STAGING_OA_SECRET_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretPtr) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretPtr) }
```

Apply the app's existing migrations **only to this isolated loopback database**, then build and start the listener:

```powershell
npm run staging:db:migrate
if ($LASTEXITCODE -ne 0) { throw 'Local isolated database migration failed' }
npm run typecheck
if ($LASTEXITCODE -ne 0) { throw 'Typecheck failed' }
node --import tsx --test tests/unit/contracts/local-staging.test.ts
if ($LASTEXITCODE -ne 0) { throw 'Local staging guard tests failed' }
npm run build
if ($LASTEXITCODE -ne 0) { throw 'Build failed' }
npm run start:staging
```

In a second PowerShell window, confirm that only the local health endpoint is exposed by this process:

```powershell
Invoke-RestMethod http://127.0.0.1:3001/health
```

The response should say `mode: staging_local`, `staff_api_enabled: False`, `outbound_enabled: False`, and `printing_enabled: False`.

The dedicated `staging:db:migrate` guard accepts only `autoin_test_staging` on numeric loopback at explicit port 5432, with no URL parameters or inherited PostgreSQL connection overrides. The generic `db:migrate` command remains a separate isolated-test-only mode. Staging startup independently applies the exact staging DB guard and fails unless the required AI1/AI2 tables and the provider-event unique partial index are present. It never migrates automatically. Stop the server with Ctrl+C. Remove secrets from this PowerShell session when done:

```powershell
'AUTOIN_STAGING_APP_ID','AUTOIN_STAGING_OA_ID','AUTOIN_STAGING_TEST_OA_ID',
'AUTOIN_STAGING_OA_SECRET_KEY','AUTOIN_STAGING_TEST_USERS_JSON',
'AUTOIN_STAGING_ENABLED','AUTOIN_STAGING_ACK','AUTOIN_STAGING_DB_ACK',
'AUTOIN_STAGING_SIGNATURE_ACK','AUTOIN_STAGING_DISCOVER_USER_ONCE',
'AUTOIN_STAGING_DISCOVERY_ACK','AUTOIN_STAGING_DISCOVERY_CHALLENGE','DATABASE_URL' |
  ForEach-Object { Remove-Item "Env:$_" -ErrorAction SilentlyContinue }
```

## Optional manual webhook ingress

Local checks can use `http://127.0.0.1:3001/health`; no public route is needed for unit/synthetic checks. If the owner later decides to test delivery from Zalo, Cloudflare Tunnel can provide a temporary ingress to the loopback listener. This task does not launch it, create an account, or configure Zalo. Zalo recommends an HTTPS domain rather than a raw host/port; a temporary tunnel hostname has that shape only while the tunnel runs. In the OA app, configure `https://<temporary-host>/webhooks/zalo`, enable only the required message events, and ensure the test OA is authorized for the linked app. In Bot Flow, add an HTTP Request card only for button/choice data that must be sent out of the flow. A tunnel makes the webhook reachable from the public internet; use only the intended test OA/test user and stop the process immediately after the controlled test.

After independently reviewing the running local server and deciding to expose this test route, the owner may run the installed `cloudflared` command in a separate PowerShell window:

```powershell
cloudflared tunnel --url http://127.0.0.1:3001
```

The printed temporary hostname would need the `/webhooks/zalo` path in the OA's webhook setting. Press Ctrl+C to end the tunnel. Do not set up automatic startup, a permanent tunnel, or a production OA route from this document.

## Remaining checks

- Run the three UI states in a real browser and verify the client against a synthetic/mock API; that does not prove backend hydration or live Core integration.
- On the Windows PC, verify the installed Word version, open a public synthetic DOCX through the native Word review path, and inspect page count/layout without printing. Real paper output needs a separate explicit approval for one named test job.
- A tunnel/OA delivery test still depends on authorized test OA credentials and the raw-byte signature/timestamp assumptions should be checked against a Zalo-signed vector. The live endpoint must meet Zalo's 2-second/HTTP-200 delivery requirement; the current local listener has not been measured against a real OA. File/media download remains disabled/unimplemented here.
- No Windows, Word, Ricoh, real Zalo, or paper test was run while preparing this guide. Do not mark V1 operational from local listener health or successful migration alone.
