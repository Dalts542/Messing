@echo off
echo.
echo   Stopping Paddock Intelligence server...
echo.

for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3000" ^| findstr "LISTENING"') do (
    echo   Killing process %%a on port 3000
    taskkill /F /PID %%a >nul 2>nul
)

echo   Server stopped.
echo.
pause
