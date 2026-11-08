@echo off
rem Double-click to remove PAX from this Windows PC. Your database is kept unless you say otherwise.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1" %*
