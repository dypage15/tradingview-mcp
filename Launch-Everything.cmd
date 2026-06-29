@echo off
REM One click: connect to TradingView (CDP), warm advisor data, open the dashboard browser.
REM Needs Node.js. First run may start TradingView with remote debugging.

title TradingView + Quant Advisor
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js was not found. Install from https://nodejs.org
  pause
  exit /b 1
)

node scripts\launch-stack.mjs
set EXITCODE=%ERRORLEVEL%
if %EXITCODE% neq 0 (
  echo.
  echo Exited with error %EXITCODE%.
  pause
)
exit /b %EXITCODE%
