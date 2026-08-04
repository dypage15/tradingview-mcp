@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo.
echo === GLP Discord bot setup (steps 3+) ===
echo  1-2 should already be done: bot created + invited to your server
echo  This saves the token under %%APPDATA%%\GLP\  (same place as the UW key)
echo.

python -c "import discord" 2>nul
if errorlevel 1 (
  echo Installing discord.py...
  python -m pip install -r "%~dp0requirements-discord.txt"
  if errorlevel 1 (
    echo pip install failed.
    pause
    exit /b 1
  )
)

python "%~dp0source\discord_bot.py" --setup
if errorlevel 1 (
  echo Setup did not finish.
  pause
  exit /b 1
)

echo.
set /p STARTNOW=Start the bot now? [Y/n] 
if /i "%STARTNOW%"=="n" goto :done
call "%~dp0Start-GLP-Discord-Bot.cmd"
goto :eof

:done
echo Run Start-GLP-Discord-Bot.cmd when you want the bot online.
pause
endlocal
