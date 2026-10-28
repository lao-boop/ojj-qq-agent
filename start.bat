@echo off
chcp 65001 >nul
title 小鲸鱼 QQ 机器人
cd /d "%~dp0"

set "NODE_EXE="
for %%P in (node.exe) do if not defined NODE_EXE set "NODE_EXE=%%~$PATH:P"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"

if not defined NODE_EXE (
  echo.
  echo 没找到 Node.js。请先安装 Node.js 22 或更高版本：https://nodejs.org/
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\ws" (
  echo 第一次运行，正在安装依赖...
  call npm install --no-audit --no-fund
)

echo 使用 Node：%NODE_EXE%
"%NODE_EXE%" src\index.js
echo.
echo 机器人已退出。
pause
