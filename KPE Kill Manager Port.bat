@echo off
:: KPE SCADA - Kill (close) the port configured as Manager
::   Reads the port from the real ports.js (respects env KPE_MANAGER_PORT > ports.json > default 5012)
::   Double-click on Windows. Run as Administrator if the process refuses to close.
::   NOTE: single-instance only. For Windows Service / multi-instance this resolves to the
::         DEFAULT port (5012) and will NOT match instance ports -- use "KPE Service Manager.bat".
title KPE SCADA - Kill Manager Port
cd /d "%~dp0"
setlocal enabledelayedexpansion

:: -- resolve manager port via central resolver (move-safe) ; fallback 5012 if node missing/unreadable --
set "PORT="
for /f "usebackq delims=" %%i in (`node -e "console.log(require('./ports.js').ports().manager)" 2^>nul`) do set "PORT=%%i"
if not defined PORT set "PORT=5012"
:: numeric guard (non-numeric -> default)
set "_chk="
set /a "_chk=PORT" 2>nul
if not "!_chk!"=="!PORT!" set "PORT=5012"

echo ==============================================
echo  KPE SCADA : Kill Manager port %PORT%
echo ==============================================

:: -- find listeners on the port (IPv4 + IPv6) and kill them --
set "FOUND="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /C:":%PORT% " ^| findstr "LISTENING"') do (
  set "FOUND=1"
  echo Found process on port %PORT% - PID %%p, killing...
  taskkill /F /PID %%p >nul 2>&1
)

if not defined FOUND (
  echo [OK] Port %PORT% is already free ^(Manager not running^).
) else (
  timeout /t 1 /nobreak >nul
  netstat -ano | findstr /C:":%PORT% " | findstr "LISTENING" >nul 2>&1
  if errorlevel 1 (
    echo [OK] Manager ^(port %PORT%^) closed.
  ) else (
    echo [!] Still listening - try again, or run this file as Administrator.
  )
)

endlocal
echo.
echo (You can close this window.)
pause >nul
