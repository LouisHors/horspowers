# Verification

Run relevant commands before opening or updating a pull request.

## Default Commands

Use the smallest set that covers the touched area:

```bash
# Codex compatibility smoke tests
bash tests/codex/run-tests.sh

# Static check for the Codex Issue Action skill
bash tests/codex/test-codex-issue-action-skill.sh

# Claude Code skill tests
bash tests/claude-code/run-skill-tests.sh

# OpenCode compatibility tests
bash tests/opencode/run-tests.sh
```

## Notes

- Run commands from the repository root.
- Some Codex compatibility tests require a `timeout` command. On macOS, install GNU coreutils or run the narrower relevant test if `timeout` is unavailable.
- Integration tests are slower and should be run when workflow behavior changes:

```bash
bash tests/integration/run-integration-tests.sh
```

If a command is unavailable or not applicable, explain why in the pull request.
