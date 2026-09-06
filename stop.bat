@echo off
title Stop Paddock Intelligence

REM Uses GOTO labels, not parenthesised IF blocks - see the note in start.bat.
cd /d "%~dp0"

node --version >nul 2>&1
if errorlevel 1 goto :no_node

if not exist "src\stop.js" goto :no_files

node "src\stop.js"
set "RC=%ERRORLEVEL%"

if not "%RC%"=="0" goto :not_stopped
echo   Done.
echo.
pause
exit /b 0

REM ---------------------------------------------------------------------------
:not_stopped
echo   Paddock Intelligence could not be stopped automatically.
echo   Close its window to stop it.
echo.
pause
exit /b %RC%

REM ---------------------------------------------------------------------------
:no_node
echo.
echo   Node.js was not found, so Paddock Intelligence cannot be running.
echo   Nothing to stop.
echo.
pause
exit /b 0

REM ---------------------------------------------------------------------------
:no_files
echo.
echo   Could not find src\stop.js in "%~dp0"
echo   Make sure stop.bat sits next to the "src" folder.
echo.
pause
exit /b 2
