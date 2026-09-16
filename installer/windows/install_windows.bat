@echo off
:: KPE SCADA - Windows installer (right-click this file > Run as administrator)
::   Runs install_windows.ps1 (self-elevates if not admin) + bypasses execution policy
::   NOTE: keep this file pure ASCII with CRLF line endings (cmd.exe requirement).
title KPE SCADA - Install
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install_windows.ps1" %*
echo.
pause
