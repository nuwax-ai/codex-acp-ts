#!/usr/bin/env bash
# Fix-up pass for the two driver-side live failures (same VAL_ROOT, same ledger).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../.." && pwd)"
CODEX_BIN="${CODEX_BIN:-/Volumes/soddy/git_workspace/fork-nuwax-codex/.claude/worktrees/merge-main-20261014/codex-rs/target/debug/codex}"
CODEX_EXEC_BIN="${CODEX_EXEC_BIN:-${CODEX_BIN}-exec}"
ENV_FILE="${LIVE_ENV_FILE:-/Volumes/soddy/git_workspace/fork-nuwax-codex/.env.local}"
MAX_OUT=2048
VAL_ROOT="${VAL_ROOT:?set VAL_ROOT to the live run root}"
LEDGER="$VAL_ROOT/ledger.jsonl"

log() { echo "[$(date -u +%FT%TZ)] $*"; }
ATTEMPTS=$(python3 -c "
import json
print(sum(json.loads(l)['attempts'] for l in open('$LEDGER')))")
count_attempt() {
    ATTEMPTS=$((ATTEMPTS + $1))
    printf '%s\n' "{\"ts\":\"$(date -u +%FT%TZ)\",\"attempts\":$1,\"total\":$ATTEMPTS,\"class\":\"$2\",\"vendor\":\"$3\",\"wire\":\"$4\",\"detail\":\"$5\"}" >> "$LEDGER"
    log "attempt +$1 ($2) -> total $ATTEMPTS/48 :: $5"
    [ "$ATTEMPTS" -lt 48 ] || { log "HARD BUDGET STOP"; exit 10; }
}
record() {
    if [ "$2" = 1 ]; then log "RESULT $1: PASS — $3"; else log "RESULT $1: FAIL — $3"; fi
    printf '%s\n' "{\"ts\":\"$(date -u +%FT%TZ)\",\"name\":\"$1\",\"pass\":$2,\"detail\":\"$3\"}" >> "$VAL_ROOT/results.jsonl"
}
vendor_field() { grep -E "^LIVE_$1_$2=" "$ENV_FILE" | head -1 | cut -d= -f2-; }

# --- recount usage from all jsonl artifacts (correct parser) ---------------
python3 - "$VAL_ROOT" <<'PYEOF'
import glob, json, os, sys
root = sys.argv[1]
rows = []
for path in glob.glob(f"{root}/*.jsonl"):
    if os.path.basename(path) in ("ledger.jsonl", "results.jsonl", "usage.jsonl", "vision-attempts.jsonl"):
        continue
    for line in open(path):
        try:
            ev = json.loads(line)
        except Exception:
            continue
        usage = ev.get("usage") if isinstance(ev, dict) else None
        if usage:
            rows.append({"file": os.path.basename(path),
                         "input": usage.get("input_tokens"),
                         "output": usage.get("output_tokens")})
with open(f"{root}/usage.jsonl", "w") as f:
    for r in rows:
        f.write(json.dumps(r) + "\n")
print(f"usage rows: {len(rows)} in={sum(r['input'] or 0 for r in rows)} out={sum(r['output'] or 0 for r in rows)}")
PYEOF

GLM_CHAT_URL="$(vendor_field GLM CHAT_URL)"
GLM_MODEL="$(vendor_field GLM MODEL)"
GLM_KEY="$(vendor_field GLM API_KEY)"

# --- cancel redo: signal the exec process itself ---------------------------
CANCEL_HOME="$VAL_ROOT/home-cancel2"; CANCEL_WORK="$VAL_ROOT/work-cancel2"
mkdir -p "$CANCEL_HOME" "$CANCEL_WORK"
count_attempt 1 flow GLM chat "cancel mid-stream (redo: direct child signal)"
CODEX_HOME="$CANCEL_HOME" NUWAX_BASE_URL="$GLM_CHAT_URL" NUWAX_MODEL="$GLM_MODEL" \
  NUWAX_WIRE_API=chat NUWAX_API_KEY="$GLM_KEY" NUWAX_MAX_OUTPUT_TOKENS="$MAX_OUT" \
  NUWAX_REQUEST_MAX_RETRIES=1 NUWAX_STREAM_MAX_RETRIES=1 NUWAX_STREAM_IDLE_TIMEOUT_MS=120000 \
  "$CODEX_EXEC_BIN" --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox --json \
  -C "$CANCEL_WORK" "Write a 1500-word essay about lighthouse keeping, with numbered sections." \
  > "$VAL_ROOT/cancel2.jsonl" 2>"$VAL_ROOT/cancel2.err" < /dev/null &
EXEC_PID=$!
SAW_DELTA=0
for _ in $(seq 1 120); do
    if grep -q '"type":"agent_message"' "$VAL_ROOT/cancel2.jsonl" 2>/dev/null; then SAW_DELTA=1; break; fi
    sleep 0.25
done
kill -INT "$EXEC_PID" 2>/dev/null || true
for _ in $(seq 1 40); do kill -0 "$EXEC_PID" 2>/dev/null || break; sleep 0.25; done
kill -KILL "$EXEC_PID" 2>/dev/null || true
wait "$EXEC_PID" 2>/dev/null; CRC=$?
if [ "$SAW_DELTA" = 1 ] && [ $CRC -ne 0 ] && [ -s "$VAL_ROOT/cancel2.jsonl" ]; then
    record main-cancel 1 "interrupted mid-stream (rc=$CRC) after partial output"
else
    record main-cancel 0 "saw_delta=$SAW_DELTA rc=$CRC (see cancel2.err)"
fi

# --- ACP smoke redo: pass DEFAULT_AUTH_REQUEST as a proper export ----------
count_attempt 4 acp GLM chat "acp smoke redo (prompt+compact+follow+load)"
ACP_HOME="$VAL_ROOT/home-acp2"
mkdir -p "$ACP_HOME"
AUTH_JSON="$(python3 -c "
import json, sys
key = sys.argv[1]
print(json.dumps({'methodId': 'api-key', '_meta': {'api-key': {'apiKey': key.strip()}}}))" "$GLM_KEY")"
(
    cd "$REPO"
    export CODEX_HOME="$ACP_HOME" CODEX_PATH="$CODEX_BIN" VAL_ROOT="$VAL_ROOT"
    export NUWAX_BASE_URL="$GLM_CHAT_URL" NUWAX_MODEL="$GLM_MODEL" NUWAX_WIRE_API=chat
    export NUWAX_API_KEY="$GLM_KEY" NUWAX_MAX_OUTPUT_TOKENS="$MAX_OUT"
    export NUWAX_REQUEST_MAX_RETRIES=1 NUWAX_STREAM_MAX_RETRIES=1 NUWAX_STREAM_IDLE_TIMEOUT_MS=120000
    export DEFAULT_AUTH_REQUEST="$AUTH_JSON"
    node --import tsx "$SCRIPT_DIR/acp-live-smoke.ts" > "$VAL_ROOT/acp-smoke2.log" 2>&1
)
if tail -3 "$VAL_ROOT/acp-smoke2.log" | grep -q "SMOKE-PASS"; then
    record acp-smoke 1 "$(tail -1 "$VAL_ROOT/acp-smoke2.log")"
else
    record acp-smoke 0 "$(tail -2 "$VAL_ROOT/acp-smoke2.log" | head -1)"
fi

# --- merged summary ---------------------------------------------------------
python3 - "$VAL_ROOT" "$ATTEMPTS" <<'PYEOF'
import json, os, sys
root, attempts = sys.argv[1], int(sys.argv[2])
rows = [json.loads(l) for l in open(f"{root}/results.jsonl")]
usage = [json.loads(l) for l in open(f"{root}/usage.jsonl")] if os.path.exists(f"{root}/usage.jsonl") else []
passed = sum(1 for r in rows if r["pass"])
failed = sum(1 for r in rows if not r["pass"])
summary = {
    "attemptsLedger": attempts,
    "budget": 48,
    "passed": passed,
    "failed": failed,
    "totalInputTokens": sum((u.get("input") or 0) for u in usage),
    "totalOutputTokens": sum((u.get("output") or 0) for u in usage),
    "rows": rows,
}
open(f"{root}/summary.json", "w").write(json.dumps(summary, indent=2) + "\n")
for r in rows:
    print(f"{'PASS' if r['pass'] else 'FAIL'}  {r['name']}: {r['detail']}")
print(f"summary: {passed} passed / {failed} failed; ledger {attempts}/48; tokens in={summary['totalInputTokens']} out={summary['totalOutputTokens']}")
PYEOF
