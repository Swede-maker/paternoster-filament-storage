# Removes PAX from this Windows PC.
#
#   Double-click windows\Uninstall-PAX.cmd, Start menu > PAX > Uninstall PAX,
#   or Settings > Apps > PAX > Uninstall.
#
# Your filament database is KEPT unless you answer yes (or pass -RemoveData).
# Node.js, Git and Python stay installed; remove them in Settings > Apps if you
# do not need them. ASCII only (Windows PowerShell 5.1).
[CmdletBinding()]
param([switch]$RemoveData, [switch]$Yes)
$ErrorActionPreference = 'Stop'

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$Base = Join-Path $env:ProgramData 'PAX'
$StateFile = Join-Path $Base 'windows.json'
$cfg = if (Test-Path $StateFile) { Get-Content $StateFile -Raw | ConvertFrom-Json } else { $null }
$InstallDir = if ($cfg -and $cfg.installDir) { $cfg.installDir } else { 'C:\PAX' }
$DataDir = if ($cfg) { $cfg.dataDir } else { Join-Path $Base 'data' }

# Run from a temp copy so the install folder (where this file lives) can be deleted.
$tempSelf = Join-Path $env:TEMP 'pax-uninstall.ps1'
if (-not $isAdmin -or $PSCommandPath -ne $tempSelf) {
  Copy-Item $PSCommandPath $tempSelf -Force
  $pass = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$tempSelf`"")
  if ($RemoveData) { $pass += '-RemoveData' }
  if ($Yes) { $pass += '-Yes' }
  if ($isAdmin) { & powershell.exe @pass } else { Start-Process powershell.exe -Verb RunAs -ArgumentList $pass }
  exit
}

function Say($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Ask-YesNo($q, $default) {
  if ($Yes) { return $default }
  $hint = if ($default) { '[Y/n]' } else { '[y/N]' }
  $a = Read-Host "$q $hint"
  if (-not $a) { return $default }
  return $a -match '^(y|j)'
}

Write-Host ''
Write-Host 'PAX Paternoster - uninstall' -ForegroundColor White
Write-Host ''
if (-not (Ask-YesNo "Remove PAX from this PC ($InstallDir)?" $true)) { exit }
if (-not $RemoveData -and -not $Yes) {
  $RemoveData = Ask-YesNo "Also DELETE your filament database in $DataDir? Answer no to keep it for a later reinstall." $false
}

Say 'Stopping PAX'
foreach ($t in 'PAX App', 'PAX Agent') {
  if (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $t -Confirm:$false
  }
}
Get-CimInstance Win32_Process | Where-Object {
  $_.ProcessId -ne $PID -and $_.CommandLine -and (
    $_.CommandLine -like '*run-app.ps1*' -or $_.CommandLine -like '*run-agent.ps1*' -or
    (($_.Name -in 'node.exe', 'python.exe', 'cmd.exe') -and $_.CommandLine -like "*$InstallDir*"))
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

$helper = Join-Path $InstallDir 'app\pi-agent\win_net.ps1'
if (Test-Path $helper) { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $helper hotspot-down | Out-Null }
Start-Sleep -Seconds 2

Say 'Removing firewall rules, Start menu entries and the Apps list entry'
Get-NetFirewallRule -Group 'PAX' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
Remove-Item (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\PAX') -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path ([Environment]::GetFolderPath('CommonDesktopDirectory')) 'PAX.url') -Force -ErrorAction SilentlyContinue
Remove-Item 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\PAX' -Recurse -Force -ErrorAction SilentlyContinue
Remove-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Services\icssvc\Settings' -Name 'PeerlessTimeoutEnabled' -ErrorAction SilentlyContinue

Say "Deleting $InstallDir"
for ($i = 0; $i -lt 5 -and (Test-Path $InstallDir); $i++) {
  try { Remove-Item $InstallDir -Recurse -Force } catch { Start-Sleep -Seconds 2 }
}
if (Test-Path $InstallDir) { Write-Host "!!  Some files in $InstallDir were in use. Restart the PC and delete the folder." -ForegroundColor Yellow }

if ($RemoveData) {
  Say "Deleting $Base (database, backups, hotspot settings, logs)"
  Remove-Item $Base -Recurse -Force -ErrorAction SilentlyContinue
} else {
  Remove-Item (Join-Path $Base 'logs') -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $StateFile -Force -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host 'PAX has been removed.' -ForegroundColor Green
if (-not $RemoveData) {
  Write-Host "Your database and backups are still in $DataDir."
  Write-Host 'Installing PAX again picks them up automatically.'
}
Write-Host 'Node.js, Git and Python were left installed (Settings > Apps if you want them gone).'
Write-Host ''
if (-not $Yes) { Read-Host 'Press Enter to close' | Out-Null }
