#!/usr/bin/env bash
# Portable replacement for GNU timeout used by host compatibility runners.
# Keeps child stdout/stderr and GNU-compatible timeout status 124.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$SCRIPT_DIR/../lib/portable-timeout.mjs" "$@"
