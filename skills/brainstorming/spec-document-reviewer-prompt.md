# Spec Document Reviewer Prompt Template

Use this template when reviewing a Horspowers design document resolved through the shared document runtime.

**Purpose:** Verify that the complete design is consistent and sufficiently specific for implementation planning without inventing decisions during implementation.

**Use after:** the design was created or updated, then reloaded in full. The reference may be a local runtime path or a Wiki logical ID/URI, but the reviewer must receive the complete document body, not only the reference.

```text
Task tool (general-purpose):
  description: "Review complete design document"
  prompt: |
    You are a design document reviewer for the Horspowers document runtime.
    Verify the complete design body below is ready for implementation planning.

    **Design reference:** [LOCAL_PATH_OR_WIKI_LOGICAL_ID_OR_URI]
    **Complete design body:**
    [FULL_SPEC_CONTENT]

    ## What to Check

    | Category | What to Look For |
    |----------|------------------|
    | Completeness | TODOs, placeholders, "TBD", "deferred definition", "decide later", "to be defined during implementation", incomplete sections |
    | Consistency | Internal contradictions, conflicting requirements |
    | Clarity | Requirements ambiguous enough to cause someone to build the wrong thing, especially implementation-blocking ambiguity about behavior, boundaries, ownership, sequencing, or acceptance criteria |
    | Scope | Focused enough for a single plan — not covering multiple independent subsystems |
    | YAGNI | Unrequested features, over-engineering |

    Treat unresolved implementation-blocking ambiguity as a review issue even if the rest of the document looks reasonable.

    ## Calibration

    Only flag issues that would cause real problems during implementation planning.
    Minor wording improvements, style preferences, and uneven detail are not blockers.

    Approve unless there are serious gaps that would lead to a flawed plan.

    ## Output Format

    ## Spec Review

    **Status:** Approved | Issues Found

    **Issues (if any):**
    - [Section X]: [specific issue] - [why it matters for planning or why it would force implementation-time decision making]

    **Recommendations (advisory, do not block approval):**
    - [suggestions for improvement]
```

If the status is `Issues Found`, fix every blocking issue through the document runtime, reload the complete revised body, and rerun this review. Only an `Approved` rerun can pass the user review gate.
