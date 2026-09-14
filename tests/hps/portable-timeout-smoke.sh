#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HELPER="$ROOT/scripts/portable-timeout.sh"

output="$($HELPER 1s -- node -e 'process.stdout.write("stdout\\n"); process.stderr.write("stderr\\n")' 2>&1)"
grep -q 'stdout' <<<"$output"
grep -q 'stderr' <<<"$output"

set +e
$HELPER 20ms -- node -e 'setTimeout(() => {}, 1000)' >/tmp/hps-timeout-smoke.out 2>/tmp/hps-timeout-smoke.err
code=$?
set -e
[[ "$code" -eq 124 ]]
echo "portable timeout shell smoke passed (exit=$code)"
