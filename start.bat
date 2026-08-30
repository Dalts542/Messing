@echo off
setlocal enabledelayedexpansion
title Paddock Intelligence

echo.
echo   Paddock Intelligence — Starting local server...
echo   ================================================
echo.

cd /d "%~dp0src"

if not exist ".env" (
    if exist "env-example.txt" (
        echo   No .env found — creating from env-example.txt
        copy "env-example.txt" ".env" >nul
        echo   Edit src\.env to add your Racing API credentials.
        echo.
    )
)

:: Load .env variables
if exist ".env" (
    for /f "usebackq tokens=1,* delims==" %%a in (".env") do (
        set "line=%%a"
        if not "!line:~0,1!"=="#" (
            if not "%%a"=="" (
                set "%%a=%%b"
            )
        )
    )
)

where node >nul 2>nul
if !ERRORLEVEL! neq 0 (
    echo   ERROR: Node.js is not installed.
    echo   Download it free from https://nodejs.org
    echo.
    pause
    exit /b 1
)

echo   Opening browser...
start "" "http://127.0.0.1:3000/"

echo   Starting server (Ctrl+C to stop)...
echo.
node server.js
