#!/usr/bin/env bash
# 54-round stress validation (closure-plan item 7, hardened per review
# items 6 and 8). Runs the fixed 18-round table per wire (54 total:
# 5 text, 4 tool-image, 2 cancel-before-headers, 2 cancel-mid-stream,
# 1 cancel-during-tool, 2 compact, 2 cold-restart) against one codex
# binary, one persistent app-server per wire for non-cold rounds.
# Tool-image rounds are ground-truth verified against the shot server's
# color palette; cancels must prove their precondition before cancelling;
# probe failures and surviving tracked PIDs fail the run.
#
# Usage:
#   scripts/acp-validation/run-stress.sh /path/to/codex [expected-sha256] [wire]
# Wire defaults to chat; pass a wire or ALL to loop chat,responses,anthropic.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../.." && pwd)"

CODEX_PATH="${1:-${CODEX_PATH:-}}"
EXPECT_SHA="${2:-${EXPECT_CODEX_SHA256:-}}"
WIRE_SCOPE="${3:-${VAL_WIRE:-chat}}"
if [ -z "$CODEX_PATH" ] || [ ! -x "$CODEX_PATH" ]; then
    echo "CODEX_PATH missing or not executable: '${CODEX_PATH}'" >&2
    echo "usage: $0 /path/to/codex [expected-sha256] [wire|ALL]" >&2
    exit 2
fi

case "$(uname -s)" in
    Darwin) SHA_CMD="shasum -a 256" ;;
    *) SHA_CMD="sha256sum" ;;
esac
ACTUAL_SHA="$($SHA_CMD "$CODEX_PATH" | awk '{print $1}')"
echo "codex binary: $CODEX_PATH sha256: $ACTUAL_SHA"
if [ -n "$EXPECT_SHA" ] && [ "$ACTUAL_SHA" != "$EXPECT_SHA" ]; then
    echo "sha256 receipt mismatch: expected $EXPECT_SHA, got $ACTUAL_SHA — refusing to start" >&2
    exit 3
fi

if [ "$WIRE_SCOPE" = "ALL" ]; then
    OVERALL=0
    for WIRE in chat responses anthropic; do
        "$0" "$CODEX_PATH" "$EXPECT_SHA" "$WIRE" || OVERALL=1
    done
    exit "$OVERALL"
fi

VAL_ROOT="${VAL_ROOT:-$(mktemp -d /tmp/acp-val-stress.XXXXXX)}"
MOCK_RECORD_PATH="$VAL_ROOT/mock-record.jsonl"
# Fresh ground-truth file per run: shot-server appends
# {ts, mcpCallId, color, event:start|complete} records the driver verifies
# tool-image rounds against.
SHOT_TRUTH_PATH="$VAL_ROOT/shot-truth.jsonl"
MOCK_PORT="${MOCK_PORT:-47713}"
export MOCK_RECORD_PATH MOCK_PORT SHOT_TRUTH_PATH
: > "$MOCK_RECORD_PATH"
: > "$SHOT_TRUTH_PATH"
export VAL_ROOT
export VAL_BASE_URL="http://127.0.0.1:${MOCK_PORT}/v1"
export VAL_MODEL="acp-val-mock-model"
export ACP_VAL_MOCK_API_KEY="acp-val-dummy-key-not-a-credential"
export VAL_ENV_KEY="ACP_VAL_MOCK_API_KEY"
export VAL_WIRE="$WIRE_SCOPE"
export SHOT_TAKE_MS="${SHOT_TAKE_MS:-5000}"
export MOCK_STATS_URL="http://127.0.0.1:${MOCK_PORT}/stats"
export MOCK_MAX_REQUESTS="${MOCK_MAX_REQUESTS:-160}"
export MOCK_TOOL_BUDGET="${MOCK_TOOL_BUDGET:-12}"
export CODEX_PATH

node "$SCRIPT_DIR/mock-vendor-server.mjs" > "$VAL_ROOT/mock-server.log" 2>&1 &
MOCK_PID=$!
cleanup() { kill "$MOCK_PID" 2>/dev/null || true; }
trap cleanup EXIT
MOCK_READY=0
for _ in $(seq 1 50); do
    if curl --fail -s -o /dev/null "http://127.0.0.1:${MOCK_PORT}/health" 2>/dev/null; then
        MOCK_READY=1
        break
    fi
    if ! kill -0 "$MOCK_PID" 2>/dev/null; then
        echo "mock vendor server died:" >&2
        cat "$VAL_ROOT/mock-server.log" >&2
        exit 4
    fi
    sleep 0.2
done
if [ "$MOCK_READY" -ne 1 ]; then
    echo "mock vendor did not become ready" >&2
    exit 4
fi

echo "=== stress wire: $VAL_WIRE root: $VAL_ROOT ========================="
cd "$REPO"
node --import tsx "$SCRIPT_DIR/stress-50.ts"
EXIT=$?
echo "stress artifacts under: $VAL_ROOT"
exit "$EXIT"
