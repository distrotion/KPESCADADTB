@echo off
title KPE SCADA
cd /d "%~dp0"
echo =============================================
echo  KPE SCADA - Starting services...
echo =============================================

:: single-port: frontend (KPE_PORT, default 3012) serves UI + proxy /api,/ws -> backend (internal 4012)
if "%KPE_PORT%"=="" set KPE_PORT=3012

:: Start Backend (npm install on first run -- node_modules is not committed to git)
echo [1/2] Starting Backend (internal)...
start "KPE SCADA Backend" cmd /k "cd /d "%~dp0backend" && (if not exist node_modules call npm install) && node src/server.js"

:: Wait a moment
timeout /t 2 /nobreak > nul

:: Start Frontend (single public port)
echo [2/2] Starting Frontend (port %KPE_PORT%)...
start "KPE SCADA Frontend" cmd /k "cd /d "%~dp0frontend" && node serve.js"

:: Wait and open browser
timeout /t 3 /nobreak > nul
echo Opening Dashboard...
start http://localhost:%KPE_PORT%

echo.
echo KPE SCADA is running!
echo   Open: http://localhost:%KPE_PORT%   (single port - backend is internal)
echo.
echo Close the Backend and Frontend windows to stop.
pause
