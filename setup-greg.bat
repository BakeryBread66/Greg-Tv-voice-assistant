@echo off
title Greg setup
cd /d "%~dp0"

REM Everything real happens in setup-greg.ps1. This exists so the first thing a
REM new user does is double-click a file, the same as start-greg.bat and
REM stop-greg.bat - and because nothing complicated survives a command line, a
REM lesson this project has paid for more than once.
REM
REM -File rather than -Command: a script block full of braces does not survive
REM the trip through the shell's quoting.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-greg.ps1" %*

echo.
pause
