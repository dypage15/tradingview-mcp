@echo off
title Attach MNQ Level Advisor
cd /d "%~dp0"
echo.
echo 1) Log into NinjaTrader if the Welcome screen is showing
echo 2) Leave an MNQ chart open
echo 3) This script will enable MNQLevelAdvisorLoader (adds MNQLevelAdvisor on chart)
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\nt-attach-mnq-level-advisor.ps1"
echo.
type "%~dp0data\nt-mnq-attach-final.log" 2>nul
pause
