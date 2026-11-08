# PAX Windows network helper. Called by paxnet_win.py; prints ONE line of JSON.
#
#   win_net.ps1 status          adapters (cable / Wi-Fi), gateway, hotspot state
#   win_net.ps1 hotspot-config  set hotspot name/password from $env:PAX_AP_SSID / $env:PAX_AP_PSK
#   win_net.ps1 hotspot-up      start Windows Mobile Hotspot
#   win_net.ps1 hotspot-down    stop it
#
# Must run under Windows PowerShell 5.1 (powershell.exe): PowerShell 7 dropped
# the WinRT projection the Mobile Hotspot API needs. Keep this file ASCII-only;
# 5.1 reads BOM-less scripts in the ANSI code page.
param([string]$Action = 'status')
$ErrorActionPreference = 'Stop'

function Out-Json($obj) { $obj | ConvertTo-Json -Compress -Depth 5 }

$script:winrt = $false
function Init-WinRT {
  if ($script:winrt) { return }
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Networking.Connectivity.NetworkInformation, Windows.Networking.Connectivity, ContentType = WindowsRuntime]
  $null = [Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager, Windows.Networking.NetworkOperators, ContentType = WindowsRuntime]
  $script:asTaskOp = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  } | Select-Object -First 1
  $script:asTaskAction = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction'
  } | Select-Object -First 1
  $script:winrt = $true
}

function Await($op, [Type]$type) {
  $task = $script:asTaskOp.MakeGenericMethod($type).Invoke($null, @($op))
  $null = $task.Wait(60000)
  $task.Result
}

function AwaitAction($op) {
  $task = $script:asTaskAction.Invoke($null, @($op))
  $null = $task.Wait(60000)
}

# Windows only creates a tethering manager from a connection profile. With the
# router gone there is no internet profile, so try every profile Windows knows
# (saved Wi-Fi, Ethernet, loopback) until one is accepted.
function Get-TetheringManagers {
  Init-WinRT
  $ni = [Windows.Networking.Connectivity.NetworkInformation]
  $profiles = @()
  $inet = $ni::GetInternetConnectionProfile()
  if ($inet) { $profiles += $inet }
  $profiles += @($ni::GetConnectionProfiles())
  $seen = @{}
  foreach ($p in $profiles) {
    if (-not $p) { continue }
    $key = "$($p.ProfileName)|$($p.NetworkAdapter.NetworkAdapterId)"
    if ($seen.ContainsKey($key)) { continue }
    $seen[$key] = $true
    try {
      $m = [Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager]::CreateFromConnectionProfile($p)
      if ($m) { [pscustomobject]@{ Manager = $m; Profile = $p.ProfileName } }
    } catch { }
  }
}

function Get-HotspotState {
  try {
    $m = Get-TetheringManagers | Select-Object -First 1
    if (-not $m) { return @{ state = 'Unavailable'; clients = 0; error = 'no network profile Windows can share a hotspot from' } }
    return @{ state = "$($m.Manager.TetheringOperationalState)"; clients = [int]$m.Manager.ClientCount }
  } catch {
    return @{ state = 'Unavailable'; clients = 0; error = "$($_.Exception.Message)" }
  }
}

function Get-AdapterInfo($adapter) {
  if (-not $adapter) { return $null }
  $ip = $null; $gw = $null; $ssid = $null
  if ($adapter.Status -eq 'Up') {
    try {
      $cfg = Get-NetIPConfiguration -InterfaceIndex $adapter.ifIndex -ErrorAction Stop
      $ip = ($cfg.IPv4Address | Select-Object -First 1).IPAddress
      $gw = ($cfg.IPv4DefaultGateway | Select-Object -First 1).NextHop
    } catch { }
    try { $ssid = (Get-NetConnectionProfile -InterfaceIndex $adapter.ifIndex -ErrorAction Stop | Select-Object -First 1).Name } catch { }
  }
  @{ name = $adapter.Name; up = ($adapter.Status -eq 'Up'); ip = $ip; gateway = $gw; network = $ssid; mac = $adapter.MacAddress }
}

function Get-Status {
  $physical = @(Get-NetAdapter -Physical -ErrorAction SilentlyContinue)
  # NdisPhysicalMedium 14 = 802.3 (cable), 9 = Native 802.11 (Wi-Fi).
  $eth = $physical | Where-Object { $_.NdisPhysicalMedium -eq 14 } | Sort-Object { $_.Status -ne 'Up' } | Select-Object -First 1
  $wifi = $physical | Where-Object { $_.NdisPhysicalMedium -eq 9 } | Sort-Object { $_.Status -ne 'Up' } | Select-Object -First 1
  $e = Get-AdapterInfo $eth
  $w = Get-AdapterInfo $wifi
  $link = 'none'
  if ($e -and $e.up -and $e.gateway) { $link = 'cable' }
  elseif ($w) { $link = 'wifi' }
  @{ ok = $true; link = $link; ethernet = $e; wifi = $w; hotspot = (Get-HotspotState) }
}

function Set-HotspotConfig {
  $ssid = $env:PAX_AP_SSID; $psk = $env:PAX_AP_PSK
  if (-not $ssid -or -not $psk) { throw 'PAX_AP_SSID / PAX_AP_PSK not set' }
  $done = $false; $lastErr = 'no network profile Windows can share a hotspot from'
  foreach ($m in Get-TetheringManagers) {
    try {
      $cfg = $m.Manager.GetCurrentAccessPointConfiguration()
      $cfg.Ssid = $ssid
      $cfg.Passphrase = $psk
      # Pi Zero 2 W slaves only have 2.4 GHz radios. Older builds lack Band.
      try { $cfg.Band = [Windows.Networking.NetworkOperators.TetheringWiFiBand]::TwoPointFourGigahertz } catch { }
      AwaitAction ($m.Manager.ConfigureAccessPointAsync($cfg))
      $done = $true
    } catch { $lastErr = "$($_.Exception.Message)" }
  }
  if (-not $done) { throw $lastErr }
  @{ ok = $true }
}

function Start-Hotspot {
  Set-HotspotConfig | Out-Null
  $lastErr = 'no network profile Windows can share a hotspot from'
  foreach ($m in Get-TetheringManagers) {
    if ("$($m.Manager.TetheringOperationalState)" -eq 'On') { return @{ ok = $true; state = 'On'; profile = $m.Profile } }
    try {
      $r = Await ($m.Manager.StartTetheringAsync()) ([Windows.Networking.NetworkOperators.NetworkOperatorTetheringOperationResult])
      if ("$($r.Status)" -eq 'Success') { return @{ ok = $true; state = 'On'; profile = $m.Profile } }
      $lastErr = "$($r.Status) $($r.AdditionalErrorMessage)".Trim()
    } catch { $lastErr = "$($_.Exception.Message)" }
  }
  @{ ok = $false; error = "Windows refused to start Mobile Hotspot: $lastErr" }
}

function Stop-Hotspot {
  foreach ($m in Get-TetheringManagers) {
    if ("$($m.Manager.TetheringOperationalState)" -ne 'Off') {
      try { $null = Await ($m.Manager.StopTetheringAsync()) ([Windows.Networking.NetworkOperators.NetworkOperatorTetheringOperationResult]) } catch { }
    }
  }
  @{ ok = $true }
}

try {
  switch ($Action) {
    'status'         { Out-Json (Get-Status) }
    'hotspot-config' { Out-Json (Set-HotspotConfig) }
    'hotspot-up'     { Out-Json (Start-Hotspot) }
    'hotspot-down'   { Out-Json (Stop-Hotspot) }
    default          { Out-Json @{ ok = $false; error = "unknown action $Action" } }
  }
} catch {
  Out-Json @{ ok = $false; error = "$($_.Exception.Message)" }
}
