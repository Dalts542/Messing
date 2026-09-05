@echo off
setlocal enabledelayedexpansion
title Paddock Intelligence v2

echo.
echo   Paddock Intelligence v2
echo   =======================
echo.

cd /d "%~dp0src"

:: Load .env if exists, create from template if not
if not exist ".env" (
    if exist "env-example.txt" (
        echo   No .env found — creating from env-example.txt
        copy "env-example.txt" ".env" >nul
        echo   Edit src\.env to add your Racing API credentials.
        echo.
    )
)
if exist ".env" (
    for /f "usebackq tokens=1,* delims==" %%a in (".env") do (
        set "line=%%a"
        if not "!line:~0,1!"=="#" (
            if not "%%a"=="" set "%%a=%%b"
        )
    )
)

:: Check Node.js
where node >nul 2>nul
if !ERRORLEVEL! neq 0 (
    echo   ERROR: Node.js is not installed.
    echo   Download it free from https://nodejs.org (v22.5+ required)
    echo.
    pause
    exit /b 1
)
for /f "tokens=1 delims=v" %%v in ('node -v') do set "NODE_VER=%%v"
echo   Node.js: %NODE_VER%

:: Check Ollama
where ollama >nul 2>nul
if !ERRORLEVEL! equ 0 (
    echo   Ollama: Found
    :: Check if Ollama is running
    curl -s http://localhost:11434/api/tags >nul 2>nul
    if !ERRORLEVEL! neq 0 (
        echo   Starting Ollama...
        start "" /min ollama serve
        timeout /t 3 /nobreak >nul
    )
    :: Check for model
    ollama list 2>nul | findstr /i "llama3" >nul 2>nul
    if !ERRORLEVEL! neq 0 (
        echo   No llama3 model found. Pulling llama3.1:8b (~4.7GB)...
        echo   This is a one-time download.
        ollama pull llama3.1:8b
    )
) else (
    echo   Ollama: Not installed (AI will be offline)
    echo   Install free from https://ollama.com
    echo   Then run: ollama pull llama3.1:8b
)

echo.
echo   Opening browser...
start "" "http://127.0.0.1:3000/"

echo   Starting server (Ctrl+C to stop)...
echo.
node server.js
