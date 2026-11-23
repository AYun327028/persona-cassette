@echo off
chcp 65001 >nul
title Persona Cassette Headless Server
node "%~dp0kit\bin\pmv.mjs" serve --port 3891 %*
if errorlevel 1 pause
