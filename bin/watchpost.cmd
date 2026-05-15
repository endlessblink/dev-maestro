@echo off
rem Watchpost — Windows CMD launcher
rem Forwards to PowerShell wrapper. Place this dir on PATH (or use install-windows.ps1).
setlocal
set "WP_BIN_DIR=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%WP_BIN_DIR%watchpost.ps1" %*
exit /b %ERRORLEVEL%
