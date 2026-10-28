param([ValidateSet('start','stop','restart','status','enable','disable')][string]$Action = 'status')
$ErrorActionPreference = 'Stop'
$BotRoot = Split-Path $PSScriptRoot -Parent
$DataRoot = Join-Path $BotRoot 'data'
$TaskName = 'QQ Codex Private Bot'
New-Item -ItemType Directory -Force -Path $DataRoot | Out-Null
function Get-BotSupervisor {
    $PidPath = Join-Path $DataRoot 'supervisor.pid'
    if (Test-Path -LiteralPath $PidPath) {
        $BotPid = [int](Get-Content -LiteralPath $PidPath)
        $Process = Get-CimInstance Win32_Process -Filter "ProcessId=$BotPid" -ErrorAction SilentlyContinue
        if ($Process -and $Process.CommandLine.IndexOf((Join-Path $PSScriptRoot 'supervisor.mjs'), [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { return $Process }
    }
    return $null
}
function Start-Bot {
    $Current = Get-BotSupervisor
    if ($Current) { Write-Output "Bot 已在后台运行，监督进程 PID $($Current.ProcessId)"; return }
    if (-not (Test-Path -LiteralPath (Join-Path $BotRoot 'dist/src/main.js'))) { throw '缺少构建产物，请先运行 npm run build' }
    $Node = (Get-Command node.exe).Source
    Start-Process -FilePath $Node -ArgumentList @('"' + (Join-Path $PSScriptRoot 'supervisor.mjs') + '"') -WorkingDirectory $BotRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $DataRoot 'bot.log') -RedirectStandardError (Join-Path $DataRoot 'bot-error.log') | Out-Null
    Start-Sleep -Seconds 2
    $Current = Get-BotSupervisor
    if (-not $Current) { throw 'Bot 后台启动失败，请查看 data/bot-error.log' }
    Write-Output "Bot 已在后台启动，监督进程 PID $($Current.ProcessId)"
}
function Stop-Bot {
    if (-not (Get-BotSupervisor)) { Write-Output 'Bot 未运行'; return }
    Set-Content -LiteralPath (Join-Path $DataRoot 'stop') -Value 'stop'
    $Deadline = (Get-Date).AddSeconds(50)
    while ((Get-BotSupervisor) -and (Get-Date) -lt $Deadline) { Start-Sleep -Milliseconds 500 }
    if (Get-BotSupervisor) { throw 'Bot 尚未退出，请检查后台日志' }
    Write-Output 'Bot 已停止'
}
switch ($Action) {
    'start' { Start-Bot }
    'stop' { Stop-Bot }
    'restart' { Stop-Bot; Start-Bot }
    'status' {
        $Current = Get-BotSupervisor
        if ($Current) { Write-Output "后台运行中，监督进程 PID $($Current.ProcessId)" } else { Write-Output 'Bot 未运行' }
        Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Select-Object TaskName,State
    }
    'enable' {
        $TaskAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" start') -WorkingDirectory $BotRoot
        $User = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
        $Trigger = New-ScheduledTaskTrigger -AtLogOn -User $User
        $Principal = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Limited
        $Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
        Register-ScheduledTask -TaskName $TaskName -Action $TaskAction -Trigger $Trigger -Principal $Principal -Settings $Settings -Force | Out-Null
        Write-Output '已设置当前用户登录后自动启动'
        Start-Bot
    }
    'disable' { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue; Write-Output '已取消登录自启动' }
}
