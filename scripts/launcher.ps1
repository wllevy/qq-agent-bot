$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$InstallRoot = Split-Path $PSScriptRoot -Parent
$Active = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $InstallRoot 'current.json') | ConvertFrom-Json
& $Active.node (Join-Path $PSScriptRoot 'launcher.mjs') @args
exit $LASTEXITCODE
