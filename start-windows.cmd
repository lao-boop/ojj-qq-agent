@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
node scripts\friend-check.mjs
if errorlevel 1 goto failed
echo Keep this window open. Press Ctrl+C to stop the bot.
node src\index.js
set "bot_exit=%errorlevel%"
echo Bot exited. Review the messages above if unexpected.
pause
exit /b %bot_exit%
:failed
echo Startup checks failed. Run setup-windows.cmd in a fresh package if needed.
pause
exit /b 1
