#!/usr/bin/env bash
# Retry failed cases in the SAME gateway-backed run; never reset its budget.
set -euo pipefail
: "${VAL_ROOT:?set VAL_ROOT to the gateway-backed live run root}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec python3 "$SCRIPT_DIR/live-validation.py" --resume --only-failed "$@"
