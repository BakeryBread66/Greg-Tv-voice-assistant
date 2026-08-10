@echo off
title Stop Greg
cd /d "%~dp0"
echo.
echo   Shutting Greg down...

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='SilentlyContinue'; $port=4747; try{ $cfg=Get-Content '.\config.json' -Raw | ConvertFrom-Json; if($cfg.port){ $port=[int]$cfg.port } }catch{}; $conns=@(Get-NetTCPConnection -LocalPort $port -State Listen); $killed=0; foreach($c in $conns){ $p=Get-Process -Id $c.OwningProcess; if(-not $p){ continue }; if($p.ProcessName -ne 'node'){ Write-Host ''; Write-Host ('  Port ' + $port + ' is in use by ' + $p.ProcessName + ' (PID ' + $p.Id + '), which is not Greg.') -ForegroundColor Yellow; Write-Host '  Leaving it alone - shut that program down yourself if you meant to.' -ForegroundColor Yellow; continue }; taskkill /PID $p.Id /T /F 2>&1 | Out-Null; $killed++ }; $helpers=@(Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | Where-Object { $_.CommandLine -like '*whisper_server.py*' -or $_.CommandLine -like '*piper_server.py*' -or $_.CommandLine -like '*clone_server.py*' }); foreach($h in $helpers){ Stop-Process -Id $h.ProcessId -Force; $killed++ }; $watchers=@(Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.ProcessId -ne $PID -and ($_.CommandLine -like '*media-session.ps1*' -or $_.CommandLine -like '*cursor-watch.ps1*') }); foreach($w in $watchers){ Stop-Process -Id $w.ProcessId -Force; $killed++ }; if($killed -eq 0){ Write-Host ''; Write-Host ('  Greg is not running. Nothing was listening on port ' + $port + '.') -ForegroundColor DarkGray } else { Write-Host ''; Write-Host '  Greg is off.' -ForegroundColor Green; if($helpers.Count){ Write-Host '  (local ears and voice stopped too, GPU memory released)' -ForegroundColor DarkGray }; Write-Host '  (Ollama keeps running on its own; its model frees your GPU after ~5 idle minutes.)' -ForegroundColor DarkGray }"

echo.
rem Brief pause so the message is readable before the window closes.
rem (ping rather than timeout - timeout fails when stdin is redirected.)
ping -n 5 127.0.0.1 >nul 2>&1
