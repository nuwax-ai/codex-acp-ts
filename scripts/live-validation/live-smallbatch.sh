#!/usr/bin/env bash
# All paid requests pass through the persistent shared loopback budget gateway.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec python3 "$SCRIPT_DIR/live-validation.py" "$@"
