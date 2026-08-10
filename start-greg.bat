@echo off
title Greg
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js isn't installed or isn't on your PATH.
  echo Get it from https://nodejs.org and run this again.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo First run - installing Greg's dependencies. This takes about a minute...
  REM --no-fund silences npm's "N packages are looking for funding" notice.
  REM It is not an error and nothing is missing, but it is the first thing a new
  REM user ever sees and it reads like one - reported as a problem the first time
  REM somebody other than us installed Greg.
  call npm install --no-fund
  if errorlevel 1 (
    echo.
    echo Dependencies failed to install. Greg cannot start without them.
    echo Check your internet connection and run this again.
    pause
    exit /b 1
  )
  echo Dependencies installed.
  echo.
  echo Starting Greg for the first time. He downloads his voice and his hearing
  echo now - that is a few hundred megabytes, once. This window may sit still
  echo for several minutes. That is normal. He prints a banner when he is ready.
  echo.
)

node server.js
pause
