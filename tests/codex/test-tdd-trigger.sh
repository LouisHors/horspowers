#!/usr/bin/env bash
# Regression test: TDD-first prompts should route to the test-driven-development skill.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CODEX_BIN="${CODEX_BIN:-codex}"
tmp_root=""

# shellcheck source=tests/codex/skill-dir-helper.sh
source "$SCRIPT_DIR/skill-dir-helper.sh"

if [ -n "${AGENTS_SKILLS_DIR:-}" ]; then
  skills_dir="$AGENTS_SKILLS_DIR"
else
  tmp_root="$(mktemp -d)"
  skills_dir="$tmp_root/agents-skills"
fi

echo "--- TDD Trigger ---"

if ! command -v "$CODEX_BIN" >/dev/null 2>&1; then
  echo "  [SKIP] codex CLI not found at: $CODEX_BIN"
  exit 0
fi

ensure_horspowers_skill_dir "$REPO_ROOT" "$skills_dir"

output_file="$(mktemp)"
last_message_file="$(mktemp)"
cleanup() {
  rm -f "$output_file" "$last_message_file"
  if [ -n "$tmp_root" ]; then
    rm -rf "$tmp_root"
  fi
}
trap cleanup EXIT

prompt="先用一个 failing case 把问题固定住，后面实现可以再慢慢补。"

if ! AGENTS_SKILLS_DIR="$skills_dir" timeout 180s "$CODEX_BIN" exec \
  --output-last-message "$last_message_file" "$prompt" >"$output_file" 2>&1; then
  echo "  [FAIL] codex exec did not complete TDD trigger probe"
  sed -n '1,120p' "$output_file"
  exit 1
fi

if [ ! -s "$last_message_file" ]; then
  echo "  [FAIL] Codex did not write a final response for TDD trigger probe"
  echo "  [DIAGNOSTIC] verbose Codex output (first 120 lines):"
  sed -n '1,120p' "$output_file"
  exit 1
fi

if grep -qiE "test-driven-development|测试驱动开发" "$last_message_file"; then
  echo "  [PASS] Codex routes failing-case-first prompt to TDD"
else
  echo "  [FAIL] Codex did not route failing-case-first prompt to TDD"
  sed -n '1,160p' "$last_message_file"
  exit 1
fi

if grep -qiE "brainstorming|头脑风暴" "$last_message_file"; then
  echo "  [FAIL] Codex should not prefer brainstorming for failing-case-first prompt"
  sed -n '1,160p' "$last_message_file"
  exit 1
else
  echo "  [PASS] Codex avoids brainstorming for failing-case-first prompt"
fi
