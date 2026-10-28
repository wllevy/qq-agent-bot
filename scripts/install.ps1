# QQ Agent Bot installer. Run in Windows PowerShell 5.1 or PowerShell 7.
[CmdletBinding()]
param(
    [string]$InstallHome = (Join-Path $env:LOCALAPPDATA 'QQAgentBot'),
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
$Repo = 'wllevy/qq-agent-bot'
$InstallHome = [IO.Path]::GetFullPath($InstallHome)
if ($InstallHome.Contains('"') -or $InstallHome.Contains('`')) { throw 'Unsupported quote in installation path' }
New-Item -ItemType Directory -Force -Path $InstallHome | Out-Null
$LockPath = Join-Path $InstallHome 'install.lock'
try { $InstallLock = [IO.File]::Open($LockPath, 'OpenOrCreate', 'ReadWrite', 'None') }
catch { throw 'Another installation is in progress' }
$PreviousHome = $env:QQ_AGENT_HOME
$PreviousPath = $env:PATH
try {
    $env:QQ_AGENT_HOME = $InstallHome
    $PointerPath = Join-Path $InstallHome 'current.json'
    if (Test-Path -LiteralPath $PointerPath) {
        $Previous = Get-Content -Raw -Encoding UTF8 -LiteralPath $PointerPath | ConvertFrom-Json
        $Paths = & $Previous.node (Join-Path $Previous.root 'dist/src/cli.js') paths | ConvertFrom-Json
        if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect existing installation' }
        $DataRoot = $Paths.dataDir
    } else { $DataRoot = Join-Path $InstallHome 'data' }
    foreach ($Name in @('bot.pid', 'supervisor.pid')) {
        $PidFile = Join-Path $DataRoot $Name
        if (Test-Path -LiteralPath $PidFile) {
            $ProcessId = 0
            if ([int]::TryParse((Get-Content -Raw -LiteralPath $PidFile).Trim(), [ref]$ProcessId) -and $ProcessId -gt 0 -and (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) {
                throw 'Bot is running. Wait for tasks to finish, then run qq-agent-bot service stop before updating.'
            }
        }
    }
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
    $Stage = Join-Path $InstallHome ('staging/' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $Stage | Out-Null
    if (-not $PackagePath) {
        if ($Offline) { throw '-Offline requires -PackagePath' }
        if ($Version -ne 'latest' -and $Version -notmatch '^v?\d+\.\d+\.\d+$') { throw 'Version must be latest or vX.Y.Z' }
        $Endpoint = if ($Version -eq 'latest') { "https://api.github.com/repos/$Repo/releases/latest" } else { "https://api.github.com/repos/$Repo/releases/tags/v$($Version.TrimStart('v'))" }
        $Release = Invoke-RestMethod -Uri $Endpoint -Headers @{ 'User-Agent' = 'qq-agent-bot-installer' }
        $Version = $Release.tag_name.TrimStart('v')
        $Asset = @($Release.assets | Where-Object { $_.name -eq "qq-agent-bot-v$Version.zip" })
        if ($Asset.Count -ne 1) { throw 'Release package is missing or ambiguous' }
        $PackagePath = Join-Path $Stage 'package.zip'
        Write-Host "Downloading QQ Agent Bot $Version..."
        Invoke-WebRequest -UseBasicParsing -Uri $Asset[0].browser_download_url -OutFile $PackagePath
    }
    $AppRoot = Join-Path $Stage 'app'
    Expand-Archive -LiteralPath $PackagePath -DestinationPath $AppRoot
    $Package = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $AppRoot 'package.json') | ConvertFrom-Json
    if ($Package.name -ne 'qq-codex-console' -or $Package.version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid QQ Agent Bot package' }
    if ($Version -ne 'latest' -and $Version.TrimStart('v') -ne $Package.version) { throw 'Package version does not match requested version' }
    $Version = $Package.version
    $Destination = Join-Path $InstallHome "versions/$Version"
    if (Test-Path -LiteralPath $Destination) {
        if ($Previous -and $Previous.version -eq $Version -and $Previous.root -eq $Destination) {
            Write-Host "Version $Version is already installed."
            if (-not $SkipSetup) {
                & $Previous.node (Join-Path $Destination 'dist/src/cli.js') setup
                if ($LASTEXITCODE -ne 0) { throw 'Setup is incomplete' }
            }
            return
        }
        throw "Version $Version already exists but is not active; inspect current.json before changing versions."
    }
    $NpmArgs = @($NpmCli, 'ci', '--omit=dev', '--no-audit', '--no-fund', '--prefix', $AppRoot)
    if ($Offline) { $NpmArgs += '--offline' }
    Write-Host 'Installing production dependencies...'
    & $NodePath @NpmArgs
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed; active version is unchanged' }
    $BuiltVersion = & $NodePath (Join-Path $AppRoot 'dist/src/cli.js') version
    if ($LASTEXITCODE -ne 0 -or $BuiltVersion -ne $Version) { throw 'Package CLI validation failed' }
    New-Item -ItemType Directory -Force -Path (Split-Path $Destination -Parent) | Out-Null
    foreach ($Target in @($AppRoot, $Destination)) {
        if (-not [IO.Path]::GetFullPath($Target).StartsWith($InstallHome.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Install path escaped installation home' }
    }
    Move-Item -LiteralPath $AppRoot -Destination $Destination
    $Bin = Join-Path $InstallHome 'bin'
    New-Item -ItemType Directory -Force -Path $Bin | Out-Null
    Copy-Item -LiteralPath (Join-Path $Destination 'scripts/launcher.mjs') -Destination (Join-Path $Bin 'launcher.mjs') -Force
    Copy-Item -LiteralPath (Join-Path $Destination 'scripts/launcher.ps1') -Destination (Join-Path $Bin 'launcher.ps1') -Force
    $Command = '@echo off' + "`r`n" + 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0launcher.ps1" %*' + "`r`n"
    [IO.File]::WriteAllText((Join-Path $Bin 'qq-agent-bot.cmd'), $Command, [Text.Encoding]::ASCII)
    $Pointer = @{ version = $Version; root = $Destination; node = $NodePath } | ConvertTo-Json
    $TemporaryPointer = Join-Path $InstallHome 'current.json.tmp'
    [IO.File]::WriteAllText($TemporaryPointer, $Pointer, (New-Object Text.UTF8Encoding($false)))
    if (Test-Path -LiteralPath $PointerPath) { [IO.File]::Replace($TemporaryPointer, $PointerPath, (Join-Path $InstallHome 'current.previous.json')) }
    else { [IO.File]::Move($TemporaryPointer, $PointerPath) }
    if (-not $NoPath) {
        $UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
        if (@($UserPath -split ';') -notcontains $Bin) {
            [Environment]::SetEnvironmentVariable('Path', (([string]$UserPath).TrimEnd(';') + ';' + $Bin).TrimStart(';'), 'User')
        }
    }
    Write-Host "Installed QQ Agent Bot $Version at $InstallHome"
    Write-Host "Command: $Bin/qq-agent-bot.cmd"
    Write-Host 'Open a new terminal to use qq-agent-bot from PATH.'
    if (-not $SkipSetup) {
        & $NodePath (Join-Path $Bin 'launcher.mjs') setup
        if ($LASTEXITCODE -ne 0) { throw 'Program installed; setup is incomplete. Run qq-agent-bot setup to continue.' }
    } else { Write-Host 'Setup skipped. Run qq-agent-bot setup, or migrate an existing deployment before configuring.' }
} finally {
    $env:QQ_AGENT_HOME = $PreviousHome
    $env:PATH = $PreviousPath
    $InstallLock.Dispose()
}
