@echo off
REM Double-click: opens only the advisor dashboard (expects TradingView + CDP already).
REM For TV launch + CDP + warm data + dashboard, use Launch-Everything.cmd instead.
REM Requires: Node.js on PATH, TradingView Desktop with CDP (port 9222).

title Quant Advisor Dashboard
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js was not found. Install it from https://nodejs.org and try again.
  pause
  exit /b 1
)

echo.
echo  Starting advisor dashboard...
echo  Browser opens automatically. Close this window to stop the server.
echo.

node scripts\advisor-ui.mjs
set EXIT=%ERRORLEVEL%
if %EXIT% neq 0 (
  echo.
  echo Server exited with error %EXIT%.
  pause
)
exit /b %EXIT%
