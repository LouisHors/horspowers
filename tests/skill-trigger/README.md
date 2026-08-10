# Skill Trigger Evaluation

This directory defines the baseline assets for evaluating skill-trigger behavior across Claude Code and Codex.

## Purpose

Use this test harness to answer the same questions for both hosts:

- Did the host trigger a skill for a given user message?
- Did it trigger the expected skill?
- Did it miss, over-trigger, or choose the wrong skill?
- Did the result differ between Claude Code and Codex?

## Scope

The first evaluation pass focuses on core workflow and routing skills whose boundaries are easy to confuse:

- `brainstorming`
- `writing-plans`
- `executing-plans`
- `subagent-driven-development`
- `systematic-debugging`
- `test-driven-development`
- `requesting-code-review`
- `document-management`

## Files

- `corpus.yaml`: prompt corpus shared by both hosts
- `rubric.md`: scoring rules and labeling guidance
- `claude/startup-v1.md`: baseline Claude Code startup profile for trigger evaluation
- `codex/startup-v1.md`: baseline Codex startup profile for trigger evaluation
- `runs/baseline-template.yaml`: blank run record for one evaluation pass
- `runs/README.md`: how to name and store run results
- `scripts/evaluate_router.mjs`: deterministic corpus schema and router evaluation
- `host_trace_parser.rb`: Codex JSONL and Claude stream-json trace parser
- `run_full_baseline.rb`: host runner that preserves every run artifact and fixture

## Evaluation Workflow

1. Choose one startup profile per host.
2. Use the same `corpus.yaml` prompts against Claude Code and Codex.
3. Validate the corpus and deterministic router before calling either host:

   ```bash
   node tests/skill-trigger/scripts/evaluate_router.mjs --validate-only
   node tests/skill-trigger/scripts/evaluate_router.mjs
   ```

4. Record one result row per prompt in a copy of `runs/baseline-template.yaml`.
5. Score each result with the rubric in `rubric.md`.
6. Summarize positive/negative totals, exact, acceptable, miss, wrong, `no-trigger-expected`,
   `over_trigger_count`, `over_trigger_rate`, `direct_without_tools`, and host-divergence rates.
7. Decide the next experiment layer from the scored results:
   - both hosts miss -> inspect shared `SKILL.md` descriptions first
   - only Claude misses or over-triggers -> inspect Claude startup guidance first
   - only Codex misses or over-triggers -> inspect Codex startup guidance first
   - both hosts route to the same wrong skill -> inspect overlapping or overly broad descriptions first
8. Change only one layer before the next run:
   - shared `SKILL.md` descriptions
   - Claude-specific startup guidance
   - Codex-specific startup guidance

## Iteration Order

Use the same layering order for every A/B cycle:

1. baseline: change nothing; only measure current behavior
2. description tuning: adjust shared skill descriptions only
3. Claude host tuning: revert to the chosen shared baseline, then adjust Claude startup guidance only
4. Codex host tuning: revert to the chosen shared baseline, then adjust Codex startup guidance only

Do not tune multiple layers in the same comparison run.

## Guardrails

- Keep the prompt corpus identical across hosts for comparison.
- Record startup profile version, host, model, and skill commit for every run.
- Do not change multiple layers between adjacent runs if the goal is attribution.
- Treat host-specific startup guidance as a controlled variable, not hidden context.
- The 48 original positive IDs are immutable. The corpus also contains at least 24 negative cases:
  six each for self-contained text transformation, calculation/conversion, short explanation, and
  command syntax; project-term boundary cases must remain `uncertain`.
- `run_full_baseline.rb` never changes a real home or native skill directory. It creates a unique,
  preserved artifact root, fake HOME, and Git fixture per host run. Route-only mode sends the host
  the current worktree's absolute `route-request.mjs` path and a pre-written JSON stdin file.
- Do not delete, overwrite, or reuse a prior artifact directory. The runner uses exclusive output
  creation and fails if its calculated artifact root already exists.

## Local Deterministic Checks

```bash
ruby tests/skill-trigger/test_host_trace_parser.rb
node tests/workflow-router/benchmark.mjs
```

The benchmark runs 100 independent router processes, includes the first cold process, reports P50,
P95, max and environment metadata, and fails when P95 exceeds 150 ms. Its fake HOME and Git fixture
are intentionally preserved for inspection.

## Notes

This directory is documentation-first, but it now includes a maintained corpus and run template. Automation may evolve separately; the evaluation contract lives in these files.
