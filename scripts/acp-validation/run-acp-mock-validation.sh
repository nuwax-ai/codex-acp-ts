#!/usr/bin/env bash
# Credential-free ACP dev integration validation against a codex binary.
#
# Usage:
#   scripts/acp-validation/run-acp-mock-validation.sh /path/to/codex \
#       [expected-sha256]
#
# CODEX_PATH must be passed explicitly (first argument or env) — there is no
# silent default binary, so a stale worktree build can never be mistaken for
# the candidate under test. When a second argument (or EXPECT_CODEX_SHA256)
# is given, the binary's sha256 must match it before anything starts.
#
# The "vendor" is the local mock server; the API key is a dummy value this
# script sets itself. No .env files, real credentials, or real screenshots
# are read anywhere in this path.
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_DIR="$REPO/scripts/acp-validation"

CODEX_PATH="${1:-${CODEX_PATH:-}}"
EXPECT_SHA="${2:-${EXPECT_CODEX_SHA256:-}}"
if [ -z "$CODEX_PATH" ] || [ ! -x "$CODEX_PATH" ]; then
    echo "CODEX_PATH missing or not executable: '${CODEX_PATH}'" >&2
    echo "usage: $0 /path/to/codex [expected-sha256]" >&2
    exit 2
fi

case "$(uname -s)" in
    Darwin) SHA_CMD="shasum -a 256" ;;
    *) SHA_CMD="sha256sum" ;;
esac
ACTUAL_SHA="$($SHA_CMD "$CODEX_PATH" | awk '{print $1}')"
echo "codex binary: $CODEX_PATH"
echo "codex sha256: $ACTUAL_SHA"
if [ -n "$EXPECT_SHA" ] && [ "$ACTUAL_SHA" != "$EXPECT_SHA" ]; then
    echo "sha256 receipt mismatch: expected $EXPECT_SHA, got $ACTUAL_SHA — refusing to start" >&2
    exit 3
fi

VAL_ROOT="$(mktemp -d /tmp/acp-val-mock.XXXXXX)"
MOCK_RECORD_PATH="$VAL_ROOT/mock-record.jsonl"
: > "$MOCK_RECORD_PATH"
export MOCK_RECORD_PATH
export MOCK_PORT="${MOCK_PORT:-47613}"
export VAL_BASE_URL="http://127.0.0.1:${MOCK_PORT}/v1"
export VAL_MODEL="acp-val-mock-model"
export ACP_VAL_MOCK_API_KEY="acp-val-dummy-key-not-a-credential"
export VAL_ENV_KEY="ACP_VAL_MOCK_API_KEY"
export VAL_WIRE="chat"
export CODEX_PATH

node "$SCRIPT_DIR/mock-vendor-server.mjs" > "$VAL_ROOT/mock-server.log" 2>&1 &
MOCK_PID=$!
cleanup() {
    kill "$MOCK_PID" 2>/dev/null || true
}
trap cleanup EXIT

# Wait for the mock to accept connections before driving the agent.
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

cd "$REPO"
node --import tsx "$SCRIPT_DIR/acp-mock-validation-driver.ts"
EXIT=$?
echo "validation artifacts under: $VAL_ROOT"
exit $EXIT
