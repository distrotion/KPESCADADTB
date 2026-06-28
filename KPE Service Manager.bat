@echo off
setlocal enabledelayedexpansion
title KPE SCADA - Service Manager
:: ----------------------------------------------------------------------------
:: KPE SCADA - Service Manager  (multi-instance safe)
::   Lists every installed "kpe-scada*" Windows service and lets you
::   restart / stop / start the one you pick, plus open its Manager in a browser.
::   It controls the SERVICE by name -- it does NOT guess a port -- so it works
::   no matter which instance / PortBase each one runs on.
::   Double-click it. It self-elevates to Administrator (service control needs it).
::
::   NOTE: the old "KPE Kill Manager Port.bat" / "KPE SCADA Manager.bat" only work
::         for a manual single-instance run (default port 5012). For service /
::         multi-instance installs use THIS file instead.
:: ----------------------------------------------------------------------------
cd /d "%~dp0"

:: -- self-elevate (controlling Windows services needs Administrator) --
net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

:menu
cls
echo ===============================================================
echo   KPE SCADA - Service Manager
echo ===============================================================
echo.
set "n=0"
for /f "tokens=2" %%s in ('sc query state^= all ^| findstr /B /C:"SERVICE_NAME:" ^| findstr /I "kpe-scada"') do (
  set /a n+=1
  set "svc!n!=%%s"
  call :getstate "%%s" stt
  echo     !n!^)  %%s        [ !stt! ]
)
if "%n%"=="0" (
  echo   No "kpe-scada" services found.
  echo   ^(Install one first: installer\windows\install_windows.ps1^)
  echo.
  pause
  exit /b
)
echo.
echo   Q^)  Quit
echo.
set /p "sel=Select service number: "
if /i "%sel%"=="Q" exit /b
set "target=!svc%sel%!"
if not defined target ( echo Invalid choice. & timeout /t 1 /nobreak >nul & goto menu )

:action
cls
call :getstate "%target%" stt
echo ===============================================================
echo   Service: %target%        [ !stt! ]
echo ===============================================================
echo.
echo     R^)  Restart   ^(stop then start^)
echo     S^)  Stop
echo     T^)  Start
echo     O^)  Open Manager in browser
echo     B^)  Back to list
echo.
set /p "act=Action: "
if /i "%act%"=="R" (
  echo Stopping %target% ...
  net stop "%target%" >nul 2>&1
  timeout /t 2 /nobreak >nul
  echo Starting %target% ...
  net start "%target%" >nul 2>&1
  echo [done]
  timeout /t 1 /nobreak >nul
  goto action
)
if /i "%act%"=="S" ( net stop  "%target%" & timeout /t 1 /nobreak >nul & goto action )
if /i "%act%"=="T" ( net start "%target%" & timeout /t 1 /nobreak >nul & goto action )
if /i "%act%"=="O" (
  call :getport "%target%" mport
  if not defined mport set "mport=5012"
  start "" "http://localhost:!mport!"
  goto action
)
if /i "%act%"=="B" goto menu
goto action

:getstate
:: %1 = service name (quoted)  ->  %2 = RUNNING / STOPPED / ...
set "%2=?"
for /f "tokens=4" %%a in ('sc query %1 ^| findstr /C:"STATE"') do set "%2=%%a"
goto :eof

:getport
:: %1 = service name  ->  %2 = KPE_MANAGER_PORT read from service\<name>.xml (blank if none)
set "%2="
for /f "usebackq delims=" %%p in (`powershell -NoProfile -Command "try{([xml](Get-Content -Raw '%~dp0service\%~1.xml')).service.env ^| Where-Object {$_.name -eq 'KPE_MANAGER_PORT'} ^| ForEach-Object {$_.value}}catch{}"`) do set "%2=%%p"
goto :eof
