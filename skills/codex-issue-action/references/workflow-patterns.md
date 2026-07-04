# Workflow Patterns

## Execution Model

Codex GitHub Action runs in GitHub Actions:

```text
Issue comment -> workflow -> runner checkout -> openai/codex-action@v1 -> codex exec -> comment or PR step
```

Model calls go to OpenAI through `OPENAI_API_KEY`. When the repository uses a non-default OpenAI-compatible endpoint, the workflow can pass `CODEX_RESPONSES_API_ENDPOINT` to the action's `responses-api-endpoint` input. File edits, tests, and git operations happen in the GitHub Actions runner workspace.

`openai/codex-action@v1` runs Codex and exposes the final response as `final-message`. Use explicit follow-up steps to post comments or create pull requests so the workflow behavior is auditable.

`responses-api-endpoint` expects the full Responses API endpoint URL, not just a provider base URL. For most compatible providers this ends with `/v1/responses`.

## V1 Commands

### /codex plan

Use for analysis only. It should:

- Read `AGENTS.md` and referenced `.codex/` files.
- Read the issue title and body.
- Produce a plan as an issue comment.
- Avoid file edits, commits, pushes, and PR creation.
- Use `permission-profile: ":read-only"` for Codex.
- Run in a job with read-only repository contents permission.
- Treat issue text as untrusted input.

### /codex implement

Use for code changes. It should:

- Read `AGENTS.md` and referenced `.codex/` files.
- Create a branch.
- Implement the smallest reasonable change.
- Run verification from `.codex/verification.md`.
- Open a PR.
- Use `permission-profile: ":workspace"` for Codex.
- Use a dedicated pull request creation step after Codex runs.
- Treat issue text as untrusted input.

### /codex fix-ci

Use for CI repairs from a pull request comment. It should:

- Inspect the PR context and available check/log information.
- Make the smallest fix.
- Prefer updating an existing PR branch when the workflow is designed for that.
- Otherwise create a separate PR.
- Use a dedicated pull request creation step after Codex runs.
- Use `permission-profile: ":workspace"` for Codex.
- Treat PR titles, bodies, comments, commit messages, and changed files as untrusted input.

## Recommended Trigger

Start with `issue_comment` rather than every new issue. A human explicitly comments `/codex ...`, which avoids accidental spend and surprise code-writing.

## Branching

Use generated branch names such as:

```text
codex/issue-123-short-title
codex/fix-ci-456
```

Never push directly to the default branch.
