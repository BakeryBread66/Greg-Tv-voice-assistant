#!/usr/bin/env bash
# Stop Greg on Linux or macOS. The counterpart to stop-greg.bat.
#
# Two rules carried over from the Windows version, both learned the hard way:
#
#   1. Kill the process TREE, not just Node. Force-killing the server skips its
#      cleanup handler and orphans the Python sidecars, which keep holding ports
#      4748-4750 and — for the clone — several gigabytes of GPU memory that
#      nothing else can reclaim.
#
#   2. Sweep by NAMED FILE, never a wildcard. The list below is explicit for the
#      same reason stop-greg.bat's is: a new sidecar that is not added here by
#      name survives every shutdown holding its memory. `*_server.py` would be
#      tidier and has never been what this does.
set -uo pipefail

cd "$(dirname "$0")"

port=4747
if [ -f config.json ] && command -v node >/dev/null 2>&1; then
  port="$(node -p 'try{JSON.parse(require("fs").readFileSync("config.json","utf8")).port||4747}catch(e){4747}' 2>/dev/null || echo 4747)"
fi

echo
echo "  Shutting Greg down..."
killed=0

# The server, found by what is listening rather than by name — and checked, so
# this cannot take down somebody else's program that happens to hold the port.
pids=""
if command -v lsof >/dev/null 2>&1; then
  pids="$(lsof -ti tcp:"$port" -sTCP:LISTEN 2>/dev/null || true)"
elif command -v ss >/dev/null 2>&1; then
  pids="$(ss -lptnH "sport = :$port" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | sort -u || true)"
fi

for pid in $pids; do
  name="$(ps -p "$pid" -o comm= 2>/dev/null || true)"
  if [ "$name" != "node" ]; then
    echo "  Port $port is held by ${name:-an unknown process} (PID $pid), which is not Greg."
    echo "  Leaving it alone - shut that program down yourself if you meant to."
    continue
  fi
  # Negative PID kills the process group, so the sidecars go with it.
  kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  killed=$((killed + 1))
done

# Then sweep for sidecars a previous bad shutdown may have orphaned. By name.
helpers=0
for script in whisper_server.py piper_server.py clone_server.py; do
  if command -v pkill >/dev/null 2>&1; then
    # -f matches the full command line; the script name is specific enough that
    # this cannot match anything else, and pkill excludes itself.
    if pkill -f "$script" 2>/dev/null; then
      helpers=$((helpers + 1))
      killed=$((killed + 1))
    fi
  fi
done

echo
if [ "$killed" -eq 0 ]; then
  echo "  Greg is not running. Nothing was listening on port $port."
else
  echo "  Greg is off."
  [ "$helpers" -gt 0 ] && echo "  (local ears and voice stopped too, GPU memory released)"
  echo "  (Ollama keeps running on its own; its model frees your GPU after ~5 idle minutes.)"
fi
