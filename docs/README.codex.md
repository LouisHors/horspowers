# Horspowers for Codex

Guide for using Horspowers with Codex through native skill discovery.

## Quick Install

Tell Codex:

```text
Fetch and follow instructions from https://raw.githubusercontent.com/LouisHors/horspowers/refs/heads/main/.codex/INSTALL.md
```

## Manual Installation

### Prerequisites

- Codex with native skills support
- Git

### Steps

1. Clone the repo:
   ```bash
   git clone https://github.com/LouisHors/horspowers.git ~/.codex/horspowers
   ```

2. Expose the skills to Codex:
   ```bash
   mkdir -p ~/.agents/skills
   ln -s ~/.codex/horspowers/skills ~/.agents/skills/horspowers
   ```

3. Restart Codex.

### Windows

Use a junction instead of a symlink:

```powershell
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.agents\skills"
cmd /c mklink /J "$env:USERPROFILE\.agents\skills\horspowers" "$env:USERPROFILE\.codex\horspowers\skills"
```

## How It Works

Codex scans `~/.agents/skills/` at startup. By exposing the repository's
`skills/` directory as `~/.agents/skills/horspowers`, the built-in skill loader
can discover Horspowers without requiring a bootstrap shell command.

Primary path:

```text
~/.agents/skills/horspowers -> ~/.codex/horspowers/skills
```

Legacy compatibility files still exist under `.codex/`, but they are no longer
the recommended entrypoint.

After native discovery first loads `horspowers:using-horspowers`, its local
router may idempotently add a versioned managed block to
`~/.codex/AGENTS.md`. This is not a manual bootstrap requirement: it preserves
all text outside the managed markers and only updates the marker content after
creating a backup. If markers are duplicated, incomplete, or nested, repair
them manually; Horspowers intentionally refuses to overwrite ambiguous user
content.

## 公司项目 Wiki 外置文档

已确认的公司 Git 项目可从个人 Wiki 精确读取权威配置和已入库文档，并将所有文档变更投稿到 Inbox。它不会把公司项目的配置或 Horspowers `docs/` 写回仓库：Registry、qmd、SSH、manifest 或 Inbox 任一环节不可用时，文档持久化会安全停止而不会回退本地模式。

宿主级 bootstrap 必须由用户人工安装；待审核投稿也不等于已入库。本机审核、Wiki 入库和 `qmd update` 仍由用户负责。机器块、唯一 `auto_submit` 开关、故障状态与只读 smoke 边界见 [公司项目 Wiki 外置配置与文档](wiki-external-documentation.md)。

## Usage

Once installed, Codex can discover and use the skills directly. Typical usage
patterns:

- Mention the skill by name, such as `horspowers:brainstorming`
- Ask for work that matches a skill's description
- Let `using-horspowers` route you into the required workflow

## Tool Mapping

Horspowers skills were originally written against Claude Code tool names. In
Codex, those instructions map to native Codex tools.

See:

- `skills/using-horspowers/references/codex-tools.md`

Key mappings:

- `TodoWrite` -> `update_plan`
- `Task` / subagent dispatch -> `spawn_agent`
- Wait for agent result -> `wait_agent`
- Free completed agent -> `close_agent`
- `Skill` tool -> native skill loading

If your Codex installation gates multi-agent support behind a feature flag,
enable it in `~/.codex/config.toml`:

```toml
[features]
multi_agent = true
```

## Personal Skills

Create your own skills directly under `~/.agents/skills/`:

```bash
mkdir -p ~/.agents/skills/my-skill
```

Then add `~/.agents/skills/my-skill/SKILL.md`:

```markdown
---
name: my-skill
description: Use when [condition] - [what it does]
---

# My Skill
```

Personal skills can coexist with the `horspowers` skill pack.

## Legacy Bootstrap Compatibility

This repository still ships:

- `.codex/superpowers-codex`
- `.codex/superpowers-bootstrap.md`

They exist to help users migrate from the old bootstrap flow and to support
older install guides. Native discovery should be treated as the source of truth.

## Updating

```bash
cd ~/.codex/horspowers && git pull
```

Restart Codex if the session was already open when the update was pulled.

## Troubleshooting

### Skills not showing up

1. Verify the symlink or junction:
   ```bash
   ls -la ~/.agents/skills/horspowers
   ```

   On Windows, a junction or a plain copied directory with the Horspowers
   `SKILL.md` files is also sufficient for local compatibility tests. The
   important requirement is that `~/.agents/skills/horspowers/using-horspowers/SKILL.md`
   exists and is readable.

2. Verify the repo contains skills:
   ```bash
   ls ~/.codex/horspowers/skills
   ```

3. Restart Codex.

### Old bootstrap and native discovery conflict

Do not copy the old full bootstrap into `AGENTS.md`. Native discovery is enough;
the router maintains only its short versioned managed block. If a managed marker
is damaged, repair the marker structure manually rather than replacing content
outside it.

### Multi-agent skills do not dispatch

If a skill references subagents and Codex does not expose `spawn_agent`, enable
multi-agent support if your Codex build requires it. Otherwise execute the task
locally and document the limitation.

## Getting Help

- Horspowers issues: https://github.com/LouisHors/horspowers/issues
- Upstream project: https://github.com/obra/superpowers
