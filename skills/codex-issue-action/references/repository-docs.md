# Repository Documentation Pattern

## Goal

Use `AGENTS.md` as the repository entry point and keep detailed Codex Issue Action rules in `.codex/`.

## Required Files

```text
AGENTS.md
.codex/
  agent-policy.md
  task-modes.md
  verification.md
  pr-rules.md
.github/
  workflows/
    codex-issue.yml
```

## AGENTS.md Rule

`AGENTS.md` must not contain the full policy. It should only direct Codex to read the `.codex/` files before planning or editing code.

If `AGENTS.md` exists, append the snippet from `templates/AGENTS.codex-snippet.md` unless an equivalent section is already present.

If `AGENTS.md` does not exist, create it from the snippet and keep it short.

## .codex Files

- `agent-policy.md`: allowed tasks, restricted tasks, and human confirmation boundaries.
- `task-modes.md`: command semantics for `/codex plan`, `/codex implement`, and `/codex fix-ci`.
- `verification.md`: project-specific install, test, lint, and build commands.
- `pr-rules.md`: PR summary, verification, risk, and rollback requirements.

## Customization

Customize `verification.md` per repository. Keep the other three files mostly stable across projects unless the repository has special risk boundaries.
