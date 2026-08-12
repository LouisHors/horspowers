# Plan Document Reviewer Prompt Template

Use this template when reviewing a Horspowers implementation plan resolved through the shared document runtime.

**Purpose:** Verify the complete plan is aligned with the approved complete design/spec and specific enough to execute without inventing missing decisions.

**Use after:** the plan and its design/spec were reloaded in full. Each reference may be a local runtime path or a Wiki logical ID/URI, but the reviewer must receive both complete bodies.

```text
Task tool (general-purpose):
  description: "Review complete plan against complete design"
  prompt: |
    You are a plan document reviewer for the Horspowers document runtime.
    Review the complete implementation plan against the complete design/spec body.

    **Plan reference:** [LOCAL_PATH_OR_WIKI_LOGICAL_ID_OR_URI]
    **Complete plan body:**
    [FULL_PLAN_CONTENT]

    **Design/spec reference:** [LOCAL_PATH_OR_WIKI_LOGICAL_ID_OR_URI]
    **Complete design/spec body:**
    [FULL_DESIGN_OR_SPEC_CONTENT]

    ## What to Check

    | Category | What to Look For |
    |----------|------------------|
    | Completeness | TODOs, placeholders, "TBD", "稍后定义", "实现时再定", missing sections, unfinished task steps |
    | Spec Coverage | Design/spec requirements that never appear in the plan, acceptance criteria with no corresponding task, tasks that contradict the design/spec |
    | Executability | Steps missing exact file paths, concrete code direction, commands, expected outcomes, or validation steps |
    | Scope Control | Work that expands beyond the approved design/spec, speculative tasks, over-engineering, unrelated cleanup |
    | Clarity | Instructions ambiguous enough that an implementer could reasonably build the wrong thing or make blocking implementation-time decisions |

    Treat unresolved implementation-blocking ambiguity or missing execution detail as a review issue.

    ## Calibration

    Only flag issues that would block or materially derail implementation.
    Minor wording improvements, stylistic preferences, or optional refinements are not blockers.

    Approve unless there are serious gaps that would cause the implementer to guess.

    ## Output Format

    ## Plan Review

    **Status:** Approved | Issues Found

    **Issues (if any):**
    - [Task X, Step Y or Section]: [specific issue] - [why it blocks or could derail implementation]

    **Recommendations (advisory, do not block approval):**
    - [suggestions for improvement]
```

If the status is `Issues Found`, fix the blocking plan issues through the document runtime, reload both complete bodies, and rerun this review. Only an `Approved` rerun can pass Execution Handoff.
