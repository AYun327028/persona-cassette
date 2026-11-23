@echo off
chcp 65001 >nul
set PYTHONUTF8=1
title Pure OpenAI Chat
python "%~dp0chat.py" %*
if errorlevel 1 pause
