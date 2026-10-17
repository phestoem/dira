#!/bin/bash
# Restarts the dev API on port 4801 with a people engine: scripts/devapi.sh <rules|tools|hybrid> [VAR=value ...]
# Only ever touches the dira-dev API; its output goes to logs/api-<engine>.log.
set -euo pipefail
cd "$(dirname "$0")/.."
ENGINE=${1:?engine}
shift
LOGS=$(cd .. && pwd)/logs
mkdir -p "$LOGS"
for pid in $(ss -ltnp | grep ':4801 ' | grep -o 'pid=[0-9]*' | cut -d= -f2); do
  [ "$(readlink /proc/$pid/cwd)" = "$(pwd)" ] || { echo "port 4801 is held by a process outside dira-dev"; exit 1; }
  kill "$pid"
done
sleep 2
env PEOPLE_ENGINE="$ENGINE" "$@" nohup node src/index.js > "$LOGS/api-$ENGINE.log" 2>&1 &
for _ in $(seq 1 30); do
  curl -sf http://127.0.0.1:4801/health > /dev/null && { echo "dev API up with PEOPLE_ENGINE=$ENGINE"; exit 0; }
  sleep 1
done
echo "dev API did not start; see $LOGS/api-$ENGINE.log"
exit 1
