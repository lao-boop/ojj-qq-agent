@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" goto failed
".venv\Scripts\python.exe" -m pip install -r requirements-multimodal.txt
if errorlevel 1 goto failed
where ffmpeg >nul 2>nul
if errorlevel 1 echo FFmpeg is not on PATH. See docs\WINDOWS-HANDOVER.md for installation.
echo Dependencies installed. Enable only configured features as described in the guide.
pause
exit /b 0
:failed
echo Run install-office-windows.cmd first. If pip fails, keep the error text for diagnosis.
pause
exit /b 1
