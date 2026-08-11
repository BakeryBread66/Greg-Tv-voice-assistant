#!/usr/bin/env bash
# Start Greg on Linux or macOS. The counterpart to start-greg.bat, and it does
# the same three things: check Node, install dependencies on a first run, then
# hand over to the server.
#
# Greg's Windows-only features — screen vision, cursor tracking, the media
# session, media keys and the system voice — are off here. He says which, in the
# banner, once he is up. See docs/linux.md.
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js isn't installed or isn't on your PATH."
  echo "Get it from https://nodejs.org (or your package manager) and run this again."
  exit 1
fi

# Node 20 is the floor, and an older one fails in ways that point nowhere near
# the version — package.json says so, but npm only warns.
major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$major" -lt 20 ]; then
  echo "Node $(node -v) is too old — Greg needs 20 or newer."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "First run - installing Greg's dependencies. This takes about a minute..."
  # --no-fund silences npm's funding notice. It is not an error and nothing is
  # missing, but it is the first thing a new user ever sees and it reads like
  # one — reported as a problem the first time somebody else installed Greg.
  if ! npm install --no-fund; then
    echo
    echo "Dependencies failed to install. Greg cannot start without them."
    echo "Check your internet connection and run this again."
    exit 1
  fi
  echo "Dependencies installed."
  echo
  echo "Starting Greg for the first time. He downloads his voice and his hearing"
  echo "now - that is a few hundred megabytes, once. This may sit still for"
  echo "several minutes. That is normal. He prints a banner when he is ready."
  echo
fi

exec node server.js
