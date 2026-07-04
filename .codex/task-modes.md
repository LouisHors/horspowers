# Codex Task Modes

## /codex plan

Analyze the issue and reply with:

- Problem summary
- Proposed approach
- Affected files or areas
- Risks
- Verification plan

Do not edit code, commit, push, or open a pull request.

## /codex implement

Implement the requested change.

Rules:

- Keep the diff minimal.
- Follow `.codex/agent-policy.md`.
- Run relevant checks from `.codex/verification.md`.
- Open a pull request.
- Do not merge automatically.

## /codex fix-ci

Inspect failing logs or checks from a pull request comment.

Rules:

- Make the smallest fix that addresses the failure.
- Prefer updating an existing PR branch when available.
- Run the relevant failing check locally in the runner when possible.
- Open or update a pull request.
- Do not merge automatically.
