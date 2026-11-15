# QQ Agent Bot installer. Run in Windows PowerShell 5.1 or PowerShell 7.
[CmdletBinding()]
param(
    [string]$InstallHome = $(if ($env:QQ_AGENT_HOME) { $env:QQ_AGENT_HOME } else { Join-Path $env:LOCALAPPDATA 'QQAgentBot' }),
    [string]$Version = 'latest',
    [string]$PackagePath,
    [string]$NodePath,
    [switch]$SkipSetup,
    [switch]$NoPath,
    [switch]$Offline
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$InstallHome = [IO.Path]::GetFullPath($InstallHome)
New-Item -ItemType Directory -Force -Path $InstallHome | Out-Null
$PreviousPath = $env:PATH
try {
    if (-not $NodePath) {
        $NodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
        if ($NodeCommand) { $NodePath = $NodeCommand.Source }
    }
    $Compatible = $false
    if ($NodePath) {
        try {
            $NodeVersionText = & $NodePath -p 'process.versions.node'
            $Compatible = $LASTEXITCODE -eq 0 -and [int]$NodeVersionText.Split('.')[0] -ge 24
        } catch { $Compatible = $false }
    }
    if (-not $Compatible) {
        if ($Offline) { throw 'Offline installation requires Node.js 24+ via -NodePath or PATH' }
        $Arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm64' } else { 'x64' }
        $NodeVersion = '24.15.0'
        $Runtime = Join-Path $InstallHome 'runtime'
        New-Item -ItemType Directory -Force -Path $Runtime | Out-Null
        $NodeArchive = Join-Path $Runtime ('node-' + [guid]::NewGuid().ToString('N') + '.zip')
        Write-Host 'Downloading private Node.js runtime...'
        Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-$Arch.zip" -OutFile $NodeArchive
        $RuntimeStage = Join-Path $Runtime ([guid]::NewGuid().ToString('N'))
        Expand-Archive -LiteralPath $NodeArchive -DestinationPath $RuntimeStage
        $NodePath = Join-Path $RuntimeStage "node-v$NodeVersion-win-$Arch/node.exe"
    }
    $NodePath = (Resolve-Path -LiteralPath $NodePath).Path
    $NpmCli = Join-Path (Split-Path $NodePath -Parent) 'node_modules/npm/bin/npm-cli.js'
    if (-not (Test-Path -LiteralPath $NpmCli)) { throw 'This Node.js installation does not include npm' }
    $env:PATH = (Split-Path $NodePath -Parent) + ';' + $env:PATH
    $Helper = if ($PSScriptRoot) { Join-Path $PSScriptRoot 'npm-install.mjs' } else { '' }
    if (-not $Helper -or -not (Test-Path -LiteralPath $Helper)) {
        if ($Offline) { throw 'Offline installation requires npm-install.mjs next to this script' }
        $Helper = Join-Path $InstallHome ('npm-bootstrap-' + [guid]::NewGuid().ToString('N') + '.mjs')
        $HelperUrl = if ($Version -eq 'latest') { 'https://github.com/wllevy/qq-agent-bot/releases/latest/download/npm-install.mjs' } else { 'https://github.com/wllevy/qq-agent-bot/releases/download/v' + $Version.TrimStart('v') + '/npm-install.mjs' }
        Invoke-WebRequest -UseBasicParsing -Uri $HelperUrl -OutFile $Helper
    }
    $InstallArgs = @($Helper, '--home', $InstallHome, '--version', $Version)
    if ($PackagePath) { $InstallArgs += @('--package', (Resolve-Path -LiteralPath $PackagePath).Path) }
    if ($SkipSetup) { $InstallArgs += '--skip-setup' }
    if ($NoPath) { $InstallArgs += '--no-path' }
    if ($Offline) { $InstallArgs += '--offline' }
    & $NodePath @InstallArgs
    if ($LASTEXITCODE -ne 0) { throw 'npm installation or setup failed; inspect the output above' }
    Write-Host 'Open a new terminal to use qq-agent-bot from PATH.'
} finally {
    $env:PATH = $PreviousPath
}
