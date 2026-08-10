#!/usr/bin/env bash
# Test: document review system behavior across local and Wiki document references.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/test-helpers.sh"

REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

MODE="${1:-green}"

if [ "$MODE" != "green" ]; then
    echo "Usage: $0 green" >&2
    exit 2
fi

echo "=== Test: document review system behavior ==="
echo ""

BRAINSTORMING_SKILL="skills/brainstorming/SKILL.md"
SPEC_REVIEW_PROMPT="skills/brainstorming/spec-document-reviewer-prompt.md"
WRITING_PLANS_SKILL="skills/writing-plans/SKILL.md"
PLAN_REVIEW_PROMPT="skills/writing-plans/plan-document-reviewer-prompt.md"
DESIGN_DOC_REF="a local runtime path or Wiki logical ID/URI"
PLAN_DOC_REF="a local runtime path or Wiki logical ID/URI"

for path in \
    "$BRAINSTORMING_SKILL" \
    "$SPEC_REVIEW_PROMPT" \
    "$WRITING_PLANS_SKILL" \
    "$PLAN_REVIEW_PROMPT"
do
    if [ ! -f "$path" ]; then
        echo "Missing required file: $path" >&2
        exit 1
    fi
done

if ! command -v claude > /dev/null 2>&1; then
    echo "SKIPPED: Claude Code CLI not found"
    exit 0
fi

if ! command -v timeout > /dev/null 2>&1; then
    echo "SKIPPED: timeout command not found; Claude probes were not run"
    exit 0
fi

echo "Test 1: Brainstorming should gate user review on structured spec review..."

output=$(run_claude "Read $BRAINSTORMING_SKILL and $SPEC_REVIEW_PROMPT in the current workspace and answer only from those files. A design is referenced by $DESIGN_DOC_REF. Before the user review gate, what review must happen? Mention the reviewer prompt, local-path-or-Wiki-reference support, whether the reviewer receives the complete design body, and whether blocking issues require rerunning the review." 180)

assert_contains "$output" "spec-document-reviewer-prompt\\.md" "brainstorming references the local spec reviewer prompt"
assert_contains "$output" "local.*path\\|Wiki.*logical\\|logical.*ID\\|URI\\|runtime" "brainstorming accepts local or Wiki document references"
assert_contains "$output" "complete.*design.*body\\|full.*design\\|完整.*设计.*正文\\|完整.*设计.*内容" "brainstorming provides complete design content to reviewer"
assert_contains "$output" "before.*user review\\|before asking the user\\|user review gate\\|Only ask for user review after\\|用户审查.*之前\\|用户评审.*之前\\|用户审查关卡之前\\|先.*用户审查\\|先.*用户评审\\|先让用户检查之前" "spec review happens before user review"
assert_contains "$output" "rerun\\|re-run\\|run.*again\\|until it passes\\|直到.*通过\\|重新运行.*审查\\|再次.*审查" "blocking spec issues force a rerun"

echo ""
echo "Test 2: Spec reviewer should use the documented blocking criteria..."

output=$(run_claude "Read $SPEC_REVIEW_PROMPT in the current workspace and answer only from that file. For a design reviewer using $DESIGN_DOC_REF, name at least four review categories, including one about scope or YAGNI, say whether minor wording or style suggestions block approval, and say what content must be passed to the reviewer." 180)

assert_contains "$output" "Completeness\\|TODO\\|TBD\\|placeholder\\|占位\\|未完成" "spec reviewer checks completeness"
assert_contains "$output" "Consistency\\|contradiction\\|Clarity\\|ambiguity\\|一致性\\|矛盾\\|歧义\\|清晰" "spec reviewer checks consistency or clarity"
assert_contains "$output" "Scope\\|YAGNI\\|over-engineering\\|范围\\|不过度设计\\|过度工程" "spec reviewer checks scope control"
assert_contains "$output" "minor wording\\|style.*not blocker\\|not blockers\\|advisory\\|Approve unless\\|不阻塞\\|建议性" "spec reviewer keeps minor wording as non-blocking"
assert_contains "$output" "complete.*body\\|full.*content\\|完整.*正文\\|完整.*内容" "spec reviewer requires complete design body"

echo ""
echo "Test 3: Writing-plans should gate execution handoff on plan review..."

output=$(run_claude "Read $WRITING_PLANS_SKILL and $PLAN_REVIEW_PROMPT in the current workspace and answer only from those files. A plan and design are each referenced by $PLAN_DOC_REF. Before execution handoff, what must be reviewed? Mention the reviewer prompt, local-path-or-Wiki-reference support, whether the reviewer gets both complete bodies, and the approval rule if blocking issues are found." 180)

assert_contains "$output" "plan-document-reviewer-prompt\\.md" "writing-plans references the local plan reviewer prompt"
assert_contains "$output" "local.*path\\|Wiki.*logical\\|logical.*ID\\|URI\\|runtime" "plan review accepts local or Wiki document references"
assert_contains "$output" "complete.*plan.*body\\|complete.*design.*body\\|full.*plan\\|完整.*计划.*正文\\|完整.*设计.*正文\\|完整.*[Pp]lan.*正文\\|双方.*完整.*正文" "plan reviewer receives complete plan and design bodies"
assert_contains "$output" "Issues Found\\|fix the plan first\\|re-run the review\\|Only continue when.*Approved\\|修复计划\\|重新运行.*审查\\|只有.*Approved.*继续" "plan review blocks execution until approved"

echo ""
echo "Test 4: Plan reviewer should enforce spec coverage and executability..."

output=$(run_claude "Read $PLAN_REVIEW_PROMPT in the current workspace and answer only from that file. For an implementation plan reviewer using $PLAN_DOC_REF, what categories must it check? Mention spec coverage, executability details like exact files or commands, scope control, whether recommendations block approval, and what plan/design content is passed to the reviewer." 180)

assert_contains "$output" "Spec Coverage\\|coverage gaps\\|requirements.*never appear\\|规格覆盖\\|覆盖缺口" "plan reviewer checks spec coverage"
assert_contains "$output" "Executability\\|exact file\\|commands\\|validation\\|expected outcomes\\|可执行性\\|精确文件路径\\|命令\\|验证" "plan reviewer checks executability details"
assert_contains "$output" "Scope Control\\|over-engineering\\|speculative\\|范围控制\\|过度工程\\|推测性任务" "plan reviewer checks scope control"
assert_contains "$output" "Recommendations.*do not block\\|advisory\\|not blockers\\|建议.*不阻塞\\|建议.*不影响批准" "plan reviewer treats recommendations as non-blocking"
assert_contains "$output" "complete.*plan.*body\\|complete.*design.*body\\|full.*content\\|完整.*正文\\|完整.*内容" "plan reviewer requires complete plan and design content"

echo ""
echo "=== All document review system tests passed ==="
