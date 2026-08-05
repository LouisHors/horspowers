#!/usr/bin/env bash
# Non-destructive SessionStart contract test for fast/slow routing.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
RUN_ROOT="$REPO_ROOT/tests/.artifacts/workflow-router/$(date +%s)-$$-claude-fast-slow"
FAKE_HOME="$RUN_ROOT/home"
PROJECT_ROOT="$RUN_ROOT/project"
OUTPUT="$RUN_ROOT/session-start.json"

mkdir -p "$FAKE_HOME" "$PROJECT_ROOT"

(
  cd "$PROJECT_ROOT"
  HOME="$FAKE_HOME" bash "$REPO_ROOT/hooks/session-start.sh" > "$OUTPUT"
)

node -e '
const fs = require("fs");
const output = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const context = output?.hookSpecificOutput?.additionalContext || "";
for (const required of ["using-horspowers", "route-request.mjs", "<config-needs-init>true</config-needs-init>"]) {
  if (!context.includes(required)) throw new Error(`missing ${required}`);
}
if (context.includes("请选择你的开发模式")) throw new Error("legacy initialization questionnaire remains");
' "$OUTPUT"

if [ -e "$PROJECT_ROOT/.horspowers-config.yaml" ] || [ -e "$PROJECT_ROOT/docs" ] || [ -e "$FAKE_HOME/.claude/CLAUDE.md" ]; then
  echo '[FAIL] SessionStart wrote project or Claude global files'
  exit 1
fi

if ! grep -q 'test-fast-slow-routing.sh' "$SCRIPT_DIR/suite-helpers.sh"; then
  echo '[FAIL] Claude smoke suite does not include fast/slow routing test'
  exit 1
fi

echo 'Claude fast/slow routing tests passed'
