#!/usr/bin/env bash
# Static, non-destructive contract test for brainstorming background collection.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SKILL_FILE="$REPO_ROOT/skills/brainstorming/SKILL.md"

for required in 'collect-context.mjs' '内部调用统一运行时的 `resolve`' 'identity_status === "external"' 'ambiguous_company_remote' '调用方不能用输入字段' '仓库事实' 'Wiki 历史' 'Agent 推断'; do
  if ! grep -q "$required" "$SKILL_FILE"; then
    echo "[FAIL] brainstorming context contract is missing: $required"
    exit 1
  fi
done

if ! grep -q 'test-brainstorming-context.sh' "$SCRIPT_DIR/suite-helpers.sh"; then
  echo '[FAIL] Claude smoke suite does not include brainstorming context test'
  exit 1
fi

echo 'Claude brainstorming context tests passed'
