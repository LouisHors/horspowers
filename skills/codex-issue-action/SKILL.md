---
name: codex-issue-action
description: Use when a repository should let GitHub issues or issue comments trigger Codex through GitHub Actions using an OpenAI API key, especially when the user does not want Codex Cloud @codex integration or fully autonomous evolution.
---

# Codex Issue Action

## Overview

Help a repository accept GitHub Issue or Issue comment commands such as `/codex plan`, `/codex implement`, and `/codex fix-ci`, then run Codex from GitHub Actions with `OPENAI_API_KEY`.

**Core principle:** Issue-driven, API-key authenticated, runner-executed, PR-delivered, human-confirmed.

**Announce at start:** "我正在使用 Codex Issue Action 技能来接入 GitHub Issue 触发 Codex..."

## Fit Check

Use this path when:

- The user has an OpenAI API key and can store it as a GitHub secret.
- The user wants GitHub Issue or Issue comment commands to trigger Codex work.
- The repository should not depend on native `@codex` Codex Cloud integration.
- Codex should create comments or PRs, not merge automatically.

Do not use this as the main path when the user explicitly wants Codex Cloud `@codex` GitHub integration. In that case, explain that it is a different setup path.

## Required Read Order

Read only the reference files needed for the task:

- For repository file layout and `AGENTS.md` behavior, read `references/repository-docs.md`.
- For GitHub Actions command routing and workflow design, read `references/workflow-patterns.md`.
- For permissions, secrets, forks, and human-control boundaries, read `references/security-rules.md`.

Use templates from `templates/` instead of rewriting them from memory.

## Repository Setup Workflow

1. Inspect the target repository:
   - Check whether it is a Git repository.
   - Check whether `AGENTS.md` already exists.
   - Check whether `.codex/` already exists.
   - Check whether `.github/workflows/` already exists.
   - Identify package manager and likely verification commands.

2. Confirm the execution model in the response or plan:
   - Authentication: GitHub secret named `OPENAI_API_KEY`.
   - Optional custom endpoint: GitHub secret named `CODEX_RESPONSES_API_ENDPOINT`.
   - Execution location: GitHub Actions runner.
   - Model calls: OpenAI API.
   - Delivery: Issue comment for planning, PR for code changes.
   - Local device: not required to be online.

3. Add or update repository documentation:
   - Keep `AGENTS.md` short.
   - Add only a reference section to `AGENTS.md`.
   - Put detailed rules under `.codex/`.
   - Never replace unrelated existing `AGENTS.md` content.

4. Add these policy files:
   - `.codex/agent-policy.md`
   - `.codex/task-modes.md`
   - `.codex/verification.md`
   - `.codex/pr-rules.md`

5. Add GitHub Actions workflow:
   - `.github/workflows/codex-issue.yml`
   - Trigger on `issue_comment`.
   - Respond to `/codex plan` and `/codex implement` on issues.
   - Respond to `/codex fix-ci` on pull request comments.
   - Restrict triggering users with an allowlist.
   - Use `openai/codex-action@v1` with `secrets.OPENAI_API_KEY`.
   - Pass `secrets.CODEX_RESPONSES_API_ENDPOINT` to `responses-api-endpoint` for non-default OpenAI-compatible endpoints.
   - Use `permission-profile: ":read-only"` for planning and `permission-profile: ":workspace"` for code changes.
   - Use the default `drop-sudo` safety strategy or set it explicitly.
   - Keep the checkout token from being persisted into the working tree.
   - Post plan output with `actions/github-script`.
   - Create implementation PRs with an explicit PR creation step.
   - Do not auto-merge.

6. Tell the user the remaining GitHub-side setup:
   - Add repository secret `OPENAI_API_KEY`.
   - If using a non-default OpenAI-compatible endpoint, add repository secret `CODEX_RESPONSES_API_ENDPOINT` with the full Responses API URL, for example `https://example.com/v1/responses`.
   - Set the allowed GitHub usernames in the workflow.
   - Enable GitHub Actions to create pull requests if the repository requires that setting.

7. Commit and push the infrastructure changes before asking the user to test:
   - Stage `AGENTS.md`, `.codex/`, `.github/workflows/codex-issue.yml`, and any skill/test files changed in the setup.
   - Commit with a message such as `feat(codex): add issue action workflow`.
   - Push the branch that the repository uses for Actions, usually `main`.
   - GitHub cannot trigger a workflow file that only exists locally.

8. After the workflow file is on GitHub, guide the user through a smoke test:
   - Open a test issue.
   - Comment `/codex plan` first to verify the chain.
   - Check the repository Actions tab for `Codex Issue Action`.
   - Only test `/codex implement` after `/codex plan` succeeds.

## Command Semantics

| Command | Behavior | Writes Code | Expected Output |
| --- | --- | --- | --- |
| `/codex plan` | Analyze a repository issue and propose an implementation approach. | No | Issue comment |
| `/codex implement` | Implement a repository issue with minimal changes and open a PR. | Yes | Pull request |
| `/codex fix-ci` | Inspect a pull request context and make the smallest CI fix. | Yes | Pull request update or new PR |

## Editing Rules

- Use `templates/AGENTS.codex-snippet.md` for the `AGENTS.md` section.
- Use `.codex/verification.md` for project-specific commands; customize this file per repository.
- Keep shared policy language in `.codex/agent-policy.md`, `.codex/task-modes.md`, and `.codex/pr-rules.md`.
- Prefer adding a new workflow file over modifying unrelated CI workflows.
- If existing files conflict with the templates, preserve user content and add the missing Codex-specific pieces.

## Validation

Before saying the setup is complete:

1. Verify all expected files exist.
2. Verify `AGENTS.md` references the `.codex/` documents instead of embedding the full policy.
3. Verify the workflow references `secrets.OPENAI_API_KEY`.
4. Verify the workflow passes `secrets.CODEX_RESPONSES_API_ENDPOINT` to `responses-api-endpoint`.
5. Verify planning uses read-only permissions and `permission-profile: ":read-only"`.
6. Verify code-writing jobs use `permission-profile: ":workspace"`.
7. Verify Codex Action steps use `safety-strategy: drop-sudo` or rely on that default.
8. Verify checkout steps use `persist-credentials: false`.
9. Verify issue or pull request text is treated as untrusted input in prompts.
10. Verify the workflow has an allowlist or equivalent actor check.
11. Verify the workflow does not contain automatic merge behavior.
12. If possible, run YAML or shell syntax checks available in the repository.

## Common Mistakes

- Treating API-key based GitHub Actions as the same thing as Codex Cloud `@codex`.
- Putting all operating rules directly into `AGENTS.md`.
- Allowing any GitHub commenter to trigger code-writing jobs.
- Letting Codex push directly to the default branch.
- Forgetting to tell the user to add `OPENAI_API_KEY` in GitHub Secrets.
- Using a non-default endpoint but forgetting to add `CODEX_RESPONSES_API_ENDPOINT`.
