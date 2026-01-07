# Superpowers for Cursor (via MCP)

Complete guide for using Superpowers with Cursor and other MCP-compatible AI coding tools.

## Quick Install

```bash
# Clone the repository
git clone https://github.com/obra/superpowers.git ~/.superpowers
cd ~/.superpowers

# Checkout MCP branch
git checkout lh-feature-mcp

# Install dependencies
cd mcp
npm install
```

## Configure Cursor

Create or edit `~/.cursor/mcp_config.json`:

**macOS/Linux:**

```json
{
  "mcpServers": {
    "superpowers": {
      "command": "node",
      "args": ["/Users/YOUR_USERNAME/.superpowers/mcp/index.js"],
      "env": {
        "SUPERPOWERS_SKILLS_DIR": "/Users/YOUR_USERNAME/.superpowers/skills",
        "SUPERPOWERS_PERSONAL_SKILLS": "/Users/YOUR_USERNAME/.cursor/skills"
      }
    }
  }
}
```

**Windows:**

```json
{
  "mcpServers": {
    "superpowers": {
      "command": "node",
      "args": ["C:\\Users\\YOUR_USERNAME\\.superpowers\\mcp\\index.js"],
      "env": {
        "SUPERPOWERS_SKILLS_DIR": "C:\\Users\\YOUR_USERNAME\\.superpowers\\skills",
        "SUPERPOWERS_PERSONAL_SKILLS": "C:\\Users\\YOUR_USERNAME\\.cursor\\skills"
      }
    }
  }
}
```

> Replace `YOUR_USERNAME` with your actual username.

## Restart Cursor

After configuration, restart Cursor to load the MCP server.

## Usage

### Using Tools

In Cursor chat, you can use the following tools:

```
使用 list_skills 工具查看所有可用技能
```

```
使用 get_skill 工具获取 brainstorming 技能
```

```
使用 search_skills 工具搜索 "debug"
```

### Using Prompts

Use pre-defined prompts to quickly start workflows:

```
使用 session_start prompt
```

```
使用 brainstorm prompt 开始讨论新功能
```

```
使用 tdd prompt 开始测试驱动开发
```

### Browsing Resources

Skills are also available as MCP Resources in Cursor's resource browser:

- `skill://superpowers/brainstorming`
- `skill://superpowers/systematic-debugging`
- `skill://superpowers/test-driven-development`
- And more...

## Available Skills

### Core Workflow Skills

- **brainstorming** - Structured ideation and design exploration
- **systematic-debugging** - 4-phase debugging methodology
- **test-driven-development** - RED-GREEN-REFACTOR cycle
- **writing-plans** - Break tasks into bite-sized steps
- **executing-plans** - Batch execution with checkpoints

### Collaboration Skills

- **subagent-driven-development** - Two-stage review process
- **requesting-code-review** - Pre-review checklist
- **receiving-code-review** - Responding to feedback
- **dispatching-parallel-agents** - Parallel agent coordination

### Git Workflows

- **using-git-worktrees** - Parallel development branches
- **finishing-a-development-branch** - Merge/PR decision workflow

### Meta Skills

- **using-superpowers** - Introduction to skills system
- **writing-skills** - Creating new skills

## Custom Skills

### Personal Skills

Create custom skills in `~/.cursor/skills/`:

```bash
mkdir -p ~/.cursor/skills/my-skill
```

Create `~/.cursor/skills/my-skill/SKILL.md`:

```markdown
---
name: my-skill
description: Use when [condition] - [what it does]
---

# My Skill

[Your skill content here]
```

### Project Skills

Create project-specific skills in `.skills/`:

```bash
mkdir -p .skills/project-skill
```

Create `.skills/project-skill/SKILL.md` with the same format.

## Skill Priority

Skills are resolved with this priority order:

1. **Project skills** (`.skills/`) - Highest priority
2. **Personal skills** (`~/.cursor/skills/`)
3. **Superpowers skills** (`~/.superpowers/skills/`)

## Complete Documentation

For detailed information, see:

- **[mcp/README.md](../mcp/README.md)** - Complete MCP documentation
- **[mcp/CURSOR_SETUP.md](../mcp/CURSOR_SETUP.md)** - Detailed setup guide
- **[mcp/MCP_ARCHITECTURE.md](../mcp/MCP_ARCHITECTURE.md)** - Technical architecture

## Troubleshooting

### Server Not Starting

1. Check Node.js version: `node --version` (needs >= 18.0.0)
2. Verify `mcp_config.json` path and syntax
3. Check Cursor Developer Tools (Help > Toggle Developer Tools)

### Skills Not Found

Use `list_skills` tool to see available skills:

```
使用 list_skills 工具
```

### Debug Mode

Manually start the server to see debug output:

```bash
node ~/.superpowers/mcp/index.js
```

## Updating

```bash
cd ~/.superpowers
git pull
cd mcp
npm install
```

Restart Cursor to apply updates.

## Getting Help

- Report issues: https://github.com/obra/superpowers/issues
- Main documentation: https://github.com/obra/superpowers
- MCP Specification: https://modelcontextprotocol.io

## Comparison with Other Platforms

| Feature | Claude Code | Cursor (MCP) | OpenCode |
|---------|-------------|--------------|----------|
| Skill Loading | `Skill` tool | `get_skill` tool + Resources | `use_skill` tool |
| Auto-inject | SessionStart hook | Prompt (manual) | chat.message hook |
| Configuration | Plugin config | mcp_config.json | Plugin file |

## Next Steps

1. Complete configuration following [mcp/CURSOR_SETUP.md](../mcp/CURSOR_SETUP.md)
2. Try `session_start` prompt to learn the system
3. Use `brainstorm` prompt for your first project
4. Create your own personal skills
5. Explore all available skills with `list_skills`

Happy coding! 🚀
