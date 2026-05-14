#!/usr/bin/env bash

repo_guard_git_root() {
    git rev-parse --show-toplevel 2>/dev/null || true
}

repo_guard_is_horspowers() {
    local repo_root="$1"

    if [[ -z "$repo_root" ]]; then
        return 1
    fi

    if [[ ! -f "$repo_root/plugin.json" || ! -d "$repo_root/skills" ]]; then
        return 1
    fi

    local origin_url=""
    origin_url="$(git -C "$repo_root" remote get-url origin 2>/dev/null || true)"
    if [[ "$origin_url" != *"horspowers"* ]]; then
        return 1
    fi

    return 0
}
