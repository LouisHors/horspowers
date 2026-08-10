#!/usr/bin/env bash
# Thin SessionEnd wrapper. All document decisions live in the shared runtime.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
exec node "$SCRIPT_DIR/../lib/session-hook-runtime.mjs" session-end
