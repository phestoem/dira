#!/bin/bash
# Scores extraction alone: each extractor × model seeds every set 3 times and scores the stored graph against
# test/extraction/<set>.expect.json. Usage: scripts/golden/extraction.sh [runs]   (default 3)
# Output: logs/extraction/<extractor>-<model>-<set>-<run>.txt and one line per run in logs/extraction/summary.txt.
# Hold-out sets run with --score-only and keep only their score and totals lines: never inspect them, nor their
# dumps (logs/extraction/dumps/, kept only for re-scoring) or the traces.
set -uo pipefail
cd "$(dirname "$0")/../.."
RUNS=${1:-3}
OUT=$(cd .. && pwd)/logs/extraction
mkdir -p "$OUT"
EXTRACTORS=${EXTRACTORS:-rules schema}
MODELS=${MODELS:-gpt-4o-mini gpt-4o gpt-4.1}
echo "== $(date -Is) extractors: $EXTRACTORS models: $MODELS runs: $RUNS" >> "$OUT/summary.txt"
for extractor in $EXTRACTORS; do
  for model in $MODELS; do
    TRACE="$OUT/trace-$extractor-$model.jsonl"
    scripts/devapi.sh rules PEOPLE_EXTRACTOR="$extractor" GRAPH_EXTRACT_MODEL="$model" DIRA_EXTRACT_TRACE="$TRACE" || exit 1
    for run in $(seq 1 "$RUNS"); do
      for set in synthetic holdout holdout2 holdout3; do
        file="$OUT/$extractor-$model-$set-$run.txt"
        if [ "$set" = synthetic ]; then
          npm run golden -- --set "$set" --extraction --trace "$TRACE" --dump "$OUT/dumps/$extractor-$model" 2>&1 | grep -v prisma:query > "$file"
        else
          npm run golden -- --set "$set" --extraction --trace "$TRACE" --dump "$OUT/dumps/$extractor-$model" --score-only 2>&1 | grep -E '^[0-9]+/[0-9]+ facts stored|^extraction:|^golden:' > "$file"
        fi
        echo "$extractor $model $set run$run: $(grep -E '^[0-9]+/[0-9]+ facts stored|^golden:' "$file" | tail -1)" | tee -a "$OUT/summary.txt"
      done
    done
  done
done
scripts/devapi.sh rules
echo "== $(date -Is) done" >> "$OUT/summary.txt"
