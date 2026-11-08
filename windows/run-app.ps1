# Runs the PAX web app and restarts it if it stops. Started at boot by the
# "PAX App" scheduled task (as SYSTEM). Settings come from windows.json,
# written by install.ps1. ASCII only (Windows PowerShell 5.1).
$ErrorActionPreference = 'Continue'
$base = Join-Path $env:ProgramData 'PAX'
$cfg = Get-Content (Join-Path $base 'windows.json') -Raw | ConvertFrom-Json
$logDir = Join-Path $base 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir 'app.log'

function Write-Log($msg) { Add-Content -Path $log -Value "[$(Get-Date -Format s)] $msg" -Encoding ascii }
function Rotate-Log {
  if ((Test-Path $log) -and (Get-Item $log).Length -gt 5MB) { Move-Item -Force $log "$log.1" }
}

$env:NODE_ENV = 'production'
$env:PORT = "$($cfg.appPort)"
$env:HOSTNAME = '0.0.0.0'
$env:PATERNOSTER_DB_PATH = Join-Path $cfg.dataDir 'paternoster.db'
$env:PAX_DATA_DIR = $cfg.dataDir
$env:PAX_BRANCH = $cfg.branch
$env:PAX_PLATFORM = 'windows'

Set-Location $cfg.appDir
$next = Join-Path $cfg.appDir 'node_modules\next\dist\bin\next'

while ($true) {
  Rotate-Log
  Write-Log "starting web app on port $($cfg.appPort)"
  # cmd does the redirection so node's output lands in the log as plain bytes.
  & cmd.exe /s /c "`"`"$($cfg.node)`" `"$next`" start -p $($cfg.appPort) >> `"$log`" 2>&1`""
  Write-Log "web app exited (code $LASTEXITCODE), restarting in 3 s"
  Start-Sleep -Seconds 3
}
