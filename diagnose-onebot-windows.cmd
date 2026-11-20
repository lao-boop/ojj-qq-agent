@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
node scripts\diagnose_onebot.mjs --seconds=30
set "check_exit=%errorlevel%"
pause
exit /b %check_exit%
