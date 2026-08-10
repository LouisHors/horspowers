#!/usr/bin/env bash
# Non-destructive fallback test for the brainstorming context collector.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
COLLECTOR="$REPO_ROOT/skills/brainstorming/scripts/collect-context.mjs"
NODE_BIN="$(command -v node)"
RUN_ROOT="$REPO_ROOT/tests/.artifacts/workflow-router/$(date +%s)-$$-codex-context"
PROJECT_ROOT="$RUN_ROOT/project"
OUTPUT="$RUN_ROOT/context.json"

mkdir -p "$PROJECT_ROOT"
printf '%s\n' 'needle appears in this tracked fixture.' > "$PROJECT_ROOT/README.md"
git -C "$PROJECT_ROOT" init --quiet
git -C "$PROJECT_ROOT" add README.md

printf '%s' "{\"schema_version\":1,\"cwd\":\"$PROJECT_ROOT\",\"query\":\"needle\",\"wiki_root\":null,\"known_entry_files\":[\"$PROJECT_ROOT/README.md\"]}" | \
  PATH=/usr/bin "$NODE_BIN" "$COLLECTOR" > "$OUTPUT"

node -e '
const fs = require("fs");
const output = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (output.branches.repository.tool !== "git grep -n") throw new Error(`unexpected fallback: ${output.branches.repository.tool}`);
for (const branch of ["wiki", "repository", "git", "entries"]) {
  if (!output.branches[branch]) throw new Error(`missing ${branch} branch`);
}
' "$OUTPUT"

echo 'Codex brainstorming context tests passed'
