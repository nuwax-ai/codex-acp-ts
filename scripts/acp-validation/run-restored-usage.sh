#!/usr/bin/env bash
# Runner for restored-usage.ts: starts the mock vendor on a fixed port,
# exports the harness env, runs one chat-wire validation, and tears the
# mock down. Mirrors run-stress.sh's mock lifecycle exactly.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../.." && pwd)"
CODEX_PATH="${1:-${CODEX_PATH:-}}"
if [ -z "$CODEX_PATH" ] || [ ! -x "$CODEX_PATH" ]; then
  echo "usage: $0 /path/to/codex" >&2
  exit 2
fi
VAL_ROOT="${VAL_ROOT:-$(mktemp -d /tmp/acp-restored-usage.XXXXXX)}"
MOCK_PORT="${MOCK_PORT:-47791}"
MOCK_RECORD_PATH="$VAL_ROOT/mock-record.jsonl"
export VAL_ROOT MOCK_PORT MOCK_RECORD_PATH
: > "$MOCK_RECORD_PATH"
export VAL_BASE_URL="http://127.0.0.1:${MOCK_PORT}/v1"
export VAL_MODEL="acp-val-mock-model"
export ACP_VAL_MOCK_API_KEY="acp-val-dummy-key-not-a-credential"
export VAL_ENV_KEY="ACP_VAL_MOCK_API_KEY"
export VAL_WIRE="chat"
export MOCK_STATS_URL="http://127.0.0.1:${MOCK_PORT}/stats"
export SHOT_TAKE_MS="5000"
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
echo "=== restored-usage chat wire root: $VAL_ROOT ==="
cd "$REPO"
node --import tsx "$SCRIPT_DIR/restored-usage.ts"
