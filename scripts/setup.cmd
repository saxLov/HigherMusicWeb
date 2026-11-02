@echo off
chcp 65001 >nul
echo Installing dependencies, please wait...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1"
pause