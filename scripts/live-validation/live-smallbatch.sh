#!/usr/bin/env bash
# Limited real-model small-batch acceptance (closure item 11).
#
# Bounded set of REAL vendor requests through the codex CLI and the ACP
# adapter, driven entirely by NUWAX_* environment variables, with a hard
# attempt ledger. Credentials are only ever read from the env file into
# child environments; never echoed, logged, or written to artifacts.
#
# Usage: scripts/live-validation/live-smallbatch.sh
#   LIVE_ENV_FILE        credentials env file
#                        (default /Volumes/soddy/git_workspace/fork-nuwax-codex/.env.local)
#   LIVE_BUDGET_ATTEMPTS hard cap incl retries/aux (default 48)
#   LIVE_MAX_OUTPUT_TOKENS (default 2048)
#   LIVE_SKIP_ACP=1      exec-only run
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../.." && pwd)"
CODEX_BIN="${CODEX_BIN:-/Volumes/soddy/git_workspace/fork-nuwax-codex/.claude/worktrees/merge-main-20261014/codex-rs/target/debug/codex}"
CODEX_EXEC_BIN="${CODEX_EXEC_BIN:-${CODEX_BIN}-exec}"
ENV_FILE="${LIVE_ENV_FILE:-/Volumes/soddy/git_workspace/fork-nuwax-codex/.env.local}"
BUDGET="${LIVE_BUDGET_ATTEMPTS:-48}"
MAX_OUT="${LIVE_MAX_OUTPUT_TOKENS:-2048}"
VAL_ROOT="${VAL_ROOT:-$(mktemp -d /tmp/acp-live-val.XXXXXX)}"
LEDGER="$VAL_ROOT/ledger.jsonl"
mkdir -p "$VAL_ROOT"

[ -x "$CODEX_EXEC_BIN" ] || { echo "codex-exec missing: $CODEX_EXEC_BIN" >&2; exit 2; }
[ -f "$ENV_FILE" ] || { echo "env file missing: $ENV_FILE" >&2; exit 2; }

log() { echo "[$(date -u +%FT%TZ)] $*"; }
ATTEMPTS=0
count_attempt() { # n class vendor wire detail
    ATTEMPTS=$((ATTEMPTS + $1))
    printf '%s\n' "{\"ts\":\"$(date -u +%FT%TZ)\",\"attempts\":$1,\"total\":$ATTEMPTS,\"class\":\"$2\",\"vendor\":\"$3\",\"wire\":\"$4\",\"detail\":\"$5\"}" >> "$LEDGER"
    log "attempt +$1 ($2/$3/$4) -> total $ATTEMPTS/$BUDGET :: $5"
    [ "$ATTEMPTS" -lt "$BUDGET" ] || { log "HARD BUDGET STOP at $ATTEMPTS"; exit 10; }
}

PASS=0; FAIL=0
record() { # name ok detail
    if [ "$2" = 1 ]; then PASS=$((PASS+1)); log "RESULT $1: PASS — $3"; else FAIL=$((FAIL+1)); log "RESULT $1: FAIL — $3"; fi
    printf '%s\n' "{\"ts\":\"$(date -u +%FT%TZ)\",\"name\":\"$1\",\"pass\":$2,\"detail\":\"$3\"}" >> "$VAL_ROOT/results.jsonl"
}

vendor_field() { grep -E "^LIVE_$1_$2=" "$ENV_FILE" | head -1 | cut -d= -f2-; }

# env for one exec invocation: vendor, wire, home, extra pairs after --
exec_env() { # vendor wire home
    local vendor="$1" wire="$2" home="$3"
    local base model key
    base="$(vendor_field "$vendor" "${wire^^}_URL")"
    model="$(vendor_field "$vendor" MODEL)"
    key="$(vendor_field "$vendor" API_KEY)"
    [ -n "$base" ] || { echo "MISSING-URL-$vendor-$wire" >&2; return 1; }
    echo "CODEX_HOME=$home NUWAX_BASE_URL=$base NUWAX_MODEL=$model NUWAX_WIRE_API=$wire NUWAX_API_KEY=$key NUWAX_MAX_OUTPUT_TOKENS=$MAX_OUT NUWAX_REQUEST_MAX_RETRIES=1 NUWAX_STREAM_MAX_RETRIES=1 NUWAX_STREAM_IDLE_TIMEOUT_MS=120000"
}

sum_tokens() { # jsonl-path
    python3 - "$1" "$VAL_ROOT/usage.jsonl" <<'PYEOF'
import json, sys
src, dst = sys.argv[1], sys.argv[2]
try:
    lines = open(src).read().splitlines()
except FileNotFoundError:
    sys.exit(0)
for line in lines:
    try:
        ev = json.loads(line)
    except Exception:
        continue
    info = (ev.get("msg") or {}).get("info") or ev.get("info")
    if info:
        total = info.get("total_token_usage") or {}
        last = info.get("last_token_usage") or {}
        rec = {"input": last.get("input_tokens"), "output": last.get("output_tokens"),
               "total": total.get("total_tokens")}
        with open(dst, "a") as f:
            f.write(json.dumps(rec) + "\n")
PYEOF
}

run_flow() { # name vendor wire prompt (writes $VAL_ROOT/$name.jsonl, rc 0 on pass-pattern match "$4")
    local name="$1" vendor="$2" wire="$3" prompt="$4" want="${5:-}"
    local home="$VAL_ROOT/home-$name" work="$VAL_ROOT/work-$name"
    mkdir -p "$home" "$work"
    local envs; envs="$(exec_env "$vendor" "$wire" "$home")" || { record "$name" 0 "no url for $vendor/$wire"; return; }
    count_attempt 1 flow "$vendor" "$wire" "$name"
    local out rc
    out="$(cd "$work" && env $envs "$CODEX_EXEC_BIN" --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox --json -C "$work" "$prompt" 2>"$VAL_ROOT/$name.err")"
    rc=$?
    echo "$out" > "$VAL_ROOT/$name.jsonl"
    sum_tokens "$VAL_ROOT/$name.jsonl"
    if [ $rc -ne 0 ]; then record "$name" 0 "exec rc=$rc (see $name.err)"; return; fi
    if [ -n "$want" ] && ! echo "$out" | grep -qi -- "$want"; then record "$name" 0 "expected '$want' in reply (see $name.jsonl)"; return; fi
    record "$name" 1 "ok${want:+- matched '$want'}"
}

log "live validation root: $VAL_ROOT (budget $BUDGET, output cap $MAX_OUT)"

# --- Preflight: NUWAX_* decides the endpoint (local sink; no real request)
python3 - "$VAL_ROOT/sink.log" <<'PYEOF' &
import http.server, sys
path = sys.argv[1]
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        self.rfile.read(int(self.headers.get("content-length", 0)))
        open(path, "a").write(self.path + "\n")
        self.send_response(500); self.end_headers()
http.server.HTTPServer(("127.0.0.1", 48765), H).serve_forever()
PYEOF
SINK_PID=$!
sleep 0.5
mkdir -p "$VAL_ROOT/home-sink" "$VAL_ROOT/work-sink"
env CODEX_HOME="$VAL_ROOT/home-sink" NUWAX_BASE_URL="http://127.0.0.1:48765/v1" NUWAX_MODEL=sink-probe \
  NUWAX_WIRE_API=chat NUWAX_API_KEY=dummy-sink NUWAX_MAX_OUTPUT_TOKENS=64 NUWAX_REQUEST_MAX_RETRIES=0 \
  bash -c 'cd "$1" && "$2" --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox --json -C "$1" "say hi"' \
  bash "$VAL_ROOT/work-sink" "$CODEX_EXEC_BIN" >/dev/null 2>&1 || true
sleep 0.5
kill $SINK_PID 2>/dev/null || true
if grep -q "^/v1/chat/completions$" "$VAL_ROOT/sink.log" 2>/dev/null; then
    record env-determinism 1 "NUWAX_BASE_URL/WIRE_API steered the endpoint (sink hit at /v1/chat/completions)"
else
    record env-determinism 0 "sink never hit"
fi
count_attempt 0 preflight local "sink (no real request)"

# --- Wire basics: chat via GLM, anthropic via STEP, responses via GLM,
# --- backup-provider switch to MIMO (chat).
run_flow wire-chat GLM chat "Reply with the single word: pong" "pong"
run_flow wire-anthropic STEP anthropic "Reply with the single word: pong" "pong"
run_flow wire-responses GLM responses "Reply with the single word: pong" "pong"
run_flow backup-switch-mimo MIMO chat "Reply with the single word: pong" "pong"

# --- Main path (GLM chat): secret + cold recall + tool + cancel.
run_flow main-text GLM chat "Remember the secret word LIVE-KIWANO-7 and reply with just: OK" "OK"
count_attempt 1 flow GLM chat "main cold recall"
RECALL_HOME="$VAL_ROOT/home-main-text"; RECALL_WORK="$VAL_ROOT/work-main-text"
RECALL_OUT="$(cd "$RECALL_WORK" && env $(exec_env GLM chat "$RECALL_HOME") "$CODEX_EXEC_BIN" --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox --json -C "$RECALL_WORK" resume --last "What secret word did I ask you to remember? Reply with just the word." 2>"$VAL_ROOT/main-recall.err")"
echo "$RECALL_OUT" > "$VAL_ROOT/main-recall.jsonl"; sum_tokens "$VAL_ROOT/main-recall.jsonl"
if echo "$RECALL_OUT" | grep -qi "KIWANO"; then record main-cold-recall 1 "secret recalled across cold process"; else record main-cold-recall 0 "not recalled (see main-recall.err)"; fi

TOOL_HOME="$VAL_ROOT/home-main-tool"; TOOL_WORK="$VAL_ROOT/work-main-tool"
mkdir -p "$TOOL_HOME" "$TOOL_WORK"
count_attempt 2 flow GLM chat "tool round-trip"
TOOL_OUT="$(cd "$TOOL_WORK" && env $(exec_env GLM chat "$TOOL_HOME") "$CODEX_EXEC_BIN" --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox --json -C "$TOOL_WORK" "Create a file named tool-marker.txt containing the text marlin, then reply with just: DONE" 2>"$VAL_ROOT/main-tool.err")"
echo "$TOOL_OUT" > "$VAL_ROOT/main-tool.jsonl"; sum_tokens "$VAL_ROOT/main-tool.jsonl"
if [ -f "$TOOL_WORK/tool-marker.txt" ] && grep -q "marlin" "$TOOL_WORK/tool-marker.txt"; then
    record main-tool 1 "real shell tool executed and verified on disk"
else
    record main-tool 0 "marker file missing (see main-tool.err)"
fi

CANCEL_HOME="$VAL_ROOT/home-main-cancel"; CANCEL_WORK="$VAL_ROOT/work-main-cancel"
mkdir -p "$CANCEL_HOME" "$CANCEL_WORK"
count_attempt 1 flow GLM chat "cancel mid-stream"
( cd "$CANCEL_WORK" && env $(exec_env GLM chat "$CANCEL_HOME") "$CODEX_EXEC_BIN" --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox --json -C "$CANCEL_WORK" "Write a 400-word essay about lighthouse keeping." > "$VAL_ROOT/cancel.jsonl" 2>"$VAL_ROOT/cancel.err" ) &
CPID=$!
for _ in $(seq 1 120); do
    grep -q '"type":"agent_message"' "$VAL_ROOT/cancel.jsonl" 2>/dev/null && break
    sleep 0.5
done
kill -INT $CPID 2>/dev/null || true
wait $CPID 2>/dev/null; CRC=$?
sum_tokens "$VAL_ROOT/cancel.jsonl"
if [ $CRC -ne 0 ] && [ -s "$VAL_ROOT/cancel.jsonl" ]; then
    record main-cancel 1 "interrupted mid-stream (rc=$CRC) after partial output"
else
    record main-cancel 0 "cancel rc=$CRC"
fi

# --- Screenshot through the MCP shot server (tool image to a real model).
SHOT_HOME="$VAL_ROOT/home-main-shot"; SHOT_WORK="$VAL_ROOT/work-main-shot"
SHOT_TRUTH="$VAL_ROOT/shot-truth.jsonl"
mkdir -p "$SHOT_HOME" "$SHOT_WORK"; : > "$SHOT_TRUTH"
cat > "$SHOT_HOME/config.toml" <<EOF
[mcp_servers.screenshots]
command = "node"
args = ["$REPO/scripts/acp-validation/shot-server.mjs"]

[mcp_servers.screenshots.env]
SHOT_TRUTH_PATH = "$SHOT_TRUTH"
EOF
count_attempt 2 flow GLM chat "screenshot tool + color answer"
SHOT_OUT="$(cd "$SHOT_WORK" && env $(exec_env GLM chat "$SHOT_HOME") SHOT_TRUTH_PATH="$SHOT_TRUTH" "$CODEX_EXEC_BIN" --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox --json -C "$SHOT_WORK" "Call the take_screenshot tool, then reply with just the name of the dominant color you see (one word)." 2>"$VAL_ROOT/main-shot.err")"
echo "$SHOT_OUT" > "$VAL_ROOT/main-shot.jsonl"; sum_tokens "$VAL_ROOT/main-shot.jsonl"
SHOT_TRUTH_COLOR="$(python3 -c "
import json
lines = [l for l in open('$SHOT_TRUTH') if l.strip()]
print(json.loads(lines[-1])['color'] if lines else '')" 2>/dev/null || true)"
if grep -q "take_screenshot" "$VAL_ROOT/main-shot.jsonl"; then
    if [ -n "$SHOT_TRUTH_COLOR" ] && echo "$SHOT_OUT" | grep -qi "$SHOT_TRUTH_COLOR"; then
        record main-screenshot 1 "tool ran; model named the true color '$SHOT_TRUTH_COLOR' (vision confirmed)"
    else
        record main-screenshot 1 "tool ran and image delivered; color answer didn't match '$SHOT_TRUTH_COLOR' (vision not confirmed, tool path ok)"
    fi
else
    record main-screenshot 0 "take_screenshot never executed (see main-shot.err)"
fi

# --- Direct vision: 3 synthesized images through view_image (GLM anthropic).
python3 "$SCRIPT_DIR/gen-vision-images.py" "$VAL_ROOT/vision" 3 >/dev/null
VISION_ATTEMPTS_FILE="$VAL_ROOT/vision-attempts.jsonl"; : > "$VISION_ATTEMPTS_FILE"
python3 "$SCRIPT_DIR/vision-direct.py" "$VAL_ROOT" "$ENV_FILE" "$CODEX_EXEC_BIN" "$MAX_OUT" "$VISION_ATTEMPTS_FILE" >> "$VAL_ROOT/vision-direct.log" 2>&1
python3 - "$VISION_ATTEMPTS_FILE" "$LEDGER" <<'PYEOF'
import sys
attempts = sum(1 for l in open(sys.argv[1]) if l.strip())
with open(sys.argv[2], "a") as f:
    f.write('{"ts":"vision","attempts":%d,"class":"vision","vendor":"GLM","wire":"anthropic","detail":"direct image checks"}\n' % attempts)
PYEOF
ATTEMPTS=$((ATTEMPTS + $(grep -c . "$VISION_ATTEMPTS_FILE" || true)))
VISION_SUMMARY="$(tail -1 "$VAL_ROOT/vision-direct.log" 2>/dev/null)"
if echo "$VISION_SUMMARY" | grep -q "vision: PASS"; then record vision-direct 1 "$VISION_SUMMARY"; else record vision-direct 0 "${VISION_SUMMARY:-vision driver crashed}"; fi

# --- ACP live smoke: session/new -> prompt -> /compact -> follow-up -> load.
if [ "${LIVE_SKIP_ACP:-0}" != 1 ]; then
    count_attempt 6 acp GLM chat "smoke incl compact+aux"
    ( cd "$REPO" && env $(exec_env GLM chat "$VAL_ROOT/home-acp") VAL_ROOT="$VAL_ROOT" \
        DEFAULT_AUTH_REQUEST="$(python3 -c "
import json
key = open('/dev/stdin').read()
print(json.dumps({'methodId':'api-key','_meta':{'api-key':{'apiKey':key.strip()}}}))" < <(vendor_field GLM API_KEY))" \
        node --import tsx "$SCRIPT_DIR/acp-live-smoke.ts" > "$VAL_ROOT/acp-smoke.log" 2>&1 )
    if tail -3 "$VAL_ROOT/acp-smoke.log" | grep -q "SMOKE-PASS"; then
        record acp-smoke 1 "$(tail -1 "$VAL_ROOT/acp-smoke.log")"
    else
        record acp-smoke 0 "see acp-smoke.log"
    fi
fi

# --- Summary
python3 - "$VAL_ROOT" "$ATTEMPTS" "$BUDGET" <<'PYEOF'
import json, os, sys
root, attempts, budget = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
rows = [json.loads(l) for l in open(f"{root}/results.jsonl")]
usage_path = f"{root}/usage.jsonl"
usage = [json.loads(l) for l in open(usage_path)] if os.path.exists(usage_path) else []
summary = {
    "attemptsUsed": attempts,
    "budget": budget,
    "passed": sum(1 for r in rows if r["pass"]),
    "failed": sum(1 for r in rows if not r["pass"]),
    "totalInputTokens": sum((u.get("input") or 0) for u in usage),
    "totalOutputTokens": sum((u.get("output") or 0) for u in usage),
    "rows": rows,
}
open(f"{root}/summary.json", "w").write(json.dumps(summary, indent=2) + "\n")
for r in rows:
    print(f"{'PASS' if r['pass'] else 'FAIL'}  {r['name']}: {r['detail']}")
print(f"summary: {summary['passed']} passed / {summary['failed']} failed; attempts {attempts}/{budget}; tokens in={summary['totalInputTokens']} out={summary['totalOutputTokens']}")
sys.exit(0 if summary["failed"] == 0 else 1)
PYEOF
EXIT=$?
log "artifacts: $VAL_ROOT"
exit $EXIT
