@echo off
REM Creates a DISABLED scheduled task that runs launch_tv_debug.bat at Windows sign-in.
REM Right-click this file -> Run as administrator, then enable the task in Task Scheduler if you want auto-start.

set "TASK=TradingViewMCPDebug"
set "BAT=C:\Users\dypag\tradingview-mcp\scripts\launch_tv_debug.bat"

schtasks /Create /F /TN "%TASK%" /TR "cmd /c %BAT%" /SC ONLOGON /RL LIMITED
if errorlevel 1 (
    echo.
    echo Failed to create task. Try running this file as Administrator.
    pause
    exit /b 1
)

schtasks /Change /TN "%TASK%" /DISABLE
echo.
echo Task "%TASK%" was created and left DISABLED.
echo To start TradingView with MCP debug automatically at sign-in:
echo   1. Open Task Scheduler ^(taskschd.msc^)
echo   2. Find task "%TASK%"
echo   3. Right-click -^> Enable
echo.
pause
