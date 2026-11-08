# PAX installer for a Windows PC master (Windows 10 1809+ / Windows 11).
#
#   Double-click windows\Install-PAX.cmd
#   or, in PowerShell:
#   irm https://raw.githubusercontent.com/Swede-maker/paternoster-filament-storage/main/windows/install.ps1 | iex
#
# Running it again on an installed PC updates it (code + build) and keeps your
# data. Your database lives in %ProgramData%\PAX\data and a copy is put in
# %ProgramData%\PAX\data\backups before every update (the five newest are kept).
#
# Network behaviour is chosen automatically every 15 s (see run-agent.ps1):
#   cable -> slaves talk to this PC through the router, no hotspot
#   wifi  -> like a Pi master: opens the PAX-Setup hotspot if the router is gone
#
# Options:
#   -NetworkMode auto|cable|wifi   force a mode (default auto)
#   -Port 80                       web app port
#   -Yes                           do not ask anything (keeps the PC name)
#
# Remove it with windows\Uninstall-PAX.cmd, Start menu > PAX > Uninstall PAX,
# or Settings > Apps > PAX. ASCII only (Windows PowerShell 5.1).
[CmdletBinding()]
param(
  [ValidateSet('auto', 'cable', 'wifi')][string]$NetworkMode = '',
  [int]$Port = 0,
  [switch]$Yes,
  [string]$Repo = 'https://github.com/Swede-maker/paternoster-filament-storage.git',
  [string]$Branch = 'main',
  [string]$InstallDir = 'C:\PAX'
)
$ErrorActionPreference = 'Stop'
$RawUrl = 'https://raw.githubusercontent.com/Swede-maker/paternoster-filament-storage/main/windows/install.ps1'

# ---------------------------------------------------------------- elevation
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  $self = $PSCommandPath
  if (-not $self) {
    # Started with `irm ... | iex`: save a copy so it can restart as admin.
    $self = Join-Path $env:TEMP 'pax-install.ps1'
    Invoke-RestMethod $RawUrl -OutFile $self
  }
  $pass = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$self`"")
  if ($NetworkMode) { $pass += @('-NetworkMode', $NetworkMode) }
  if ($Port) { $pass += @('-Port', $Port) }
  if ($Yes) { $pass += '-Yes' }
  Write-Host 'PAX needs administrator rights - Windows will ask you to allow it.'
  Start-Process powershell.exe -Verb RunAs -ArgumentList $pass
  exit
}

$Base = Join-Path $env:ProgramData 'PAX'
$DataDir = Join-Path $Base 'data'
$BackupDir = Join-Path $DataDir 'backups'
$LogDir = Join-Path $Base 'logs'
$StateFile = Join-Path $Base 'windows.json'
$NetConf = Join-Path $Base 'paxnet.conf'
$AppDir = Join-Path $InstallDir 'app'
$ToolsDir = Join-Path $InstallDir 'tools'
$VenvDir = Join-Path $InstallDir 'venv'
$AgentPort = 8765
$TaskNames = @('PAX App', 'PAX Agent')

function Say($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Warn($m) { Write-Host "!!  $m" -ForegroundColor Yellow }
function Die($m) {
  Write-Host "ERROR: $m" -ForegroundColor Red
  if (-not $Yes) { Read-Host 'Press Enter to close' | Out-Null }
  exit 1
}
function Ask-YesNo($q, $default = $true) {
  if ($Yes) { return $default }
  $hint = if ($default) { '[Y/n]' } else { '[y/N]' }
  $a = Read-Host "$q $hint"
  if (-not $a) { return $default }
  return $a -match '^(y|j)'
}
function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}
# Native tools write progress to stderr; PowerShell 5.1 would treat that as a failure.
function Run([string]$exe, [string[]]$argv, [string]$cwd = $null) {
  $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  if ($cwd) { Push-Location $cwd }
  try {
    & $exe @argv 2>&1 | ForEach-Object { "    $_" } | Write-Host
    $code = $LASTEXITCODE
  } finally {
    if ($cwd) { Pop-Location }
    $ErrorActionPreference = $old
  }
  if ($code -ne 0) { throw "$exe $($argv -join ' ') failed (exit $code)" }
}

Write-Host ''
Write-Host 'PAX Paternoster - Windows master installer' -ForegroundColor White
Write-Host ''

# ---------------------------------------------------------------- existing install?
$old = $null
if (Test-Path $StateFile) { $old = Get-Content $StateFile -Raw | ConvertFrom-Json }
$isUpdate = [bool]$old
if ($isUpdate) {
  Say "PAX is already installed in $($old.appDir) - updating it. Your data is kept."
  if (-not $NetworkMode) { $NetworkMode = $old.networkMode }
  if (-not $Port) { $Port = [int]$old.appPort }
}
if (-not $NetworkMode) { $NetworkMode = 'auto' }

# ---------------------------------------------------------------- prerequisites
if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
  Die 'winget is missing. Install "App Installer" from the Microsoft Store, then run this again.'
}
function Ensure-Package($id, $testCmd) {
  if (Get-Command $testCmd -ErrorAction SilentlyContinue) { return }
  Say "Installing $id"
  Run 'winget' @('install', '-e', '--id', $id, '--silent', '--scope', 'machine', '--accept-package-agreements', '--accept-source-agreements')
  Refresh-Path
}
Ensure-Package 'Git.Git' 'git'
Ensure-Package 'OpenJS.NodeJS.LTS' 'node'

$nodeVer = (& node -v) -replace '^v', ''
if ([version]$nodeVer -lt [version]'20.9.0') {
  Say "Node.js $nodeVer is too old - upgrading to the current LTS"
  Run 'winget' @('upgrade', '-e', '--id', 'OpenJS.NodeJS.LTS', '--silent', '--accept-package-agreements', '--accept-source-agreements')
  Refresh-Path
}
$Node = (Get-Command node).Source

# The python.exe in WindowsApps is only a Store shortcut, not a real Python.
function Find-Python {
  foreach ($c in @(@('py', '-3'), @('python'))) {
    if (-not (Get-Command $c[0] -ErrorAction SilentlyContinue)) { continue }
    try {
      $argv = @($c | Select-Object -Skip 1) + @('-c', 'import sys;print(sys.executable);print("%d.%d"%sys.version_info[:2])')
      $out = & $c[0] @argv 2>$null
      if ($LASTEXITCODE -eq 0 -and $out.Count -ge 2 -and $out[0] -notmatch 'WindowsApps' -and [version]$out[1] -ge [version]'3.9') { return $out[0] }
    } catch { }
  }
  return $null
}
$BasePython = Find-Python
if (-not $BasePython) {
  Say 'Installing Python 3.12'
  Run 'winget' @('install', '-e', '--id', 'Python.Python.3.12', '--silent', '--scope', 'machine', '--accept-package-agreements', '--accept-source-agreements')
  Refresh-Path
  $BasePython = Find-Python
  if (-not $BasePython) { Die 'Python was installed but cannot be found. Restart the PC and run this again.' }
}

New-Item -ItemType Directory -Force -Path $InstallDir, $ToolsDir, $DataDir, $BackupDir, $LogDir | Out-Null
$Pnpm = Join-Path $ToolsDir 'pnpm.cmd'
if (-not (Test-Path $Pnpm)) {
  Say 'Installing pnpm'
  Run 'npm' @('install', '-g', 'pnpm@10', '--prefix', $ToolsDir)
}

# ---------------------------------------------------------------- stop running copy
function Stop-Pax {
  foreach ($t in $TaskNames) {
    if (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue) { Stop-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue }
  }
  $mine = @($PID)
  Get-CimInstance Win32_Process | Where-Object {
    $mine -notcontains $_.ProcessId -and $_.CommandLine -and (
      $_.CommandLine -like '*run-app.ps1*' -or $_.CommandLine -like '*run-agent.ps1*' -or
      (($_.Name -in 'node.exe', 'python.exe', 'cmd.exe') -and $_.CommandLine -like "*$InstallDir*"))
  } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
}
if ($isUpdate) { Say 'Stopping PAX'; Stop-Pax }

# ---------------------------------------------------------------- port
if (-not $Port) {
  $Port = 80
  $busy = Get-NetTCPConnection -LocalPort 80 -State Listen -ErrorAction SilentlyContinue
  if ($busy) {
    $Port = 8080
    Warn "Port 80 is already used by another program on this PC - PAX will use port 8080 instead."
  }
}

# ---------------------------------------------------------------- code
try {
  if (Test-Path (Join-Path $AppDir '.git')) {
    Say "Downloading the latest version ($Branch)"
    Run 'git' @('-C', $AppDir, 'fetch', '--depth', '1', 'origin', $Branch)
    Run 'git' @('-C', $AppDir, 'reset', '--hard', 'FETCH_HEAD')
  } else {
    if (Test-Path $AppDir) { Move-Item $AppDir "$AppDir.old-$(Get-Date -Format yyyyMMdd-HHmmss)" }
    Say "Downloading PAX into $AppDir"
    Run 'git' @('clone', '--depth', '1', '--branch', $Branch, $Repo, $AppDir)
  }
} catch { Die "could not download PAX: $_" }

# ---------------------------------------------------------------- data (never overwritten)
$Db = Join-Path $DataDir 'paternoster.db'
$LegacyDb = Join-Path $AppDir 'paternoster.db'
if ((Test-Path $LegacyDb) -and -not (Test-Path $Db)) {
  Say "Moving the existing database into $DataDir"
  foreach ($s in '', '-wal', '-shm') { if (Test-Path "$LegacyDb$s") { Move-Item "$LegacyDb$s" "$Db$s" } }
} elseif ((Test-Path $LegacyDb) -and (Test-Path $Db)) {
  Warn "Two databases found: $Db (used) and $LegacyDb (NOT used)."
  Warn 'Nothing was moved or deleted. If the second one holds your newest data, tell us before using the app.'
}
if (Test-Path $Db) {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  Say "Backing up the database to $BackupDir"
  foreach ($s in '', '-wal', '-shm') { if (Test-Path "$Db$s") { Copy-Item "$Db$s" (Join-Path $BackupDir "paternoster-$stamp.db$s") } }
  Get-ChildItem $BackupDir -Filter 'paternoster-*.db' | Sort-Object Name -Descending | Select-Object -Skip 5 | ForEach-Object {
    foreach ($s in '', '-wal', '-shm') { Remove-Item "$($_.FullName)$s" -Force -ErrorAction SilentlyContinue }
  }
}

# ---------------------------------------------------------------- build
try {
  Say 'Installing app dependencies (a few minutes the first time)'
  $env:CI = 'true'
  Run $Pnpm @('install', '--frozen-lockfile', '--config.confirmModulesPurge=false', '--reporter=append-only') $AppDir

  Say 'Building the app'
  $nextDir = Join-Path $AppDir '.next'
  $prevDir = Join-Path $AppDir '.next.prev'
  if (Test-Path $prevDir) { Remove-Item $prevDir -Recurse -Force }
  if (Test-Path $nextDir) { Move-Item $nextDir $prevDir }
  try {
    Run $Pnpm @('exec', 'next', 'build') $AppDir
    if (Test-Path $prevDir) { Remove-Item $prevDir -Recurse -Force }
  } catch {
    if (Test-Path $prevDir) {
      if (Test-Path $nextDir) { Remove-Item $nextDir -Recurse -Force }
      Move-Item $prevDir $nextDir
      Warn 'The build failed - the previous version is kept.'
    }
    throw
  }
} catch { Die "$_" }

# ---------------------------------------------------------------- master agent (Python)
try {
  if (-not (Test-Path (Join-Path $VenvDir 'Scripts\python.exe'))) {
    Say 'Setting up Python for the master agent'
    Run $BasePython @('-m', 'venv', $VenvDir)
  }
  $Python = Join-Path $VenvDir 'Scripts\python.exe'
  Run $Python @('-m', 'pip', 'install', '--quiet', '--upgrade', 'pip')
  Run $Python @('-m', 'pip', 'install', '--quiet', 'websockets>=12.0', 'pyserial>=3.5')
} catch { Die "could not set up Python: $_" }

# Hotspot name + password, kept across updates and reinstalls.
if (-not (Test-Path $NetConf)) {
  $chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'.ToCharArray()
  $psk = -join (1..12 | ForEach-Object { $chars | Get-Random })
  $mac = (Get-NetAdapter -Physical -ErrorAction SilentlyContinue | Where-Object { $_.NdisPhysicalMedium -eq 9 } | Select-Object -First 1).MacAddress
  $ssid = if ($mac) { 'PAX-Setup-' + (($mac -replace '[-:]', '').Substring(8, 4)).ToUpper() } else { 'PAX-Setup' }
  @"
[pax]
role = master
mode = auto
ap_ssid = $ssid
ap_psk = $psk
iface = wifi
master_host = localhost
router_ssid =
"@ | Set-Content -Path $NetConf -Encoding ascii
  & icacls.exe $NetConf /inheritance:r /grant:r 'SYSTEM:F' '*S-1-5-32-544:F' | Out-Null
}
$netIni = Get-Content $NetConf
$ApSsid = (($netIni | Where-Object { $_ -match '^ap_ssid\s*=' }) -split '=', 2)[1].Trim()
$ApPsk = (($netIni | Where-Object { $_ -match '^ap_psk\s*=' }) -split '=', 2)[1].Trim()

# Windows turns Mobile Hotspot off after 5 min without clients; slaves may be away longer.
$icsKey = 'HKLM:\SYSTEM\CurrentControlSet\Services\icssvc\Settings'
New-Item -Path $icsKey -Force | Out-Null
New-ItemProperty -Path $icsKey -Name 'PeerlessTimeoutEnabled' -Value 0 -PropertyType DWord -Force | Out-Null

# ---------------------------------------------------------------- settings file
[pscustomobject]@{
  appDir      = $AppDir
  installDir  = $InstallDir
  dataDir     = $DataDir
  appPort     = $Port
  agentPort   = $AgentPort
  networkMode = $NetworkMode
  branch      = $Branch
  repo        = $Repo
  node        = $Node
  python      = $Python
  installed   = (Get-Date -Format s)
} | ConvertTo-Json | Set-Content -Path $StateFile -Encoding ascii

# ---------------------------------------------------------------- firewall
Say 'Opening the firewall for PAX'
Get-NetFirewallRule -Group 'PAX' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName "PAX web app (TCP $Port)" -Group 'PAX' -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow -Profile Any | Out-Null
New-NetFirewallRule -DisplayName "PAX slave sign-in (TCP $AgentPort)" -Group 'PAX' -Direction Inbound -Protocol TCP -LocalPort $AgentPort -Action Allow -Profile Any | Out-Null
New-NetFirewallRule -DisplayName 'PAX name lookup (mDNS, UDP 5353)' -Group 'PAX' -Direction Inbound -Protocol UDP -LocalPort 5353 -Action Allow -Profile Any | Out-Null

# ---------------------------------------------------------------- PC name
$renamed = $false
if (-not $isUpdate -and $env:COMPUTERNAME -ne 'PAX-MASTER') {
  Write-Host ''
  Write-Host "This PC is called $env:COMPUTERNAME. Slaves look for the master as pax-master.local."
  if (Ask-YesNo 'Rename this PC to pax-master? (takes effect after a restart)' (-not $Yes)) {
    try { Rename-Computer -NewName 'pax-master' -Force -WarningAction SilentlyContinue; $renamed = $true }
    catch { Warn "Could not rename the PC: $_" }
  }
}
$MasterName = if ($renamed -or $env:COMPUTERNAME -eq 'PAX-MASTER') { 'pax-master' } else { $env:COMPUTERNAME.ToLower() }

# ---------------------------------------------------------------- background tasks
Say 'Installing the background services (start with Windows)'
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
$trigger = New-ScheduledTaskTrigger -AtStartup
foreach ($pair in @(@('PAX App', 'run-app.ps1'), @('PAX Agent', 'run-agent.ps1'))) {
  $script = Join-Path $AppDir "windows\$($pair[1])"
  $action = New-ScheduledTaskAction -Execute $ps -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`""
  Register-ScheduledTask -TaskName $pair[0] -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
  Start-ScheduledTask -TaskName $pair[0]
}

# ---------------------------------------------------------------- Start menu + Apps list
$menu = Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\PAX'
New-Item -ItemType Directory -Force -Path $menu | Out-Null
$urlPort = if ($Port -eq 80) { '' } else { ":$Port" }
$urlShortcut = "[InternetShortcut]`r`nURL=http://localhost$urlPort/`r`n"
$urlShortcut | Set-Content -Path (Join-Path $menu 'Open PAX.url') -Encoding ascii
# Public desktop = visible on the desktop of every user on this PC.
$publicDesktop = [Environment]::GetFolderPath('CommonDesktopDirectory')
if ($publicDesktop) { $urlShortcut | Set-Content -Path (Join-Path $publicDesktop 'PAX.url') -Encoding ascii }
$wsh = New-Object -ComObject WScript.Shell
foreach ($pair in @(@('Update PAX', 'Install-PAX.cmd'), @('Uninstall PAX', 'Uninstall-PAX.cmd'))) {
  $lnk = $wsh.CreateShortcut((Join-Path $menu "$($pair[0]).lnk"))
  $lnk.TargetPath = Join-Path $AppDir "windows\$($pair[1])"
  $lnk.WorkingDirectory = Join-Path $AppDir 'windows'
  $lnk.Save()
}
$uninstKey = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\PAX'
New-Item -Path $uninstKey -Force | Out-Null
$version = try { (& git -C $AppDir rev-parse --short HEAD 2>$null) } catch { 'latest' }
foreach ($kv in @(
    @('DisplayName', 'PAX Paternoster (master)'),
    @('DisplayVersion', "$version"),
    @('Publisher', 'PAX'),
    @('InstallLocation', $InstallDir),
    @('UninstallString', "`"$(Join-Path $AppDir 'windows\Uninstall-PAX.cmd')`""))) {
  New-ItemProperty -Path $uninstKey -Name $kv[0] -Value $kv[1] -PropertyType String -Force | Out-Null
}
New-ItemProperty -Path $uninstKey -Name 'NoModify' -Value 1 -PropertyType DWord -Force | Out-Null
New-ItemProperty -Path $uninstKey -Name 'NoRepair' -Value 1 -PropertyType DWord -Force | Out-Null

# ---------------------------------------------------------------- wait for the app
Say 'Waiting for the app to start'
$up = $false
for ($i = 0; $i -lt 40; $i++) {
  try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 "http://localhost:$Port/" | Out-Null; $up = $true; break } catch { Start-Sleep -Seconds 3 }
}

$ip = (Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway } | Select-Object -First 1).IPv4Address.IPAddress
Write-Host ''
if ($up) { Write-Host 'PAX is installed and running.' -ForegroundColor Green }
else { Warn "The app did not answer yet. See $LogDir\app.log" }
Write-Host ''
Write-Host "  Open the app:   http://$MasterName.local$urlPort   or   http://$ip$urlPort"
Write-Host "  Network mode:   $NetworkMode (cable = through the router, wifi = hotspot fallback)"
Write-Host "  Hotspot:        $ApSsid   password: $ApPsk   (only used in wifi mode; app then at http://192.168.137.1$urlPort)"
Write-Host "  Your data:      $DataDir"
Write-Host "  Logs:           $LogDir"
Write-Host ''
Write-Host '  Install each carousel Pi as a SLAVE pointing at this PC:'
Write-Host "    sudo ./setup.sh --role slave --master $MasterName.local --ap-ssid $ApSsid --ap-psk $ApPsk ..."
Write-Host ''
Write-Host '  Update:     run Install-PAX.cmd again (Start menu > PAX > Update PAX)'
Write-Host '  Uninstall:  Start menu > PAX > Uninstall PAX, or Settings > Apps > PAX'
if ($renamed) { Write-Host ''; Warn 'Restart the PC so the new name pax-master takes effect.' }
Write-Host ''
if (-not $Yes) { Read-Host 'Press Enter to close' | Out-Null }
