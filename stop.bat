@echo off
echo.
echo   Stopping Paddock Intelligence...
echo.

:: Stop Node.js server on port 3000
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3000" ^| findstr "LISTENING"') do (
    echo   Stopping server (PID %%a)
    taskkill /F /PID %%a >nul 2>nul
)

echo   Server stopped.
echo.
echo   Note: Ollama continues running in the background.
echo   To stop Ollama too, run: taskkill /F /IM ollama.exe
echo.
pause
