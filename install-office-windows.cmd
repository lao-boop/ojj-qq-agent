@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
if exist ".venv\Scripts\python.exe" goto install
py -3.12 -m venv .venv
if errorlevel 1 goto failed
:install
".venv\Scripts\python.exe" -m pip install -r requirements-windows-office.txt
if errorlevel 1 goto failed
echo Office dependencies installed. Text-only chat does not require this step.
pause
exit /b 0
:failed
echo Install Python 3.12 from https://www.python.org/downloads/windows/ then retry.
echo Do not replace an existing Python environment by force.
pause
exit /b 1
