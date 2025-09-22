#!/usr/bin/env bash
# Start the development supervisor in the background and record its PID
# Usage: ./scripts/start-supervisor.sh
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SUPERVISOR="$ROOT_DIR/scripts/supervise-server.js"
LOG="$ROOT_DIR/scripts/supervisor.out.log"
if [ ! -f "$SUPERVISOR" ]; then
  echo "Supervisor script not found: $SUPERVISOR"
  exit 1
fi
echo "Starting supervisor (logs -> $LOG)"
nohup node "$SUPERVISOR" > "$LOG" 2>&1 &
echo $! > "$ROOT_DIR/scripts/supervisor.pid"
echo "Supervisor started with PID $(cat "$ROOT_DIR/scripts/supervisor.pid")"
exit 0
