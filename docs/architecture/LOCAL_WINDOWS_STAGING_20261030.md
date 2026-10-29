# Local Windows inbound staging (2026-10-30)

This entry point is for an **owner-operated local test on the Windows PC** that has Word and the Ricoh queue. It is separate from the normal simulation server. It accepts only a Zalo-signed inbound event whose OA and `user_id_by_app` are explicitly allow-listed, and writes through AI2's existing durable queue/quarantine ports.

It does not run a worker, expose staff/Core APIs, send outbound messages, or print. Health reports all those operations disabled. It does not fetch inbound media URLs. Unknown test users are rejected before the database write. Use a dedicated local test OA and test account; the allow-list identities must be synthetic. A real OA event must not be treated as a production order.

The signature adapter implements Zalo support's stated MAC-SHA256 formula but still lacks an official signed golden vector confirming the exact body bytes/timestamp representation. The staging process therefore requires an explicit local acknowledgement of that limitation. This is suitable only for a controlled test after the owner chooses to proceed; it is not a live-production approval.

## Windows PowerShell setup

Start with a **new folder** so an older checkout or local changes are left untouched. Run these commands in an ordinary PowerShell window. They check out the exact reviewed GitHub candidate; stop if the SHA differs. The project requires Node.js 24.19.0 or newer within major version 24; use the npm version bundled with Node.js. The commands below require Docker Desktop installed and running; they start only the repository's PostgreSQL service, bound to loopback. If Docker is unavailable, stop here rather than installing software; we can adapt the steps to an existing local PostgreSQL service.

```powershell
Set-Location $HOME\Documents
git clone --branch ai0/v1-color-intake-nodb-ci-20261025 https://github.com/minhdienhp2013/AUTO-IN.git AUTO-IN-V1
if ($LASTEXITCODE -ne 0) { throw 'Could not clone the reviewed V1 candidate' }
git -C .\AUTO-IN-V1 checkout --detach 42e66de190a521daf6da44765ddef119cec7bbe1
if ($LASTEXITCODE -ne 0) { throw 'Could not check out the reviewed V1 candidate' }
Set-Location .\AUTO-IN-V1
$expectedCandidate = '42e66de190a521daf6da44765ddef119cec7bbe1'
$actualCandidate = (git rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $actualCandidate -ne $expectedCandidate) {
  throw "Wrong candidate SHA: $actualCandidate"
}
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
'AUTOIN_STAGING_SIGNATURE_ACK','DATABASE_URL' |
  ForEach-Object { Remove-Item "Env:$_" -ErrorAction SilentlyContinue }
```

## Optional manual webhook ingress

Local checks can use `http://127.0.0.1:3001/health`; no public route is needed for unit/synthetic checks. If the owner later decides to test delivery from Zalo, Cloudflare Tunnel can provide a temporary ingress to the loopback listener. This task does not launch it, create an account, or configure Zalo. A tunnel makes the webhook reachable from the public internet; use only the intended test OA/test user and stop the process immediately after the controlled test.

After independently reviewing the running local server and deciding to expose this test route, the owner may run the installed `cloudflared` command in a separate PowerShell window:

```powershell
cloudflared tunnel --url http://127.0.0.1:3001
```

The printed temporary hostname would need the `/webhooks/zalo` path in the OA's webhook setting. Press Ctrl+C to end the tunnel. Do not set up automatic startup, a permanent tunnel, or a production OA route from this document.

## Remaining checks

- Run the three UI states in a real browser and verify the client against a synthetic/mock API; that does not prove backend hydration or live Core integration.
- On the Windows PC, verify the installed Word version, open a public synthetic DOCX through the native Word review path, and inspect page count/layout without printing. Real paper output needs a separate explicit approval for one named test job.
- A tunnel/OA delivery test still depends on authorized test OA credentials and the raw-byte signature assumption should be checked against a Zalo-signed vector. File/media download remains disabled/unimplemented here.
- No Windows, Word, Ricoh, real Zalo, or paper test was run while preparing this guide. Do not mark V1 operational from local listener health or successful migration alone.
