#!/usr/bin/env bash
# Final-acceptance long run: drives the fixed 18-round stress table per
# wire in repeated batches until the wall-clock budget is exhausted
# (default 4h15m), accumulating at least 200 rounds. The first failing
# batch stops the run, preserves the batch artifacts in place, and is
# re-runnable standalone; a failure is never retried away inside a batch
# or by silently skipping a wire.
#
# Usage:
#   scripts/acp-validation/run-long.sh /path/to/codex [expected-sha256] [outdir]
# Env: LONG_RUN_BUDGET_S (default 15300), LONG_RUN_MIN_ROUNDS (default 200)
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CODEX_PATH="${1:-${CODEX_PATH:-}}"
EXPECT_SHA="${2:-${EXPECT_CODEX_SHA256:-}}"
OUTDIR="${3:-/tmp/acp-long-run-$(date +%Y%m%d-%H%M%S)}"
BUDGET_S="${LONG_RUN_BUDGET_S:-15300}"
MIN_ROUNDS="${LONG_RUN_MIN_ROUNDS:-200}"
mkdir -p "$OUTDIR"
MOCK_EXPECT_SHA="$(node - "$SCRIPT_DIR/mock-vendor-server.mjs" <<'JS'
const fs = require("node:fs");
const crypto = require("node:crypto");
console.log(crypto.createHash("sha256").update(fs.readFileSync(process.argv[2])).digest("hex"));
JS
)" || exit 4
export MOCK_EXPECT_SHA
printf '%s\n' "$MOCK_EXPECT_SHA" > "$OUTDIR/mock-source-sha256.txt"
STARTED=$(date +%s)
echo "long-run start $(date -u +%Y-%m-%dT%H:%M:%SZ) budget=${BUDGET_S}s min_rounds=$MIN_ROUNDS out=$OUTDIR" | tee "$OUTDIR/driver.log"

batch=0
total_rounds=0
first_fail=""
while :; do
  now=$(date +%s)
  elapsed=$((now - STARTED))
  remaining=$((BUDGET_S - elapsed))
  if [ "$remaining" -le 0 ]; then
    echo "budget exhausted after ${elapsed}s" | tee -a "$OUTDIR/driver.log"
    break
  fi
  batch=$((batch + 1))
  echo "=== batch $batch at +${elapsed}s remaining ${remaining}s rounds $total_rounds ===" | tee -a "$OUTDIR/driver.log"
  LOG="$OUTDIR/batch-$batch.log"
  # Let the OS reserve a free port for each wire. Picking a random number
  # does not reserve it, and can collide with an unrelated listening server.
  if MOCK_PORT=0 bash "$SCRIPT_DIR/run-stress.sh" "$CODEX_PATH" "$EXPECT_SHA" ALL >"$LOG" 2>&1; then
    # Each wire prints one "summary: P/R rounds passed" line; count the
    # run side of every wire summary in this batch.
    batch_rounds=$(grep -oE '[0-9]+/[0-9]+ rounds passed' "$LOG" | awk -F'[/ ]' '{s+=$2} END {print s+0}')
    total_rounds=$((total_rounds + batch_rounds))
    batch_took=$(( $(date +%s) - now ))
    echo "batch $batch ok in ${batch_took}s rounds=$batch_rounds total=$total_rounds" | tee -a "$OUTDIR/driver.log"
  else
    rc=$?
    first_fail="batch $batch rc=$rc log=$LOG"
    echo "FIRST FAILURE: $first_fail" | tee -a "$OUTDIR/driver.log"
    break
  fi
done

echo "=== long-run summary ===" | tee -a "$OUTDIR/driver.log"
echo "wall_seconds=$(( $(date +%s) - STARTED ))" | tee -a "$OUTDIR/driver.log"
echo "batches=$batch" | tee -a "$OUTDIR/driver.log"
echo "total_rounds=$total_rounds min_required $MIN_ROUNDS" | tee -a "$OUTDIR/driver.log"
echo "first_failure=${first_fail:-none}" | tee -a "$OUTDIR/driver.log"
if [ -n "$first_fail" ]; then
  exit 1
fi
if [ "$total_rounds" -lt "$MIN_ROUNDS" ]; then
  echo "round floor not met" | tee -a "$OUTDIR/driver.log"
  exit 2
fi
if [ $(( $(date +%s) - STARTED )) -lt 14400 ]; then
  echo "wall-clock floor (4h) not met" | tee -a "$OUTDIR/driver.log"
  exit 3
fi
exit 0
