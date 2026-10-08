# Horspowers for Pi

Guide for using Horspowers with the Pi coding agent.

Pi differs from Codex and Claude Code in one important way: it has no plugin manifest and no SessionStart hook. Everything Horspowers provides reaches Pi through three ordinary Pi mechanisms — **skills**, **MCP servers**, and **context files** — so nothing is injected behind your back.

## Requirements

- Pi 0.99 or later (`pi --version`)
- Node.js (the `hps` CLI and the portable timeout helper)
- Git (only for the git-package install path)

## Install

### Prerequisites

- Read the [security model](https://github.com/LouisHors/horspowers) of your install: packages can load skills that instruct the model to run tools.

### Steps

1. Get an installation root that contains both `skills/` and `bin/hps`:

   ```bash
   git clone https://github.com/LouisHors/horspowers.git ~/.local/share/horspowers
   cd ~/.local/share/horspowers && git checkout v4.8.0
   ```

2. Declare it as a Pi package (local path — Pi loads it without copying, so `git pull` is the update):

   ```bash
   pi install ~/.local/share/horspowers
   ```

   This writes a `packages` entry to `~/.pi/agent/settings.json`. Use `pi install -l ~/.local/share/horspowers` to scope it to one project instead.

3. Register the HPS MCP sidecar:

   ```bash
   pi mcp add hps -- ~/.local/share/horspowers/bin/hps serve --stdio
   pi mcp list
   ```

   `pi mcp list` must show `hps` as `connected` with the 19 `hps` tools. Pi writes user-level servers to `~/.pi/agent/mcp.json`; add `-l` for a project-local `.pi/mcp.json`.

4. Restart Pi, or run `/reload`.

### Verify

```bash
pi mcp list --json
```

Expect one `hps` server whose `state` is `connected` and whose `tools` array has 19 entries.

## How It Works

| Capability | Pi mechanism | Notes |
|---|---|---|
| Skills | Package `skills/` directory | Pi advertises each skill by name and description and loads `SKILL.md` on demand. |
| HPS tools | MCP server `hps` | `hps serve --stdio`; 19 operations, all scope-checked. |
| Session context | `AGENTS.md` context files | Pi reads `<agent-dir>/AGENTS.md` and project `AGENTS.md`. Horspowers does **not** write these files for Pi. |

Horspowers does not install Pi extensions, does not modify `~/.pi/agent/mcp.json` on its own, and does not create a managed block in your context files. If you want the routing preamble in every session, add it to `AGENTS.md` yourself.

## Agent-first HPS CLI

`bin/hps` is the deterministic execution core. It never takes a shell command, argv payload, or path override from the model.

```bash
# structured call: the request arrives only on stdin
printf '%s' '{"schema_version":1,"request_id":"r1","operation":"runtime_doctor","cwd":"'"$PWD"'","input":{}}' \
  | ~/.local/share/horspowers/bin/hps call

~/.local/share/horspowers/bin/hps version --json
~/.local/share/horspowers/bin/hps doctor --json
~/.local/share/horspowers/bin/hps serve --stdio     # MCP sidecar
```

When the `hps` MCP server is registered, prefer `mcp__hps__*` tools over `hps call`: the sidecar keeps a live scope and a persistent qmd session, while each `hps call` is a one-shot process whose scope does not cross process boundaries.

## Path Resolution

Pi prints the absolute path of every discovered skill. Resolve the installation root from it and never scan for it:

```text
<skill dir>            = ~/.local/share/horspowers/skills/using-horspowers
HPS_INSTALL_ROOT       = ~/.local/share/horspowers
```

```bash
printf '%s' "$HORSPOWERS_ROUTER_INPUT" | "$HPS_INSTALL_ROOT/bin/hps" call
```

Send `"host": "pi"` to the router. See `skills/using-horspowers/references/host-path-resolution.md`.

## Native Host Probe

The probe verifies that Pi can really discover and call HPS, using a **temporary agent directory** so your user-level configuration is never read or written:

```bash
node scripts/run-hps-native-host-probe.mjs \
  --host pi \
  --installation-root /absolute/horspowers \
  --cwd /absolute/project \
  --model <provider>/<model>
```

What it does, and what it deliberately avoids:

- Creates a `mkdtemp` agent directory and writes only that directory's `mcp.json` (with `exposure: "direct"`, so the probe measures the host rather than the model).
- Symlinks your real agent directory's `auth.json` and `models.json` into it. Symlinking reuses your credentials without duplicating the secret on disk; `/absolute/real-agent-dir` can override the source, and `PI_CODING_AGENT_DIR` is honoured first.
- Runs `pi mcp list --json` and `pi --print --mode json` with `PI_CODING_AGENT_DIR` pointed at the temporary directory, so Pi's sessions also stay inside it.
- Exit codes: `0` pass, `2` blocked prerequisite (missing CLI or auth), `1` failed.

A passing probe requires all of: the direct `hps version` / `hps call` / `serve --stdio` MCP handshake to succeed with 19 tools, `pi mcp list` to report `hps` connected with 19 tools, and the agent step to call `mcp__hps__runtime_doctor` successfully.

## Capability Mapping

HPS capabilities are fail-closed. For Pi they stay `false` unless a verified host-facts envelope with `host: "pi"` is supplied at startup:

| Capability | Default | How it becomes true |
|---|---|---|
| `workspace_read` / `workspace_write` | `false` | Verified Pi host facts |
| `external_network` | `false` | Verified Pi host facts (needed for SSH/qmd) |
| `local_process` | `false` | Verified Pi host facts (needed by `verification_run`) |
| `wiki_read` / `wiki_submit` | `false` | Verified Pi host facts |
| `approval_available` | `false` | Verified Pi host facts |
| `persistent_session` | `false` | Only from a verified in-process HPS sidecar |

Because Pi does not ask for approval before every tool call, `approval_available` has no Pi equivalent and should stay `false`.

## Updating

```bash
cd ~/.local/share/horspowers && git fetch --tags && git checkout v<new-version>
pi update --extensions
```

A local-path package has no separate install step, so checking out the new tag is the update. Run `pi mcp list` afterwards.

## Troubleshooting

### Skills do not show up

- Run `pi list` and confirm the package is declared.
- Confirm the directory has `skills/<name>/SKILL.md`, not `SKILL.md` at the root.
- Run `/reload` after editing a skill.

### `hps` is missing from `pi mcp list`

- Confirm `<installation root>/bin/hps` exists and is executable; the release must be v4.8.0 or later.
- Confirm `pi mcp list` shows the server and read the reported stderr tail. Check `~/.pi/agent/mcp.log`.
- A project-local `.pi/mcp.json` is only read after project trust is granted.

### `verification_run` or Wiki reads return `network_required` / `local_process_required`

Capabilities are fail-closed. Provide verified Pi host facts at sidecar startup; HPS will not assume Pi's permissions.

### The probe reports `blocked_prerequisite`

- `prerequisite_cli`: `pi` is not on `PATH` for the probe process.
- `prerequisite_auth`: the borrowed `auth.json` has no usable credential for the `--model` you passed. Pass a model your Pi install can already run.

## Getting Help

Open an issue at <https://github.com/LouisHors/horspowers/issues> with the probe report (`report.json` path is printed in the probe output) and `pi --version`.
