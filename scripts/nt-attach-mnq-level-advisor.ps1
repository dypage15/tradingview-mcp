# After NinjaTrader is logged in: compile-check + attach MNQLevelAdvisor via loader strategy.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\nt-attach-mnq-level-advisor.ps1
$ErrorActionPreference = 'Continue'
$log = 'c:\Users\dypag\tradingview-mcp\data\nt-mnq-attach-final.log'
$lines = @("started=$(Get-Date -Format o)")
$strategy = 'MNQLevelAdvisorLoader'
$indicator = 'MNQLevelAdvisor'

Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public class NtMnqAttach {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int c);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint a, uint b, uint c, UIntPtr d);
  [DllImport("user32.dll")] public static extern bool AllowSetForegroundWindow(int procId);
  public struct RECT { public int L,T,R,B; }
  public struct POINT { public int X,Y; }
  public static IntPtr FindChart(int procId) {
    IntPtr f = IntPtr.Zero;
    EnumWindows((h,l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p != (uint)procId || !IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512); GetWindowText(h, sb, sb.Capacity);
      if (sb.ToString().StartsWith("Chart")) { f = h; return false; }
      return true;
    }, IntPtr.Zero);
    return f;
  }
  public static void Focus(IntPtr h) {
    AllowSetForegroundWindow(-1);
    ShowWindow(h, 9); BringWindowToTop(h); SetForegroundWindow(h);
  }
  public static void Click(int x, int y) {
    SetCursorPos(x, y); System.Threading.Thread.Sleep(40);
    mouse_event(2,0,0,0,UIntPtr.Zero); mouse_event(4,0,0,0,UIntPtr.Zero);
  }
  public static void RClick(int x, int y) {
    SetCursorPos(x, y); System.Threading.Thread.Sleep(50);
    mouse_event(8,0,0,0,UIntPtr.Zero); mouse_event(16,0,0,0,UIntPtr.Zero);
  }
}
"@
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

function Find-InProc([int]$procId, [string]$nameExact) {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  foreach ($el in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
    try {
      if ($el.Current.ProcessId -ne $procId) { continue }
      if ($el.Current.Name -eq $nameExact) { return $el }
    } catch {}
  }
  return $null
}

$nt = Get-Process NinjaTrader -EA SilentlyContinue | Select-Object -First 1
if (-not $nt) { $lines += 'error=nt_not_running'; $lines | Set-Content $log; Get-Content $log; exit 1 }
if ($nt.MainWindowTitle -notmatch 'Control Center|Chart|NinjaScript|SuperDOM|Strategy') {
  $lines += "error=not_logged_in title=$($nt.MainWindowTitle)"
  $lines | Set-Content $log; Get-Content $log; exit 2
}

$procId = $nt.Id
$dll = "$env:USERPROFILE\Documents\NinjaTrader 8\bin\Custom\NinjaTrader.Custom.dll"
$lines += "dll_has_adv=$((Select-String -Path $dll -Pattern 'MNQLevelAdvisor' -SimpleMatch -Quiet))"
$lines += "dll_has_loader=$((Select-String -Path $dll -Pattern 'MNQLevelAdvisorLoader' -SimpleMatch -Quiet))"

# Kill focus stealers lightly
Get-Process XboxPcApp,XboxPcTray,GameBar -EA SilentlyContinue | Stop-Process -Force -EA SilentlyContinue

$chart = [NtMnqAttach]::FindChart($procId)
if ($chart -eq [IntPtr]::Zero) {
  $lines += 'no_chart_yet_opening'
  # Prefer Control Center New > Chart; fall back to Ctrl+N after focusing main window
  $cc = $null
  $rootEl = [System.Windows.Automation.AutomationElement]::RootElement
  foreach ($el in $rootEl.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
    try {
      if ($el.Current.ProcessId -eq $procId -and $el.Current.Name -match 'Control Center') { $cc = $el; break }
    } catch {}
  }
  if ($cc) {
    [NtMnqAttach]::Focus([IntPtr]$cc.Current.NativeWindowHandle)
    Start-Sleep -Milliseconds 400
    $shell = New-Object -ComObject WScript.Shell
    # Alt+N then C is common NT accelerator for New > Chart; Ctrl+N also opens New Chart in many builds
    $shell.SendKeys('%n')
    Start-Sleep -Milliseconds 600
    $shell.SendKeys('c')
    Start-Sleep -Seconds 2
    $newChart = Find-InProc $procId 'New Chart'
    if (-not $newChart) { $newChart = Find-InProc $procId 'Chart' }
    if ($newChart -and $newChart.Current.ControlType -eq [System.Windows.Automation.ControlType]::Window) {
      $lines += 'new_chart_dialog'
      $shell.SendKeys('MNQ')
      Start-Sleep -Milliseconds 800
      $shell.SendKeys('{ENTER}')
      Start-Sleep -Seconds 3
      $ok = Find-InProc $procId 'OK'
      if ($ok) {
        try { $ok.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); $lines += 'new_chart_ok' }
        catch { $shell.SendKeys('{ENTER}'); $lines += 'new_chart_enter' }
      } else {
        $shell.SendKeys('{ENTER}'); $lines += 'new_chart_enter2'
      }
      Start-Sleep -Seconds 4
    } else {
      $shell.SendKeys('^n')
      Start-Sleep -Seconds 3
      $shell.SendKeys('MNQ')
      Start-Sleep -Milliseconds 800
      $shell.SendKeys('{ENTER}')
      Start-Sleep -Seconds 2
      $shell.SendKeys('{ENTER}')
      Start-Sleep -Seconds 4
      $lines += 'ctrl_n_chart_attempt'
    }
  }
  $chart = [NtMnqAttach]::FindChart($procId)
}
if ($chart -eq [IntPtr]::Zero) {
  $lines += 'error=no_chart_open_mnq_chart_first'
  $lines | Set-Content $log; Get-Content $log; exit 3
}
$lines += "chart=$chart"

[NtMnqAttach]::Focus($chart)
Start-Sleep -Milliseconds 500
$cr = New-Object NtMnqAttach+RECT
[NtMnqAttach]::GetClientRect($chart, [ref]$cr) | Out-Null
$pt = New-Object NtMnqAttach+POINT
$pt.X = [int]($cr.R / 2); $pt.Y = [int]($cr.B * 0.55)
[NtMnqAttach]::ClientToScreen($chart, [ref]$pt) | Out-Null
[NtMnqAttach]::Click($pt.X, $pt.Y)
Start-Sleep -Milliseconds 400
[NtMnqAttach]::Focus($chart)
[NtMnqAttach]::RClick($pt.X, $pt.Y)
$lines += "rclick $($pt.X),$($pt.Y)"
Start-Sleep -Seconds 2

$stratMenu = Find-InProc $procId 'Strategies...'
if (-not $stratMenu) { $stratMenu = Find-InProc $procId 'Strategies' }
if ($stratMenu) {
  try {
    $stratMenu.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    $lines += 'invoked_strategies'
  } catch {
    $lines += "strat_invoke_fail=$($_.Exception.Message)"
  }
  Start-Sleep -Seconds 2
} else {
  $lines += 'no_strategies_menu'
}

$item = Find-InProc $procId $strategy
if (-not $item) { $item = Find-InProc $procId 'MNQLevelAdvisor' }
if ($item) {
  $lines += "found=$($item.Current.Name) type=$($item.Current.ControlType.ProgrammaticName)"
  try {
    $item.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    $lines += 'invoked_item'
  } catch {
    $br = $item.Current.BoundingRectangle
    if ($br.Width -gt 0 -and -not [double]::IsInfinity($br.X)) {
      [NtMnqAttach]::Click([int]($br.X + $br.Width/2), [int]($br.Y + $br.Height/2))
      $lines += 'clicked_item'
    } else { $lines += "item_fail=$($_.Exception.Message)" }
  }
  Start-Sleep -Seconds 3
  $ok = Find-InProc $procId 'OK'
  if ($ok) {
    try { $ok.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); $lines += 'ok' }
    catch {
      $shell = New-Object -ComObject WScript.Shell
      $shell.SendKeys('{ENTER}'); $lines += 'ok_enter'
    }
  } else {
    $shell = New-Object -ComObject WScript.Shell
    $shell.SendKeys('{ENTER}'); $lines += 'enter_fallback'
  }
} else {
  $lines += 'strategy_not_found_in_menu'
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  foreach ($el in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
    try {
      if ($el.Current.ProcessId -ne $procId) { continue }
      $n = $el.Current.Name
      if ($n -and ($n -like '*MNQ*' -or $n -like '*Level*')) { $lines += "seen=$n" }
    } catch {}
  }
}

Start-Sleep -Seconds 2
# Verify via Indicators dialog Configured list if possible
[NtMnqAttach]::Focus($chart)
[NtMnqAttach]::Click($pt.X, $pt.Y)
Start-Sleep -Milliseconds 300
Add-Type @"
using System; using System.Runtime.InteropServices;
public class NtKeysMnq { [DllImport("user32.dll")] public static extern void keybd_event(byte v, byte s, uint f, UIntPtr e);
  public static void CtrlI(){ keybd_event(0x11,0,0,UIntPtr.Zero); keybd_event(0x49,0,0,UIntPtr.Zero); keybd_event(0x49,0,2,UIntPtr.Zero); keybd_event(0x11,0,2,UIntPtr.Zero); }
  public static void AltO(){ keybd_event(0x12,0,0,UIntPtr.Zero); keybd_event(0x4F,0,0,UIntPtr.Zero); keybd_event(0x4F,0,2,UIntPtr.Zero); keybd_event(0x12,0,2,UIntPtr.Zero); }
}
"@
[NtKeysMnq]::CtrlI()
Start-Sleep -Seconds 3
$indWin = Find-InProc $procId 'Indicators'
$configured = $false
if ($indWin -and $indWin.Current.ControlType -eq [System.Windows.Automation.ControlType]::Window) {
  foreach ($el in $indWin.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) {
    try {
      if ($el.Current.Name -ne $indicator) { continue }
      $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
      $p = $el
      for ($i = 0; $i -lt 12; $i++) {
        $p = $walker.GetParent($p)
        if (-not $p) { break }
        if ($p.Current.Name -eq 'Configured') { $configured = $true }
      }
    } catch {}
  }
  [NtMnqAttach]::SetForegroundWindow($indWin.Current.NativeWindowHandle) | Out-Null
  [NtKeysMnq]::AltO()
}
$lines += "indicator_configured=$configured"
$lines += "finished=$(Get-Date -Format o)"
$lines | Set-Content $log
Get-Content $log
