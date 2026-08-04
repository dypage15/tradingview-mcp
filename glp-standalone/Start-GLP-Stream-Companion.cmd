@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "GLP_CONFIG_DIR=%APPDATA%\GLP"
if exist "%GLP_CONFIG_DIR%\unusualwhales_api_key" (
  set /p UNUSUAL_WHALES_API_KEY=<"%GLP_CONFIG_DIR%\unusualwhales_api_key"
)

echo.
echo GLP Stream Companion — YouTube / OBS play-by-play
echo   Director desk:  http://127.0.0.1:8765/?mode=desk
echo   OBS overlay:    http://127.0.0.1:8765/?mode=overlay
echo   Lower third:    http://127.0.0.1:8765/?mode=lower
echo.
echo Educational only. Not financial advice.
echo.

start "" "http://127.0.0.1:8765/?mode=desk"
python "%~dp0source\stream_companion.py" --port 8765 %*
exit /b %ERRORLEVEL%
