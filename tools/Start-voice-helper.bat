@echo off
rem Reads new-supporter announcements aloud on this PC (OBS cannot do text-to-speech itself).
rem Edit the two values below, then double-click.
set SUPPORTERS_URL=https://supporters.amayakulkarni.com
set OVERLAY_KEY=PUT-YOUR-OVERLAY-KEY-HERE
cd /d "%~dp0.."
node tools\speak.js --url %SUPPORTERS_URL% --key %OVERLAY_KEY%
pause
