#!/bin/bash
# Scores people engines on every golden set, 3 runs each, plus live readonly runs on the dira_dev account.
# Usage: scripts/golden/compare.sh <live-user-id> [engines...]   (default engines: rules tools hybrid)
# Output: logs/compare/<engine>-<set>-<run>.txt and one line per run in logs/compare/summary.txt.
# Hold-out sets run with --score-only and only their score and metrics lines are kept: never inspect them.
set -uo pipefail
cd "$(dirname "$0")/../.."
LIVE_USER=${1:?live user id}
shift
ENGINES=${*:-rules tools hybrid}
OUT=$(cd .. && pwd)/logs/compare
mkdir -p "$OUT"
FAMILY=wife,parents,sisters,sister-births,children,children-count,properties,cars,family-tree,four-sisters-statement,grateful-family,children-follow-up,mother-sentence
SCORE='^[0-9]+/[0-9]+ passed|^golden:|^metrics:'
summary() { echo "$1 $2 run$3: $(grep -E '^[0-9]+/[0-9]+ passed|^golden:' "$OUT/$1-$2-$3.txt" | tail -1) $(grep '^metrics:' "$OUT/$1-$2-$3.txt" | tail -1)" | tee -a "$OUT/summary.txt"; }
echo "== $(date -Is) engines: $ENGINES" >> "$OUT/summary.txt"
for engine in $ENGINES; do
  scripts/devapi.sh "$engine" || exit 1
  for run in 1 2 3; do
    npm run golden -- --only "$FAMILY" 2>&1 | grep -v prisma:query > "$OUT/$engine-family-$run.txt"; summary "$engine" family "$run"
    npm run golden -- --set synthetic 2>&1 | grep -v prisma:query > "$OUT/$engine-synthetic-$run.txt"; summary "$engine" synthetic "$run"
    for set in holdout holdout2 holdout3; do
      npm run golden -- --set "$set" --score-only 2>&1 | grep -E "$SCORE" > "$OUT/$engine-$set-$run.txt"; summary "$engine" "$set" "$run"
    done
    npm run golden -- --user "$LIVE_USER" --readonly --only "$FAMILY" 2>&1 | grep -v prisma:query > "$OUT/$engine-live-$run.txt"; summary "$engine" live "$run"
  done
done
scripts/devapi.sh rules
echo "== $(date -Is) done" >> "$OUT/summary.txt"
