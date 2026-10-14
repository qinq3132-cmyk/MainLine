@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0personal-desk\stop.ps1"
if errorlevel 1 pause
