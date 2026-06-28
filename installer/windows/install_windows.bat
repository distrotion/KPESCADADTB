@echo off
:: KPE SCADA - Windows installer (คลิกขวา ไฟล์นี้ > Run as administrator)
::   เรียก install_windows.ps1 (จะ self-elevate ถ้ายังไม่ใช่ admin) + bypass execution policy
title KPE SCADA - Install
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install_windows.ps1" %*
echo.
pause
