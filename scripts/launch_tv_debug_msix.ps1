#Requires -Version 5.1
<#
.SYNOPSIS
  Launch TradingView Desktop with --remote-debugging-port (CDP) on Windows.
  Order: env TRADINGVIEW_EXECUTABLE -> classic paths -> Programs -> WindowsApps ->
         AppX InstallLocation (recursive) -> COM/IApplicationActivationManager (last resort).

.PARAMETER Port
  Chrome DevTools port (default 9222).

.PARAMETER NoKill
  Do not taskkill existing TradingView.exe first before the first launch attempt.
#>
param(
  [int]$Port = 9222,
  [switch]$NoKill
)

$ErrorActionPreference = 'Stop'
$argLine = "--remote-debugging-port=$Port"

function Test-CdpReady {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/json/version" -UseBasicParsing -TimeoutSec 2
    return $r.StatusCode -eq 200
  } catch {
    return $false
  }
}

function Wait-Cdp {
  param([int]$MaxSeconds = 90)
  $deadline = (Get-Date).AddSeconds($MaxSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-CdpReady) { return $true }
    Start-Sleep -Seconds 1
  }
  return $false
}

function Stop-TradingViewBestEffort {
  try { Stop-Process -Name 'TradingView' -Force -ErrorAction SilentlyContinue } catch {}
  Start-Sleep -Seconds 2
}

function Try-LaunchExe {
  param(
    [Parameter(Mandatory)][string]$ExePath,
    [string]$Label = 'exe'
  )
  if (-not (Test-Path -LiteralPath $ExePath)) { return $false }
  Write-Host "Starting ($Label): $ExePath"
  try {
    Start-Process -FilePath $ExePath -ArgumentList $argLine -ErrorAction Stop
  } catch {
    Write-Host "Start-Process failed for $ExePath : $($_.Exception.Message)"
    return $false
  }
  if (Wait-Cdp) {
    Write-Host "CDP ready at http://127.0.0.1:$Port/"
    exit 0
  }
  Write-Host "Process started but CDP did not respond on port $Port (may be a second instance without debug args)."
  return $false
}

if (-not $NoKill) {
  Stop-TradingViewBestEffort
}

# --- 0) Explicit override (set in User env or session) ---
if ($env:TRADINGVIEW_EXECUTABLE -and (Test-Path -LiteralPath $env:TRADINGVIEW_EXECUTABLE)) {
  $null = Try-LaunchExe -ExePath $env:TRADINGVIEW_EXECUTABLE -Label 'TRADINGVIEW_EXECUTABLE'
  Write-Host 'TRADINGVIEW_EXECUTABLE did not bring up CDP; continuing with automatic discovery...'
  Stop-TradingViewBestEffort
}

# --- 1) Classic installers ---
$classic = @(
  "$env:LOCALAPPDATA\TradingView\TradingView.exe",
  "$env:LOCALAPPDATA\Microsoft\WindowsApps\TradingView.exe",
  "$env:LOCALAPPDATA\Programs\TradingView\TradingView.exe",
  "$env:LOCALAPPDATA\Programs\TradingView Desktop\TradingView.exe",
  "$env:ProgramFiles\TradingView\TradingView.exe",
  "${env:ProgramFiles(x86)}\TradingView\TradingView.exe"
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1

if ($classic) {
  $null = Try-LaunchExe -ExePath $classic -Label 'classic'
  Stop-TradingViewBestEffort
}

# --- 2) Per-user Programs (winget / some installers) ---
$lp = Join-Path $env:LOCALAPPDATA 'Programs'
if (Test-Path -LiteralPath $lp) {
  $hit = Get-ChildItem -LiteralPath $lp -Recurse -Filter TradingView.exe -Depth 8 -ErrorAction SilentlyContinue |
    Select-Object -First 1 -ExpandProperty FullName
  if ($hit) {
    $null = Try-LaunchExe -ExePath $hit -Label 'Programs'
    Stop-TradingViewBestEffort
  }
}

# --- 3) WindowsApps staged packages ---
$pf = ${env:ProgramFiles}
if ($pf) {
  $wa = Join-Path $pf 'WindowsApps'
  if (Test-Path -LiteralPath $wa) {
    Get-ChildItem -LiteralPath $wa -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -like '*TradingView*' } |
      ForEach-Object {
        $appxExe = Join-Path $_.FullName 'TradingView.exe'
        if (Test-Path -LiteralPath $appxExe) {
          $null = Try-LaunchExe -ExePath $appxExe -Label 'WindowsApps'
          Stop-TradingViewBestEffort
        }
      }
  }
}

# --- 4) AppX manifest: exe under InstallLocation (root or shallow subtree) ---
$script:pkg = Get-AppxPackage -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -like '*TradingView*' } |
  Select-Object -First 1

if ($script:pkg -and $script:pkg.InstallLocation) {
  $root = $script:pkg.InstallLocation
  $candidates = @()
  $direct = Join-Path $root 'TradingView.exe'
  if (Test-Path -LiteralPath $direct) { $candidates += $direct }
  try {
    $more = @(Get-ChildItem -LiteralPath $root -Recurse -Filter TradingView.exe -Depth 5 -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty FullName | Select-Object -First 5)
    $candidates += $more
  } catch {}
  foreach ($exe in ($candidates | Select-Object -Unique)) {
    if (-not $exe) { continue }
    $null = Try-LaunchExe -ExePath $exe -Label 'AppX'
    Stop-TradingViewBestEffort
  }
}

# --- 5) COM activation (fails on some Windows SKUs: REGDB_E_CLASSNOTREG) ---
function Get-TradingViewAumid {
  if (Get-Command Get-StartApps -ErrorAction SilentlyContinue) {
    try {
      $row = Get-StartApps | Where-Object { $_.Name -like '*TradingView*' } | Select-Object -First 1
      if ($row -and $row.AppID) { return [string]$row.AppID }
    } catch {}
  }

  if (-not $script:pkg) {
    $script:pkg = Get-AppxPackage -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -like '*TradingView*' } |
      Select-Object -First 1
  }
  if (-not $script:pkg) { return $null }

  try {
    $man = Get-AppxPackageManifest $script:pkg
    $xml = [xml]$man.Xml
    $app = $xml.Package.Applications.Application
    if ($app -is [System.Array]) {
      $app = $app | Where-Object { $_.Id -match 'TradingView|Desktop|App' } | Select-Object -First 1
      if (-not $app) { $app = $xml.Package.Applications.Application[0] }
    }
    $id = $app.Id
    if (-not $id) { return $null }
    return "$($script:pkg.PackageFamilyName)!$id"
  } catch {
    return $null
  }
}

$aumid = Get-TradingViewAumid
if (-not $aumid) {
  Write-Error @"
TradingView executable not found and no AppX AUMID resolved.
Set TRADINGVIEW_EXECUTABLE to the full path of TradingView.exe (with CDP: run this script after setting it), e.g.:
  [Environment]::SetEnvironmentVariable('TRADINGVIEW_EXECUTABLE','C:\\Path\\To\\TradingView.exe','User')
"@
  exit 1
}

Write-Host "Activating MSIX app via COM: $aumid"

Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class TradingViewMsixActivator
{
    [ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IApplicationActivationManager
    {
        [PreserveSig]
        int ActivateApplication(
            [MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
            [MarshalAs(UnmanagedType.LPWStr)] string arguments,
            uint options,
            out uint processId);

        [PreserveSig]
        int ActivateForFile(
            [MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
            IntPtr itemArray,
            [MarshalAs(UnmanagedType.LPWStr)] string verb,
            out uint processId);

        [PreserveSig]
        int ActivateForProtocol(
            [MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
            IntPtr itemArray,
            out uint processId);
    }

    [ComImport, Guid("45BA127D-32A2-49FF-9A21-456E11A705B3"), ClassInterface(ClassInterfaceType.None)]
    private class ApplicationActivationManagerClass { }

    public static void Activate(string aumid, string arguments)
    {
        var obj = new ApplicationActivationManagerClass();
        var mgr = (IApplicationActivationManager)obj;
        uint pid;
        int hr = mgr.ActivateApplication(aumid, arguments, 0, out pid);
        if (hr < 0)
            throw new InvalidOperationException("ActivateApplication HRESULT 0x" + hr.ToString("X8"));
    }
}
'@

try {
  [TradingViewMsixActivator]::Activate($aumid, $argLine)
} catch {
  Write-Error @"
COM launch failed: $($_.Exception.Message)
Workaround: find TradingView.exe (Task Manager -> Open file location), then set permanent env var TRADINGVIEW_EXECUTABLE to that path and re-run this script.
Example (replace path):
  [Environment]::SetEnvironmentVariable('TRADINGVIEW_EXECUTABLE','C:\\full\\path\\TradingView.exe','User')
"@
  exit 1
}

Write-Host 'Waiting for CDP...'
if (-not (Wait-Cdp)) {
  Write-Error 'App activated but CDP did not respond. Confirm this build forwards --remote-debugging-port from activation, or launch TradingView.exe from its folder with --remote-debugging-port in a shortcut/cmdline.'
  exit 1
}

Write-Host "CDP ready at http://127.0.0.1:$Port/"
try {
  (Invoke-WebRequest -Uri "http://127.0.0.1:$Port/json/version" -UseBasicParsing -TimeoutSec 5).Content
} catch {}
exit 0
