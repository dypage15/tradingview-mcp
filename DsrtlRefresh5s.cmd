@echo off
cd /d "%~dp0"
echo DSRTL table stream every 5s ^(^-F = heartbeat even when text unchanged^). Ctrl+C to stop.
node src/cli/index.js stream tables -f "Dynamic Support" -i 5000 -F
