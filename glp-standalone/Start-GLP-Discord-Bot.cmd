@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "GLP_CONFIG_DIR=%APPDATA%\GLP"
if exist "%GLP_CONFIG_DIR%\discord_bot_token" (
  set /p DISCORD_BOT_TOKEN=<"%GLP_CONFIG_DIR%\discord_bot_token"
)
if exist "%GLP_CONFIG_DIR%\unusualwhales_api_key" (
  set /p UNUSUAL_WHALES_API_KEY=<"%GLP_CONFIG_DIR%\unusualwhales_api_key"
)
if exist "%GLP_CONFIG_DIR%\discord_bot_allowlist.env" (
  for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%GLP_CONFIG_DIR%\discord_bot_allowlist.env") do (
    if not "%%A"=="" if "%%~B" NEQ "" set "%%A=%%~B"
  )
)

python -c "import discord" 2>nul
if errorlevel 1 (
  echo discord.py missing — installing...
  python -m pip install -r "%~dp0requirements-discord.txt"
)

if "%DISCORD_BOT_TOKEN%"=="" if "%GLP_DISCORD_BOT_TOKEN%"=="" (
  if not exist "%GLP_CONFIG_DIR%\discord_bot_token" (
    echo No bot token found.
    echo Run Setup-GLP-Discord-Bot.cmd and paste the token from the Developer Portal.
    pause
    exit /b 1
  )
)

echo Preflight...
python "%~dp0source\discord_bot.py" --preflight
if errorlevel 1 (
  echo.
  echo Preflight incomplete. Fix the MISSING/FAIL lines above, then retry.
  echo Token setup:  Setup-GLP-Discord-Bot.cmd
  echo UW key:       Launch-GLP.bat --set-key
  echo TradingView:  Desktop with --remote-debugging-port=9222
  pause
  exit /b 1
)

echo.
echo Starting GLP Discord bot — leave this window open.
echo In Discord:  @YourBot update NQ   or   !glp QQQ asia
echo.
python "%~dp0source\discord_bot.py"
set ERR=%ERRORLEVEL%
echo.
echo Bot stopped ^(exit %ERR%^).
pause
exit /b %ERR%
