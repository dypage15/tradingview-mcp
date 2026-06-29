@echo off
REM Launch TradingView Desktop on Windows with Chrome DevTools Protocol enabled
REM Usage: scripts\launch_tv_debug.bat [port]

set PORT=%1
if "%PORT%"=="" set PORT=9222

REM Kill existing TradingView instances
taskkill /F /IM TradingView.exe >nul 2>&1
timeout /t 2 /nobreak >nul

REM Auto-detect TradingView install location (TRADINGVIEW_EXECUTABLE wins if set and exists)
set "TV_EXE="

if defined TRADINGVIEW_EXECUTABLE if exist "%TRADINGVIEW_EXECUTABLE%" set "TV_EXE=%TRADINGVIEW_EXECUTABLE%"

if "%TV_EXE%"=="" if exist "%LOCALAPPDATA%\TradingView\TradingView.exe" set "TV_EXE=%LOCALAPPDATA%\TradingView\TradingView.exe"
if "%TV_EXE%"=="" if exist "%LOCALAPPDATA%\Microsoft\WindowsApps\TradingView.exe" set "TV_EXE=%LOCALAPPDATA%\Microsoft\WindowsApps\TradingView.exe"
if "%TV_EXE%"=="" if exist "%LOCALAPPDATA%\Programs\TradingView\TradingView.exe" set "TV_EXE=%LOCALAPPDATA%\Programs\TradingView\TradingView.exe"
if "%TV_EXE%"=="" if exist "%LOCALAPPDATA%\Programs\TradingView Desktop\TradingView.exe" set "TV_EXE=%LOCALAPPDATA%\Programs\TradingView Desktop\TradingView.exe"
if "%TV_EXE%"=="" if exist "%PROGRAMFILES%\TradingView\TradingView.exe" set "TV_EXE=%PROGRAMFILES%\TradingView\TradingView.exe"
if "%TV_EXE%"=="" if exist "%PROGRAMFILES(x86)%\TradingView\TradingView.exe" set "TV_EXE=%PROGRAMFILES(x86)%\TradingView\TradingView.exe"

REM MSIX staged folder (may require admin visibility on some setups)

if "%TV_EXE%"=="" (
    for /f "tokens=*" %%i in ('dir /s /b "%PROGRAMFILES%\WindowsApps\TradingView*\TradingView.exe" 2^>nul') do set "TV_EXE=%%i"
)
if "%TV_EXE%"=="" (
    for /f "tokens=*" %%i in ('where TradingView.exe 2^>nul') do set "TV_EXE=%%i"
)

if "%TV_EXE%"=="" (
    echo Classic install not found — trying MSIX / Store launcher ^(PowerShell^)...
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0launch_tv_debug_msix.ps1" -Port %PORT%
    exit /b %ERRORLEVEL%
)

echo Found TradingView at: %TV_EXE%
echo Starting with --remote-debugging-port=%PORT%...
start "" "%TV_EXE%" --remote-debugging-port=%PORT%

echo Waiting for CDP to become available...
timeout /t 5 /nobreak >nul

:check
curl -s http://127.0.0.1:%PORT%/json/version >nul 2>&1
if %errorlevel% neq 0 (
    echo Still waiting...
    timeout /t 2 /nobreak >nul
    goto check
)

echo.
echo CDP ready at http://127.0.0.1:%PORT%
curl -s http://127.0.0.1:%PORT%/json/version
echo.
