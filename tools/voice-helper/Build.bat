@echo off
rem Builds supporters-voice.exe (needs Rust from https://rustup.rs).
cd /d "%~dp0"
cargo build --release
if errorlevel 1 (echo. & echo Build failed. Send the error text above. & pause & exit /b 1)
copy /y target\release\supporters-voice.exe "%~dp0supporters-voice.exe" >nul
echo.
echo Done: %~dp0supporters-voice.exe
pause
