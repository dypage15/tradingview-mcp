#Requires -Version 5.1
<#
One-shot: locate TradingView.exe, persist TRADINGVIEW_EXECUTABLE for current user if found,
ensure TRADINGVIEW_CDP_HOST/TRADINGVIEW_CDP_PORT on process, invoke `node ... launch`.

Run from repo root (or set TRADINGVIEW_MCP_REPO):
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\_ensure_tradingview_cdp.ps1
#>
$ErrorActionPreference = 'Stop'
$Repo = $env:TRADINGVIEW_MCP_REPO
if (-not $Repo -or -not (Test-Path -LiteralPath $Repo)) {
  $Repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
}

function Find-TvExe {
  $checks = @(
    $env:TRADINGVIEW_EXECUTABLE,
    "$env:LOCALAPPDATA\TradingView\TradingView.exe",
    "$env:LOCALAPPDATA\Microsoft\WindowsApps\TradingView.exe",
    "$env:LOCALAPPDATA\Programs\TradingView\TradingView.exe",
    "$env:LOCALAPPDATA\Programs\TradingView Desktop\TradingView.exe",
    "$env:ProgramFiles\TradingView\TradingView.exe",
    "${env:ProgramFiles(x86)}\TradingView\TradingView.exe"
  )
  foreach ($p in $checks) {
    if ($p -and (Test-Path -LiteralPath $p)) { return $p }
  }
  $lp = Join-Path $env:LOCALAPPDATA 'Programs'
  if (Test-Path -LiteralPath $lp) {
    $hit = Get-ChildItem -LiteralPath $lp -Recurse -Filter TradingView.exe -Depth 9 -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($hit) { return $hit.FullName }
  }
  $pf = $env:ProgramFiles
  if ($pf) {
    $wa = Join-Path $pf 'WindowsApps'
    if (Test-Path -LiteralPath $wa) {
      $dir = Get-ChildItem -LiteralPath $wa -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like '*TradingView*' } | Select-Object -First 1
      if ($dir) {
        $e = Join-Path $dir.FullName 'TradingView.exe'
        if (Test-Path -LiteralPath $e) { return $e }
      }
    }
  }
  $pkg = Get-AppxPackage -ErrorAction SilentlyContinue | Where-Object { $_.Name -like '*TradingView*' } | Select-Object -First 1
  if ($pkg -and $pkg.InstallLocation) {
    $root = $pkg.InstallLocation
    $direct = Join-Path $root 'TradingView.exe'
    if (Test-Path -LiteralPath $direct) { return $direct }
    $hit2 = Get-ChildItem -LiteralPath $root -Recurse -Filter TradingView.exe -Depth 6 -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($hit2) { return $hit2.FullName }
  }
  return $null
}

if (-not (Test-Path (Join-Path $Repo 'src\cli\index.js'))) {
  Write-Error "Repo not found: $Repo"
  exit 3
}

$tv = Find-TvExe
if (-not $tv) {
  Write-Host 'could_not_find_TradingView.exe — install TradingView Desktop or set TRADINGVIEW_EXECUTABLE to the full exe path.'
  exit 2
}

Write-Host "Using TradingView: $tv"
$userCur = [Environment]::GetEnvironmentVariable('TRADINGVIEW_EXECUTABLE', 'User')
if ($userCur -ne $tv) {
  [Environment]::SetEnvironmentVariable('TRADINGVIEW_EXECUTABLE', $tv, 'User')
  Write-Host 'Stored TRADINGVIEW_EXECUTABLE in User environment (new terminals / apps will inherit).'
}

$env:TRADINGVIEW_EXECUTABLE = $tv
if (-not $env:TRADINGVIEW_CDP_HOST) { $env:TRADINGVIEW_CDP_HOST = '127.0.0.1' }
if (-not $env:TRADINGVIEW_CDP_PORT) { $env:TRADINGVIEW_CDP_PORT = '9222' }

Push-Location $Repo
try {
  & node src/cli/index.js launch
} finally {
  Pop-Location
}
