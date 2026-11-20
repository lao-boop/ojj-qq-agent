@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
echo These are local simulated tests. They do not log into QQ or call a real model.
node --test tests\friend-handover.test.js tests\casual-chat.test.js tests\casual-chat-ingress.test.js
set "check_exit=%errorlevel%"
pause
exit /b %check_exit%
