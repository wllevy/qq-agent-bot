param(
    [ValidateSet('start','stop','restart','status','enable','disable')][string]$Action = 'status',
    [string]$BotHome = $env:QQ_AGENT_HOME,
    [string]$NodePath,
    [switch]$Json
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
try {
    $BotRoot = Split-Path $PSScriptRoot -Parent
    if ($BotHome) { $env:QQ_AGENT_HOME = [IO.Path]::GetFullPath($BotHome) }
    if (-not $NodePath) { $NodePath = (Get-Command node.exe).Source }
    Set-Location -LiteralPath $BotRoot
    $Paths = (& $NodePath (Join-Path $BotRoot 'dist/src/cli.js') paths | ConvertFrom-Json)
    if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve bot paths' }
    $DataRoot = $Paths.dataDir
    $TaskName = if ($BotHome) { 'QQ Agent Bot' } else { 'QQ Codex Private Bot' }
    function Get-LiveProcess([string]$Name, [string]$Expected) {
        $File = Join-Path $DataRoot $Name
        if (Test-Path -LiteralPath $File) {
            $ProcessId = 0
            if ([int]::TryParse((Get-Content -Raw -LiteralPath $File).Trim(), [ref]$ProcessId)) {
                $Item = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
                if ($Item -and $Item.CommandLine -and $Item.CommandLine.IndexOf($Expected, [StringComparison]::OrdinalIgnoreCase) -ge 0) { return $Item }
            }
        }
        return $null
    }
    function Get-Supervisor { Get-LiveProcess 'supervisor.pid' (Join-Path $PSScriptRoot 'supervisor.mjs') }
    function Start-Bot {
        if (Get-Supervisor) { return }
        if (Get-LiveProcess 'bot.pid' 'main.js') { throw 'Bot is already running in foreground' }
        New-Item -ItemType Directory -Force -Path $DataRoot | Out-Null
        Start-Process -FilePath $NodePath -ArgumentList @('"' + (Join-Path $PSScriptRoot 'supervisor.mjs') + '"') -WorkingDirectory $BotRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $DataRoot 'bot.log') -RedirectStandardError (Join-Path $DataRoot 'bot-error.log') | Out-Null
        Start-Sleep -Seconds 2
        if (-not (Get-Supervisor)) { throw "Supervisor did not start; inspect $DataRoot/bot-error.log" }
    }
    function Stop-Bot {
        if (-not (Get-Supervisor)) {
            if (Get-LiveProcess 'bot.pid' 'main.js') { throw 'Stop the foreground bot in its terminal first' }
            return
        }
        Set-Content -LiteralPath (Join-Path $DataRoot 'stop') -Value 'stop'
        $Deadline = (Get-Date).AddSeconds(50)
        while ((Get-Supervisor) -and (Get-Date) -lt $Deadline) { Start-Sleep -Milliseconds 500 }
        if (Get-Supervisor) { throw 'Bot has not stopped; inspect its logs' }
    }
    $Task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    $Launcher = if ($BotHome) { Join-Path $BotHome 'bin/launcher.mjs' } else { Join-Path $BotRoot 'dist/src/cli.js' }
    if ($Task -and $Action -in @('enable','disable') -and -not ($Task.Actions.Arguments -like ('*"' + $Launcher + '"*'))) {
        # Legacy source task points at this exact PowerShell script.
        if ($BotHome -or -not ($Task.Actions.Arguments -like ('*"' + $PSCommandPath + '"*'))) { throw 'The task name belongs to another installation' }
    }
    switch ($Action) {
        'start' { Start-Bot }
        'stop' { Stop-Bot }
        'restart' { Stop-Bot; Start-Bot }
        'enable' {
            $TaskAction = New-ScheduledTaskAction -Execute $NodePath -Argument ('"' + $Launcher + '" service start') -WorkingDirectory $BotRoot
            $User = [Security.Principal.WindowsIdentity]::GetCurrent().Name
            $Trigger = New-ScheduledTaskTrigger -AtLogOn -User $User
            $Principal = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Limited
            $Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
            Register-ScheduledTask -TaskName $TaskName -Action $TaskAction -Trigger $Trigger -Principal $Principal -Settings $Settings -Force | Out-Null
            Start-Bot
        }
        'disable' { if ($Task) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false } }
    }
    $Current = Get-Supervisor
    $Child = Get-LiveProcess 'bot.pid' 'main.js'
    $State = if ($Current -or $Child) { 'starting' } else { 'stopped' }
    $StatusFile = Join-Path $DataRoot 'runtime-status.json'
    if ($Child -and (Test-Path -LiteralPath $StatusFile)) {
        try {
            $Runtime = Get-Content -Raw -LiteralPath $StatusFile | ConvertFrom-Json
            if ($Runtime.pid -eq $Child.ProcessId) { $State = $Runtime.state }
        } catch { }
    }
    $Result = [ordered]@{ status = $State; supervisorPid = $Current.ProcessId; botPid = $Child.ProcessId; dataDir = $DataRoot }
    if ($Json) { $Result | ConvertTo-Json -Compress } else { Write-Output ("Bot: " + $State + "; data: " + $DataRoot) }
} catch {
    if ($Json) { @{ status = 'error'; message = $_.Exception.Message } | ConvertTo-Json -Compress } else { Write-Error $_ }
    exit 1
}
