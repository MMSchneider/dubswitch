#!/usr/bin/env bash
# Stop the development supervisor if running
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PIDFILE="$ROOT_DIR/scripts/supervisor.pid"
if [ ! -f "$PIDFILE" ]; then
  echo "No PID file found at $PIDFILE. Is the supervisor running?"
  exit 1
fi
PID=$(cat "$PIDFILE")
if kill -0 "$PID" 2>/dev/null; then
  echo "Stopping supervisor PID $PID"
  kill "$PID"
  sleep 1
  if kill -0 "$PID" 2>/dev/null; then
    echo "Supervisor did not exit, sending SIGKILL"
    kill -9 "$PID"
  fi
  rm -f "$PIDFILE"
  echo "Stopped"
  exit 0
else
  echo "Process $PID is not running; removing stale PID file"
  rm -f "$PIDFILE"
  exit 1
fi
