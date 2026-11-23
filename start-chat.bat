@echo off
chcp 65001 >nul
set PYTHONUTF8=1
title Persona Cassette CMD Chat
python "%~dp0chat-cli\chat.py" --cassette starter --commit %*
if errorlevel 1 pause
