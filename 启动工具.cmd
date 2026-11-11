@echo off
cd /d "%~dp0"
title BOM Taobao Assistant
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\bootstrap.ps1"
if errorlevel 1 exit /b 1
