@echo off
title Marathon Coach - pubblicazione
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\pubblica.ps1"
echo.
pause
