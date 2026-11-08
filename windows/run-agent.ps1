# Runs the PAX master agent (slave sign-in + Wi-Fi provisioning) and picks the
# network behaviour from how this PC is connected:
#
#   cable  An Ethernet adapter is up with a gateway. Slaves are on the router
#          too, so everything talks through the router. The agent runs with
#          --no-hotspot and never touches this PC's network.
#   wifi   No working cable. Behaves like a Raspberry Pi master: if the router
#          disappears it opens the PAX-Setup hotspot (Windows Mobile Hotspot)
#          and the slaves fall back to it.
#
# The link is re-checked every 15 s; when it changes (cable plugged in or
# pulled out) the agent is restarted in the other mode. Slaves reconnect on
# their own. Force one mode with  install.ps1 -NetworkMode cable|wifi.
# ASCII only (Windows PowerShell 5.1).
$ErrorActionPreference = 'Continue'
$base = Join-Path $env:ProgramData 'PAX'
$cfg = Get-Content (Join-Path $base 'windows.json') -Raw | ConvertFrom-Json
$logDir = Join-Path $base 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir 'agent.log'
$agentDir = Join-Path $cfg.appDir 'pi-agent'
$agent = Join-Path $agentDir 'paternoster_agent.py'
$helper = Join-Path $agentDir 'win_net.ps1'

function Write-Log($msg) { Add-Content -Path $log -Value "[$(Get-Date -Format s)] $msg" -Encoding ascii }
function Rotate-Log {
  if ((Test-Path $log) -and (Get-Item $log).Length -gt 5MB) { Move-Item -Force $log "$log.1" }
}

function Get-LinkMode {
  if ($cfg.networkMode -eq 'cable' -or $cfg.networkMode -eq 'wifi') { return $cfg.networkMode }
  $physical = @(Get-NetAdapter -Physical -ErrorAction SilentlyContinue)
  foreach ($a in ($physical | Where-Object { $_.NdisPhysicalMedium -eq 14 -and $_.Status -eq 'Up' })) {
    $gw = (Get-NetIPConfiguration -InterfaceIndex $a.ifIndex -ErrorAction SilentlyContinue).IPv4DefaultGateway
    if ($gw) { return 'cable' }
  }
  # No Wi-Fi adapter at all: there is nothing to run a hotspot on.
  if (-not ($physical | Where-Object { $_.NdisPhysicalMedium -eq 9 })) { return 'cable' }
  return 'wifi'
}

$env:PAXNET_CONF = Join-Path $base 'paxnet.conf'
$env:PAX_MOTOR_CONF = Join-Path $cfg.dataDir 'motor.json'
$env:PYTHONUNBUFFERED = '1'
$env:PYTHONIOENCODING = 'utf-8'

while ($true) {
  Rotate-Log
  $mode = Get-LinkMode
  $extra = ''
  if ($mode -eq 'cable') {
    $extra = '--no-hotspot'
    # Leaving Wi-Fi mode: do not leave a fallback hotspot running.
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $helper hotspot-down | Out-Null
  }
  Write-Log "starting master agent in $mode mode"
  $cmdLine = "/s /c `"`"$($cfg.python)`" -u `"$agent`" --no-carousel --role master --name `"PAX server`" --port $($cfg.agentPort) $extra >> `"$log`" 2>&1`""
  $p = Start-Process -FilePath cmd.exe -ArgumentList $cmdLine -WorkingDirectory $agentDir -WindowStyle Hidden -PassThru

  $changedCount = 0
  while (-not $p.HasExited) {
    Start-Sleep -Seconds 15
    if ((Get-LinkMode) -ne $mode) { $changedCount++ } else { $changedCount = 0 }
    if ($changedCount -ge 2) {
      Write-Log "network changed (was $mode) - restarting the agent"
      & taskkill.exe /T /F /PID $p.Id | Out-Null
      break
    }
  }
  if ($changedCount -lt 2) { Write-Log "agent exited, restarting in 3 s" }
  Start-Sleep -Seconds 3
}
