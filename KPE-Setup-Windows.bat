@echo off
rem KPE MES - double-click to open the Install / License menu (Windows)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0installer\windows\kpe-menu.ps1"
echo.
echo (If an error appears above, copy it. The menu may open in a separate Administrator window.)
pause
