@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
node scripts\friend-check.mjs --online
set "check_exit=%errorlevel%"
pause
exit /b %check_exit%
