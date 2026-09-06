@echo off
title Paddock Intelligence v2

REM ---------------------------------------------------------------------------
REM Paddock Intelligence - Windows launcher.
REM
REM NOTE FOR MAINTAINERS: this file deliberately uses GOTO labels instead of
REM parenthesised IF blocks. A literal ")" inside an ECHO closes an IF block
REM early, which silently moved PAUSE + EXIT outside the block and made the
REM launcher quit on every run. Escape every literal paren as ^) and keep
REM using labels. tests/batch-lint.test.js enforces this.
REM ---------------------------------------------------------------------------

REM Always work from this script's own folder, whatever the current directory is.
cd /d "%~dp0"

echo.
echo   Paddock Intelligence v2
echo   =======================
echo.

REM --- Node.js ---------------------------------------------------------------
node --version >nul 2>&1
if errorlevel 1 goto :no_node

REM --- npm (optional: this project has no npm dependencies^) ------------------
call npm --version >nul 2>&1
if errorlevel 1 echo   Note: npm was not found. Not required for this project.

REM --- Entry point -----------------------------------------------------------
if not exist "src\launcher.js" goto :no_files
if not exist "src\server.js" goto :no_files

REM --- Dependencies ----------------------------------------------------------
echo   Checking dependencies...
if not exist "package.json" goto :deps_done
findstr /C:"\"dependencies\"" "package.json" >nul 2>&1
if errorlevel 1 goto :deps_none
if exist "node_modules" goto :deps_done
echo   Installing dependencies...
if exist "package-lock.json" goto :deps_ci
call npm install
if errorlevel 1 goto :deps_failed
goto :deps_done
:deps_ci
call npm ci
if errorlevel 1 goto :deps_failed
goto :deps_done
:deps_none
echo   No dependencies required.
:deps_done

REM --- Launch ----------------------------------------------------------------
REM launcher.js prints its own stages, waits for /health, then opens the
REM browser. It stays in the foreground so the server keeps running.
node "src\launcher.js"
set "RC=%ERRORLEVEL%"

if "%RC%"=="0" goto :stopped_normally
goto :launch_failed

REM ---------------------------------------------------------------------------
:stopped_normally
echo.
echo   Paddock Intelligence has stopped.
echo.
pause
exit /b 0

REM ---------------------------------------------------------------------------
:launch_failed
echo.
echo   ==========================================================
echo    PADDOCK INTELLIGENCE FAILED TO START
echo   ==========================================================
echo.
echo    The launcher exited with code %RC%.
echo.
if "%RC%"=="2" echo    Cause: preflight failed ^(Node too old, or files missing^).
if "%RC%"=="3" echo    Cause: port 3000 is in use by another program.
if "%RC%"=="4" echo    Cause: the server could not start.
if "%RC%"=="5" echo    Cause: the server started but never became healthy.
echo.
echo    The exact error is printed above.
echo    Full log: "%~dp0data\startup.log"
echo.
pause
exit /b %RC%

REM ---------------------------------------------------------------------------
:no_node
echo.
echo   ==========================================================
echo    NODE.JS IS NOT INSTALLED
echo   ==========================================================
echo.
echo    Paddock Intelligence needs Node.js to run.
echo    It is free and takes about two minutes to install.
echo.
echo    1. Go to:  https://nodejs.org
echo    2. Download the button marked LTS ^(the recommended one^).
echo    3. Run the installer and accept the default options.
echo    4. Close this window, then double-click start.bat again.
echo.
echo    You need version 22.5 or newer.
echo.
echo    Nothing has been installed or changed on your PC.
echo.
pause
exit /b 2

REM ---------------------------------------------------------------------------
:no_files
echo.
echo   ==========================================================
echo    PROJECT FILES ARE MISSING
echo   ==========================================================
echo.
echo    Could not find src\launcher.js or src\server.js
echo.
echo    Looking in: "%~dp0"
echo.
echo    If you downloaded a ZIP, make sure you EXTRACTED it fully
echo    and that start.bat sits next to the "src" folder.
echo.
pause
exit /b 2

REM ---------------------------------------------------------------------------
:deps_failed
echo.
echo   ==========================================================
echo    DEPENDENCY INSTALL FAILED
echo   ==========================================================
echo.
echo    npm exited with code %ERRORLEVEL%.
echo    Check your internet connection and try again.
echo.
pause
exit /b 2
