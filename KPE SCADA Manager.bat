@echo off
title KPE SCADA Manager
:: Manual single-instance start (default ports). For Windows Service / multi-instance
:: use "KPE Service Manager.bat" instead (controls the service by name, no port guessing).
sc query state= all 2>nul | findstr /B /C:"SERVICE_NAME:" | findstr /I "kpe-scada" >nul 2>&1
if not errorlevel 1 (
  echo [!] A "kpe-scada" Windows service is already installed.
  echo     To restart/stop it use:  "KPE Service Manager.bat"
  echo     Continuing here starts a SECOND manager on default ports - may conflict.
  echo     Press Ctrl+C to cancel, or
  pause
)
cd /d "%~dp0manager"
echo Starting KPE SCADA Manager...
node server.js
pause
