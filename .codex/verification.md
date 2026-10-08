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

## Prerequisites

- Node.js is required for the shared runtime, the `hps` CLI and the portable timeout helper.
- Repository context collection prefers `ripgrep` (`rg`) and it is strongly recommended; without it the collector falls back to `git`/`grep`, which is slower and can return fewer results. Install with `brew install ripgrep` or your package manager.
- Host runner scripts use `scripts/portable-timeout.sh`, which delegates to the Node helper, so GNU `timeout` is no longer required. If a test still calls `timeout` directly, install GNU coreutils on macOS.

## Notes

- Run commands from the repository root.
- On an Electron-based Node harness, `process.execPath` can be the Electron binary. The verification runner preserves the `ELECTRON_RUN_AS_NODE` marker so spawned Node profiles still execute; do not strip that variable from the child environment.
- Integration tests are slower and should be run when workflow behavior changes:

```bash
bash tests/integration/run-integration-tests.sh
```

If a command is unavailable or not applicable, explain why in the pull request.
