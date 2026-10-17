#!/bin/bash
# Phase 1 checks: the old family golden fixture (flag off), then routing on every set with KNOWLEDGE_LAYER=claims.
# Hold-out 4 is not seeded here: it is used once, at the phase 2 gate. Output: logs/phase1/.
set -uo pipefail
cd "$(dirname "$0")/../.."
OUT=$(cd .. && pwd)/logs/phase1
mkdir -p "$OUT"
echo "== $(date -Is) family golden (rules, flag off)" | tee -a "$OUT/summary.txt"
bash scripts/devapi.sh rules
npm run golden > "$OUT/golden-family.txt" 2>&1
grep -E "passed$" "$OUT/golden-family.txt" | tail -1 | tee -a "$OUT/summary.txt"
bash scripts/devapi.sh rules KNOWLEDGE_LAYER=claims
for set in life synthetic holdout holdout2 holdout3; do
  flags="--claims"
  case $set in holdout*) flags="--claims --score-only" ;; esac
  npm run golden -- --set $set $flags > "$OUT/routing-$set.txt" 2>&1
  echo "$set: $(grep -o '"routing":{[^}]*},"dropped":[0-9]*' "$OUT/routing-$set.txt")" | tee -a "$OUT/summary.txt"
done
bash scripts/devapi.sh rules
echo "== $(date -Is) done" | tee -a "$OUT/summary.txt"
