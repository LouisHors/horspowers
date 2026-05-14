#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/_repo-guard-common.sh"

repo_root="$(repo_guard_git_root)"
if ! repo_guard_is_horspowers "$repo_root"; then
    exit 0
fi

if ! command -v gh >/dev/null 2>&1; then
    exit 0
fi

if ! git -C "$repo_root" remote get-url origin >/dev/null 2>&1; then
    exit 0
fi

gh repo set-default origin >/dev/null 2>&1 || true

exit 0
