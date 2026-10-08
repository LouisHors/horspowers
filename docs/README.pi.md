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
   cd ~/.local/share/horspowers
   ```

   Then pick one of two update strategies:

   ```bash
   git checkout v4.8.1                       # pinned release (reproducible)
   # or
   git switch main && git pull --ff-only     # track the latest merged work
   ```

2. Declare it as a Pi package (a local path is loaded without copying, so the checkout — not a separate install step — decides which version Pi loads):

   ```bash
   pi install ~/.local/share/horspowers
   ```

   This writes a `packages` entry to `~/.pi/agent/settings.json`. Use `pi install -l ~/.local/share/horspowers` to scope it to one project instead.

3. Register the HPS MCP sidecar:

   ```bash
   pi mcp add hps --exposure direct -- ~/.local/share/horspowers/bin/hps serve --stdio
   pi mcp list
   ```

   Register it in Pi's own `<agent-dir>/mcp.json`, which is where `pi mcp add` writes, rather than in the shared `~/.config/mcp/mcp.json`. `pi mcp list` and the native host probe only read Pi's file, so a shared-only registration makes HPS invisible to both. `--exposure direct` declares the 19 `mcp__hps__*` tools to the model; use `--exposure deferred` if you prefer loading them on demand through tool search. Add `-l` for a project-local `.pi/mcp.json`.

   `pi mcp list` must show `hps` as `connected` with the 19 `hps` tools.

4. Apply it to a running session with `/reload`, or start a new session. `/reload` re-reads MCP servers and skills; if the package still does not appear, start a new session.

### Verify

```bash
pi mcp list --json   # hps: state connected, 19 tools
pi list              # the horspowers package resolves to the installation root
```

Skill discovery is easiest to check from a directory that has nothing to do with Horspowers — the skills come from the user-level package, not from project context:

```bash
cd /tmp && pi --no-session --approve --print "List every horspowers skill you can see. Comma-separated, or NONE."
```

For the full gate, including a real agent tool call:

```bash
node ~/.local/share/horspowers/scripts/run-hps-native-host-probe.mjs \
  --host pi \
  --installation-root ~/.local/share/horspowers \
  --cwd "$PWD" \
  --model <provider>/<model>
```

Exit codes: `0` pass, `2` blocked prerequisite (missing CLI or auth), `1` failed.

### Development setup — track your working copy

If you develop Horspowers itself, point both the package and the MCP server at your working checkout instead of a separate install root. Edits then take effect after `/reload`, with no pull or checkout step:

```bash
pi install /path/to/your/horspowers
pi mcp add hps --exposure direct -- /path/to/your/horspowers/bin/hps serve --stdio
```

The reported skill path is then `<checkout>/skills/<skill>/SKILL.md`, so `<skill dir>/../..` is your checkout and `<checkout>/bin/hps` resolves directly — no symlink in the path, nothing to disambiguate.

Two caveats:

- Whatever branch the checkout is on is what Pi loads. Switching to an experimental branch switches the skills and the MCP sidecar with it.
- Do not also expose the same skills through `~/.agents/skills/`. A symlink such as `~/.agents/skills/horspowers -> <checkout>/skills` makes Pi discover every skill twice, under a second and usually confusing path; the "first discovered wins" rule then decides which copy the model sees. Remove such symlinks before switching to a package.

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

### MCP is not required — pick a channel

`scope_id` binds verified project facts in memory and never survives an `hps call` process. It does not expire only because of time; any change to the bound Git identity, project fingerprint, config/manifest revision, host config digest, or transport digest invalidates it too.

| Channel | Lifetime | Operations available |
|---|---|---|
| `mcp__hps__*` (sidecar) | one session | all 19; one `task_prepare` scope reused across calls, plus the persistent qmd session |
| `hps call` (one-shot) | one process | only operations that do not require `scope_id`: `task_prepare`, `project_snapshot`, `git_preflight`, `diff_snapshot`, `document_resolve`, `runtime_doctor` |

Operations that require `scope_id` (`project_context`, `document_search`, `document_get`, `document_manifest`, `document_verify`, `context_collect`, `verification_run`, `session_*`, `checkpoint_*`, `commit_preview`, `merge_preview`) return `scope_expired` when called from a separate `hps call` process. Without MCP the skills route document reads through the controlled `document-runtime-cli.mjs` compatibility entry instead of inventing a scope.

HPS never writes its runtime state to disk: MCP gives you **session reuse, not persistence**. Durable state lives in the document system (`docs/`) and the Wiki.

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

Pinned release:

```bash
cd ~/.local/share/horspowers && git fetch --tags && git checkout v<new-version>
pi update --extensions
```

Tracking `main`:

```bash
cd ~/.local/share/horspowers && git pull --ff-only
```

A local-path package has no separate install step, so whichever revision the checkout is on is what Pi loads. Run `/reload` (or start a new session) and `pi mcp list` afterwards.

## Troubleshooting

### Skills do not show up

- Run `pi list` and confirm the package is declared.
- Confirm the directory has `skills/<name>/SKILL.md`, not `SKILL.md` at the root.
- Run `/reload` after editing a skill.

### `hps` is missing from `pi mcp list`

- Confirm `<installation root>/bin/hps` exists and is executable; the release must be v4.8.1 or later.
- Confirm `pi mcp list` shows the server and read the reported stderr tail. Check `~/.pi/agent/mcp.log`.
- Confirm the server is registered in Pi's own `<agent-dir>/mcp.json`. A server that only lives in the shared `~/.config/mcp/mcp.json` is read by the adapter but not by `pi mcp list`.
- A project-local `.pi/mcp.json` is only read after project trust is granted.

### `pi mcp list` is connected but the model cannot call `mcp__hps__*`

- Check the exposure. `--exposure direct` declares the tools; `--exposure deferred` requires tool search to load them.
- With `pi-mcp-adapter` installed, `/mcp` opens the adapter panel and can toggle a server between direct and proxy exposure.

### `verification_run` or Wiki reads return `network_required` / `local_process_required`

Capabilities are fail-closed. Provide verified Pi host facts at sidecar startup; HPS will not assume Pi's permissions.

### The probe reports `blocked_prerequisite`

- `prerequisite_cli`: `pi` is not on `PATH` for the probe process.
- `prerequisite_auth`: the borrowed `auth.json` has no usable credential for the `--model` you passed. Pass a model your Pi install can already run.

## Getting Help

Open an issue at <https://github.com/LouisHors/horspowers/issues> with the probe report (`report.json` path is printed in the probe output) and `pi --version`.
