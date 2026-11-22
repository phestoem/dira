#!/usr/bin/env bash
# Restart the dev API (port 4801) as its own process group, so stopping it also stops anything it started
# (such as a binary Prisma query-engine child). Dev only: always port 4801.
set -euo pipefail
cd "$(dirname "$0")/.."
PORT=4801
LOG=../logs/api-personal.log
PGID_FILE=../logs/api-dev.pgid

stop_group() {
  local pgid=$1
  kill -TERM -- "-$pgid" 2>/dev/null || return 0
  for _ in $(seq 1 30); do pgrep -g "$pgid" >/dev/null || return 0; sleep 0.5; done
  kill -KILL -- "-$pgid" 2>/dev/null || true
}

if [ -f "$PGID_FILE" ]; then stop_group "$(cat "$PGID_FILE")"; rm -f "$PGID_FILE"; fi
# An API started some other way: stop it and its children.
pid=$(ss -ltnp | grep ":$PORT " | grep -oP 'pid=\K[0-9]+' | head -1 || true)
if [ -n "$pid" ]; then
  kids=$(pgrep -P "$pid" || true)
  kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 30); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
  [ -n "$kids" ] && kill -TERM $kids 2>/dev/null || true
fi

DIRA_TOKEN_LOG=/opt/qusaz/dira-dev/logs/tokens.jsonl setsid nohup node src/index.js >> "$LOG" 2>&1 < /dev/null &
echo $! > "$PGID_FILE"
for _ in $(seq 1 40); do curl -sf "http://127.0.0.1:$PORT/health" >/dev/null && { echo "dev API up (pgid $(cat "$PGID_FILE"))"; exit 0; }; sleep 0.5; done
echo "dev API did not answer on $PORT; see $LOG" >&2
exit 1
