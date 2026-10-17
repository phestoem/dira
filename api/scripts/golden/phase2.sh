#!/bin/bash
# Claims extraction runs on the claim store: scripts/golden/phase2.sh <label> <runs> <set>... (hold-outs score-only).
# Output: logs/phase2/<label>/<set>-<run>.txt and summary.txt. Traces of hold-outs are written but never read.
set -uo pipefail
cd "$(dirname "$0")/../.."
LABEL=${1:?label}; RUNS=${2:?runs}; shift 2
OUT=$(cd .. && pwd)/logs/phase2/$LABEL
mkdir -p "$OUT"
bash scripts/devapi.sh rules KNOWLEDGE_LAYER=claims DIRA_ALLOW_AS_OF=1 KNOWLEDGE_TRACE="$OUT/trace.jsonl" ${PHASE2_ENV:-}
for run in $(seq 1 "$RUNS"); do
  for set in "$@"; do
    flags="--claims"
    case $set in holdout[1-3]|holdout|holdout5) flags="--claims --score-only" ;; *) flags="--claims --dump $OUT/dumps" ;; esac
    npm run golden -- --set "$set" $flags > "$OUT/$set-$run.txt" 2>&1
    echo "$set run$run: $(grep -E 'claims stored' "$OUT/$set-$run.txt" | tail -1) | $(grep -E '^domains:' "$OUT/$set-$run.txt" | tail -1)" | tee -a "$OUT/summary.txt"
  done
done
bash scripts/devapi.sh rules
echo "== $(date -Is) done" | tee -a "$OUT/summary.txt"
