#!/usr/bin/env bash
# Non-destructive smoke tests for the fast/slow routing entrypoint.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SKILL_FILE="$REPO_ROOT/skills/using-horspowers/SKILL.md"
ROUTER="$REPO_ROOT/skills/using-horspowers/scripts/route-request.mjs"
RUN_ROOT="$REPO_ROOT/tests/.artifacts/workflow-router/$(date +%s)-$$-codex-fast-slow"
FAKE_HOME="$RUN_ROOT/home"
PROJECT_ROOT="$RUN_ROOT/project"
OUTPUT="$RUN_ROOT/router-output.json"

mkdir -p "$FAKE_HOME" "$PROJECT_ROOT"
git -C "$PROJECT_ROOT" init --quiet
git -C "$PROJECT_ROOT" remote add origin https://github.com/example/horspowers-fixture.git

if ! grep -q 'route-request.mjs' "$SKILL_FILE"; then
  echo '[FAIL] using-horspowers does not point to route-request.mjs'
  exit 1
fi

if ! grep -qi 'stdin' "$SKILL_FILE"; then
  echo '[FAIL] using-horspowers does not require stdin input'
  exit 1
fi

for branch in target_skill direct uncertain; do
  if ! grep -q "$branch" "$SKILL_FILE"; then
    echo "[FAIL] using-horspowers is missing $branch handling"
    exit 1
  fi
done

if grep -q '请选择你的开发模式' "$SKILL_FILE"; then
  echo '[FAIL] using-horspowers still contains the initialization questionnaire'
  exit 1
fi

if [ "$(wc -l < "$SKILL_FILE")" -gt 170 ]; then
  echo '[FAIL] using-horspowers is not a short entrypoint'
  exit 1
fi

printf '%s' "{\"schema_version\":1,\"host\":\"codex\",\"cwd\":\"$PROJECT_ROOT\",\"message\":\"使用 horspowers:writing-plans\",\"active_route\":null}" | \
  HOME="$FAKE_HOME" node "$ROUTER" > "$OUTPUT"

node -e '
const fs = require("fs");
const output = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (output.routing.route !== "planning" || output.routing.target_skill !== "horspowers:writing-plans") {
  process.exit(1);
}
' "$OUTPUT"

echo 'Fast/slow routing tests passed'
