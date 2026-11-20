@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto need_node
node -e "process.exit(Number(process.versions.node.split('.')[0])>=20?0:1)"
if errorlevel 1 goto need_node
call npm ci --ignore-scripts --no-audit --no-fund
if errorlevel 1 goto failed
node scripts\friend-setup.mjs
if errorlevel 1 goto failed
echo Setup complete. Next: start-windows.cmd
pause
exit /b 0
:need_node
echo Install Node.js 24 LTS from https://nodejs.org/en/download then reopen this file.
pause
exit /b 1
:failed
echo Setup stopped. Read the message above. Existing data was not force-overwritten.
pause
exit /b 1
