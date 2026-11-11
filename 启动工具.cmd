@echo off
cd /d "%~dp0"
title BOM Taobao Assistant

where node >nul 2>nul
if errorlevel 1 goto :no_node

if not exist "node_modules\express" goto :install_deps
goto :check_browser

:install_deps
echo [First run] Installing dependencies...
call npm install
if errorlevel 1 goto :failed

:check_browser
if exist "%LOCALAPPDATA%\ms-playwright" goto :run
echo [First run] Installing Chromium...
call npx playwright install chromium
if errorlevel 1 goto :failed

:run
echo Starting BOM Taobao Assistant...
echo Keep this window open while using the tool.
echo URL: http://127.0.0.1:3210
call npm start
echo.
echo The service has stopped. Review the error above.
pause
exit /b 0

:no_node
echo [ERROR] Node.js was not found.
echo Install Node.js 20 or newer: https://nodejs.org/
pause
exit /b 1

:failed
echo.
echo Installation failed. Check your network and try again.
pause
exit /b 1
