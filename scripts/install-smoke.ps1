param([Parameter(Mandatory=$true)][string]$PackagePath, [switch]$Offline)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$PackagePath = (Resolve-Path -LiteralPath $PackagePath).Path
$Root = Join-Path ([IO.Path]::GetTempPath()) ('qq-agent-smoke-' + [guid]::NewGuid().ToString('N'))
$HomeDir = Join-Path $Root '安装目录 space'
$Node = (Get-Command node.exe).Source
New-Item -ItemType Directory -Path $Root | Out-Null
$Extra = @()
if ($Offline) { $Extra += '-Offline' }
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'install.ps1') -InstallHome $HomeDir -PackagePath $PackagePath -NodePath $Node -SkipSetup -NoPath @Extra
if ($LASTEXITCODE -ne 0) { throw 'Fresh install failed' }
$Launcher = Join-Path $HomeDir 'bin/launcher.mjs'
function Invoke-Bot([string[]]$CommandArgs, [int]$ExpectedExit = 0) {
    $Output = & $Node $Launcher @CommandArgs
    if ($LASTEXITCODE -ne $ExpectedExit) { throw "CLI failed: $($CommandArgs -join ' '); output: $Output" }
    return $Output
}
$Active = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $HomeDir 'current.json') | ConvertFrom-Json
$CommandVersion = & (Join-Path $HomeDir 'bin/qq-agent-bot.cmd') version
if ($LASTEXITCODE -ne 0 -or $CommandVersion -ne $Active.version) { throw 'Windows command wrapper failed' }
if (Test-Path -LiteralPath (Join-Path $Active.root 'node_modules/typescript')) { throw 'Development dependencies in runtime install' }
if (Test-Path -LiteralPath (Join-Path $Active.root '.env')) { throw 'Credentials in package' }
$Report = Invoke-Bot @('doctor', '--json') 1 | ConvertFrom-Json
if ($Report.status -ne 'needs_credentials') { throw 'Fresh installation should need credentials' }
$Paths = Invoke-Bot @('paths') | ConvertFrom-Json
if ($Paths.dataDir -ne (Join-Path $HomeDir 'data')) { throw 'Data path depends on current directory' }
$ConfigInput = Join-Path $Root 'fixture.json'
[IO.File]::WriteAllText($ConfigInput, '{"QQBOT_APP_ID":"123","QQBOT_APP_SECRET":"installation-fixture-only","CODEX_ENABLED":"false","CLAUDE_ENABLED":"true","CLAUDE_PERMISSION_MODE":"bypassPermissions"}')
$Configured = Invoke-Bot @('setup', '--non-interactive', '--config-file', $ConfigInput, '--json') | ConvertFrom-Json
if ($Configured.status -ne 'configured') { throw 'Non-interactive setup failed' }
$SavedEnv = Get-Content -Raw -LiteralPath $Paths.configFile
if ($SavedEnv -notmatch 'bypassPermissions') { throw 'Permission setting lost' }
$Status = Invoke-Bot @('service', 'status', '--json') | ConvertFrom-Json
if ($Status.status -ne 'stopped') { throw 'Stopped service falsely reported running' }
$Pair = Invoke-Bot @('pair', 'start', '--json') 2 | ConvertFrom-Json
if ($Pair.status -ne 'needs_service') { throw 'Pairing should require service' }
# Build an isolated future-version fixture to exercise the same upgrade path.
$Future = Join-Path $Root 'future'
Expand-Archive -LiteralPath $PackagePath -DestinationPath $Future
$FixtureScript = Join-Path $Root 'fixture.mjs'
[IO.File]::WriteAllText($FixtureScript, @'
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
for (const name of ['package.json', 'package-lock.json']) {
  const file = join(process.argv[2], name), value = JSON.parse(readFileSync(file, 'utf8'));
  value.version = '99.0.0';
  if (name === 'package-lock.json') value.packages[''].version = '99.0.0';
  writeFileSync(file, JSON.stringify(value, null, 2));
}
'@)
& $Node $FixtureScript $Future
if ($LASTEXITCODE -ne 0) { throw 'Version fixture failed' }
$FutureZip = Join-Path $Root 'future.zip'
Compress-Archive -Path (Join-Path $Future '*') -DestinationPath $FutureZip
$StateFile = Join-Path $Paths.dataDir 'state.json'
[IO.File]::WriteAllText($StateFile, '{"version":4,"fixture":"subscription-and-session-state"}')
$SavedState = Get-Content -Raw -LiteralPath $StateFile
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'install.ps1') -InstallHome $HomeDir -PackagePath $FutureZip -NodePath $Node -SkipSetup -NoPath @Extra
if ($LASTEXITCODE -ne 0) { throw 'Upgrade failed' }
if ((Invoke-Bot @('version')) -ne '99.0.0') { throw 'Stable launcher did not switch version' }
if ((Get-Content -Raw -LiteralPath $Paths.configFile) -cne $SavedEnv -or (Get-Content -Raw -LiteralPath $StateFile) -cne $SavedState) { throw 'Upgrade modified config or data' }
if (-not (Test-Path -LiteralPath $Active.root)) { throw 'Previous version was removed' }
# Repeating the installer is safe and leaves the existing installation usable.
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'install.ps1') -InstallHome $HomeDir -PackagePath $FutureZip -NodePath $Node -SkipSetup -NoPath @Extra
if ($LASTEXITCODE -ne 0) { throw 'Repeat installation failed' }
Write-Output "Installation smoke passed (isolated fixture retained at $Root)"
