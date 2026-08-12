#!/usr/bin/env bash
# Smoke tests for Codex document review flow compatibility.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CODEX_BIN="${CODEX_BIN:-codex}"
TIMEOUT_BIN="${TIMEOUT_BIN:-timeout}"
AGENTS_SKILLS_DIR="${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}"

# shellcheck source=tests/codex/skill-dir-helper.sh
source "$SCRIPT_DIR/skill-dir-helper.sh"

echo "--- Document Review Flow ---"

if ! command -v "$CODEX_BIN" >/dev/null 2>&1; then
  echo "  [SKIP] codex CLI not found at: $CODEX_BIN"
  exit 0
fi

if ! command -v "$TIMEOUT_BIN" >/dev/null 2>&1; then
  echo "  [SKIP] timeout command not found at: $TIMEOUT_BIN"
  exit 0
fi

ensure_horspowers_skill_dir "$REPO_ROOT" "$AGENTS_SKILLS_DIR"

output_file="$(mktemp)"
cleanup() {
  rm -f "$output_file"
}
trap cleanup EXIT

if ! "$TIMEOUT_BIN" 180s "$CODEX_BIN" exec "According to the horspowers brainstorming skill and its spec reviewer prompt in this session, a design can be referenced by a local runtime path or a Wiki logical ID/URI. Before the user review gate, what review must occur, must the reviewer receive the complete design body, and what happens after blocking issues are fixed? Answer briefly." >"$output_file" 2>&1; then
  echo "  [FAIL] codex exec did not complete brainstorming review probe"
  sed -n '1,120p' "$output_file"
  exit 1
fi

if grep -qiE "spec-document-reviewer-prompt\.md|structured spec review|结构化.*审查|结构化.*评审|结构化.*[Ss]pec.*[Rr]eview" "$output_file"; then
  echo "  [PASS] Codex sees brainstorming spec review gate"
else
  echo "  [FAIL] Codex did not report brainstorming spec review gate"
  sed -n '1,160p' "$output_file"
  exit 1
fi

if grep -qiE "complete.*design.*body|full.*design|完整.*设计.*正文|完整.*设计.*内容|runtime.*get" "$output_file"; then
  echo "  [PASS] Codex gives reviewer complete design content"
else
  echo "  [FAIL] Codex did not require complete design content for review"
  sed -n '1,160p' "$output_file"
  exit 1
fi

if grep -qiE "before.*user review|user review gate|Only ask for user review after|用户审查.*之前|用户评审.*之前|用户评审前" "$output_file" && \
   grep -qiE "rerun|re-run|run.*again|重新运行.*审查|再次.*审查|重新加载.*完整.*正文.*复审" "$output_file"; then
  echo "  [PASS] Codex preserves review ordering and blocking-issue rerun"
else
  echo "  [FAIL] Codex did not preserve brainstorming review ordering or rerun"
  sed -n '1,160p' "$output_file"
  exit 1
fi

if ! "$TIMEOUT_BIN" 180s "$CODEX_BIN" exec "According to the horspowers writing-plans skill and its plan reviewer prompt in this session, a plan and design can each be referenced by a local runtime path or a Wiki logical ID/URI. Before execution handoff, what review must happen, must the reviewer receive both complete bodies, and what happens after blocking issues are fixed? Answer briefly." >"$output_file" 2>&1; then
  echo "  [FAIL] codex exec did not complete writing-plans review probe"
  sed -n '1,120p' "$output_file"
  exit 1
fi

if grep -qiE "plan-document-reviewer-prompt\.md|plan review gate|Plan Review Gate|计划审查|计划评审" "$output_file"; then
  echo "  [PASS] Codex sees writing-plans review gate"
else
  echo "  [FAIL] Codex did not report writing-plans review gate"
  sed -n '1,160p' "$output_file"
  exit 1
fi

if grep -qiE "complete.*plan.*body|complete.*design.*body|full.*plan|完整.*计划.*正文|完整.*设计.*正文|两份.*完整.*正文|runtime.*get" "$output_file"; then
  echo "  [PASS] Codex gives reviewer complete plan and design content"
else
  echo "  [FAIL] Codex did not require complete plan/design content for review"
  sed -n '1,160p' "$output_file"
  exit 1
fi

if grep -qiE "before.*execution handoff|Only continue when.*Approved|execution handoff.*before|执行交接之前|Approved" "$output_file" && \
   grep -qiE "rerun|re-run|run.*again|重新运行.*审查|再次.*审查|重新加载.*完整.*正文.*复审" "$output_file"; then
  echo "  [PASS] Codex preserves plan approval rule and blocking-issue rerun"
else
  echo "  [FAIL] Codex did not preserve plan review approval rule or rerun"
  sed -n '1,160p' "$output_file"
  exit 1
fi
