[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-f]{40}$')]
  [string]$ExpectedCommit,

  [switch]$Start,

  [switch]$DiscoverTestUser
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)][string]$Program,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    & $Program @Arguments 2>&1
    $nativeExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  if ($nativeExitCode -ne 0) { throw "$Program failed with exit code $nativeExitCode" }
}

if (-not $Start) { throw 'Pass -Start explicitly to run inbound-only local staging.' }

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$expectedRoot = (Invoke-Checked -Program 'git' -Arguments @('-C', $repoRoot, 'rev-parse', '--show-toplevel') | Select-Object -Last 1).Trim()
if ([IO.Path]::GetFullPath($expectedRoot) -ne [IO.Path]::GetFullPath($repoRoot)) {
  throw 'Run this script from a Git checkout of AUTO-IN.'
}
$actualCommit = (Invoke-Checked -Program 'git' -Arguments @('-C', $repoRoot, 'rev-parse', 'HEAD') | Select-Object -Last 1).Trim()
if ($actualCommit -ne $ExpectedCommit) { throw "Wrong candidate SHA: $actualCommit" }
$workingChanges = Invoke-Checked -Program 'git' -Arguments @('-C', $repoRoot, 'status', '--porcelain')
if ($workingChanges) { throw 'The checkout has local changes; use a clean checkout of the reviewed candidate.' }

$nodeVersionText = (Invoke-Checked -Program 'node' -Arguments @('-p', 'process.versions.node') | Select-Object -Last 1).Trim()
$nodeVersion = [version]$nodeVersionText
if ($nodeVersion -lt [version]'24.19.0' -or $nodeVersion -ge [version]'25.0.0') {
  throw "Use Node.js >=24.19.0 and <25.0.0; found $nodeVersionText"
}

$blockedEnvironment = @(
  'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH',
  'COMPOSE_FILE', 'COMPOSE_ENV_FILES', 'COMPOSE_PROJECT_NAME', 'COMPOSE_PROFILES',
  'PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD', 'PGSSLMODE',
  'PGSSLCERT', 'PGSSLKEY', 'PGSSLROOTCERT', 'PGSERVICE', 'PGSERVICEFILE',
  'PGOPTIONS', 'PGAPPNAME', 'PGCHANNELBINDING', 'PGCONNECT_TIMEOUT'
)
foreach ($name in $blockedEnvironment) {
  if (Test-Path "Env:$name") { throw "Unset inherited $name and run again; remote or overridden services are not allowed." }
}

$dockerHost = (Invoke-Checked -Program 'docker' -Arguments @('context', 'inspect', '--format', '{{.Endpoints.docker.Host}}') | Select-Object -Last 1).Trim()
if ($dockerHost -notlike 'npipe://*') { throw 'Select a local Windows Docker Desktop context; remote Docker contexts are not allowed.' }
Invoke-Checked -Program 'docker' -Arguments @('info', '--format', '{{.ServerVersion}}') | Out-Host
Invoke-Checked -Program 'docker' -Arguments @('compose', 'version') | Out-Host

$environmentNames = @(
  'DATABASE_URL', 'AUTO_IN_MODE', 'AUTOIN_STAGING_ENABLED', 'AUTOIN_STAGING_ACK',
  'AUTOIN_STAGING_DB_ACK', 'AUTOIN_STAGING_SIGNATURE_ACK', 'HOST', 'PORT',
  'AUTOIN_STAGING_APP_ID', 'AUTOIN_STAGING_OA_ID', 'AUTOIN_STAGING_TEST_OA_ID',
  'AUTOIN_STAGING_OA_SECRET_KEY', 'AUTOIN_STAGING_TEST_USERS_JSON',
  'AUTOIN_STAGING_DISCOVER_USER_ONCE', 'AUTOIN_STAGING_DISCOVERY_ACK',
  'AUTOIN_STAGING_DISCOVERY_CHALLENGE'
)
$previousEnvironment = @{}
foreach ($name in $environmentNames) {
  $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

Push-Location $repoRoot
try {
  $env:DATABASE_URL = 'postgresql://auto_in:development_only@127.0.0.1:5432/autoin_test_staging'
  $env:AUTO_IN_MODE = 'staging_local'
  $env:AUTOIN_STAGING_ENABLED = '1'
  $env:AUTOIN_STAGING_ACK = 'OWNER_APPROVED_LOCAL_TEST_ONLY'
  $env:AUTOIN_STAGING_DB_ACK = 'OWNER_APPROVED_LOCAL_ISOLATED_TEST_DB'
  $env:AUTOIN_STAGING_SIGNATURE_ACK = 'OWNER_ACCEPTS_SUPPORT_FORMULA_PENDING_SIGNED_VECTOR'
  $env:HOST = '127.0.0.1'
  $env:PORT = '3001'

  $appId = Read-Host 'Zalo app ID for the dedicated test OA'
  $oaId = Read-Host 'Dedicated test OA ID'
  if ($appId -notmatch '^[A-Za-z0-9._:-]{1,128}$') { throw 'Invalid app ID.' }
  if ($oaId -notmatch '^[A-Za-z0-9._:-]{1,128}$') { throw 'Invalid OA ID.' }
  $env:AUTOIN_STAGING_APP_ID = $appId
  $env:AUTOIN_STAGING_OA_ID = $oaId
  $env:AUTOIN_STAGING_TEST_OA_ID = $oaId
  if ($DiscoverTestUser) {
    $env:AUTOIN_STAGING_DISCOVER_USER_ONCE = '1'
    $env:AUTOIN_STAGING_DISCOVERY_ACK = 'OWNER_APPROVED_ONE_LOCAL_TEST_ID_DISCOVERY'
    $env:AUTOIN_STAGING_TEST_USERS_JSON = '{}'
    $challenge = 'AUTO-IN-TEST-USER-' + [guid]::NewGuid().ToString('N').ToLowerInvariant()
    $env:AUTOIN_STAGING_DISCOVERY_CHALLENGE = $challenge
    Write-Host "Discovery mode: send exactly this one-time text from the designated test account: $challenge"
    Write-Host 'Only a validly signed user_send_text with this exact challenge is acknowledged and discarded; no event is stored.'
  } else {
    Remove-Item Env:AUTOIN_STAGING_DISCOVER_USER_ONCE -ErrorAction SilentlyContinue
    Remove-Item Env:AUTOIN_STAGING_DISCOVERY_ACK -ErrorAction SilentlyContinue
    Remove-Item Env:AUTOIN_STAGING_DISCOVERY_CHALLENGE -ErrorAction SilentlyContinue
    $userId = Read-Host 'user_id_by_app for the designated test account'
    if ($userId -notmatch '^\d{6,32}$') { throw 'Invalid user_id_by_app.' }
    $userMapping = @{}
    $userMapping[$userId] = @{
      customer_id = 'staging-customer-windows-test'
      conversation_id = 'staging-conversation-windows-test'
    }
    $env:AUTOIN_STAGING_TEST_USERS_JSON = $userMapping | ConvertTo-Json -Compress
  }

  $secureSecret = Read-Host 'Secret key for the dedicated test OA (input is hidden)' -AsSecureString
  $secretPointer = [IntPtr]::Zero
  try {
    $secretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureSecret)
    $env:AUTOIN_STAGING_OA_SECRET_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretPointer)
  } finally {
    if ($secretPointer -ne [IntPtr]::Zero) {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretPointer)
    }
    $secureSecret.Dispose()
  }

  Invoke-Checked -Program 'npm.cmd' -Arguments @('ci')
  Invoke-Checked -Program 'docker' -Arguments @('compose', '-f', '.\compose.yaml', 'up', '-d', 'postgres')

  $postgresReady = $false
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    & docker compose -f .\compose.yaml exec -T postgres pg_isready -U auto_in -d auto_in 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { $postgresReady = $true; break }
    Start-Sleep -Seconds 1
  }
  if (-not $postgresReady) { throw 'Local PostgreSQL did not become ready within 30 seconds.' }

  $dbExists = (Invoke-Checked -Program 'docker' -Arguments @(
    'compose', '-f', '.\compose.yaml', 'exec', '-T', 'postgres', 'psql', '-U', 'auto_in',
    '-d', 'postgres', '-tAc', "SELECT 1 FROM pg_database WHERE datname = 'autoin_test_staging'"
  ) | Select-Object -Last 1).Trim()
  if ($dbExists -ne '1') {
    Invoke-Checked -Program 'docker' -Arguments @(
      'compose', '-f', '.\compose.yaml', 'exec', '-T', 'postgres', 'createdb', '-U', 'auto_in',
      '-O', 'auto_in', 'autoin_test_staging'
    )
  }

  Invoke-Checked -Program 'npm.cmd' -Arguments @('run', 'staging:db:migrate')
  Invoke-Checked -Program 'npm.cmd' -Arguments @('run', 'typecheck')
  Invoke-Checked -Program 'node' -Arguments @('--import', 'tsx', '--test', 'tests/unit/contracts/local-staging.test.ts')
  Invoke-Checked -Program 'npm.cmd' -Arguments @('run', 'build')

  Write-Host 'Starting inbound-only staging on 127.0.0.1:3001. No tunnel is started; outbound messages and printing remain disabled.'
  Invoke-Checked -Program 'npm.cmd' -Arguments @('run', 'start:staging')
} finally {
  foreach ($name in $environmentNames) {
    [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process')
  }
  Pop-Location
}
