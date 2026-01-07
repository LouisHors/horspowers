# Superpowers MCP Server

将 [Superpowers](https://github.com/obra/superpowers) 技能库转换为 [Model Context Protocol (MCP)](https://modelcontextprotocol.io) 服务器，让 Cursor、VSCode、Windsurf 等 AI 编程工具都能使用 Superpowers 的强大工作流。

## 什么是 Superpowers？

Superpowers 是一个经过实战验证的软件开发技能库，包含：

- **测试驱动开发 (TDD)**: RED-GREEN-REFACTOR 循环
- **系统化调试**: 4 阶段调试方法
- **头脑风暴**: 结构化的需求探索和设计流程
- **代码审查**: 预审查清单和最佳实践
- **计划编写**: 将大任务分解为小步骤
- **Git 工作流**: Worktree 管理、分支完成流程
- 以及更多...

这些技能已在 Claude Code 中广泛使用，现在通过 MCP 扩展到更多工具。

## 快速开始

### 1. 安装

```bash
# 克隆仓库
git clone https://github.com/obra/superpowers.git ~/.superpowers
cd ~/.superpowers

# 切换到 MCP 分支
git checkout lh-feature-mcp

# 安装依赖
cd mcp
npm install
```

### 2. 配置 Cursor

创建或编辑 `~/.cursor/mcp_config.json`：

```json
{
  "mcpServers": {
    "superpowers": {
      "command": "node",
      "args": ["/Users/YOUR_USERNAME/.superpowers/mcp/index.js"]
    }
  }
}
```

> 将 `YOUR_USERNAME` 替换为你的用户名。Windows 用户请使用完整路径，如 `C:\\Users\\...`

### 3. 重启 Cursor 并测试

重启 Cursor 后，在聊天窗口中输入：

```
使用 list_skills 工具查看所有可用技能
```

## 核心功能

### 📚 Resources - 浏览技能文档

在 Cursor 的 Resources 浏览器中直接查看所有技能文档：

- `skill://superpowers/brainstorming`
- `skill://superpowers/systematic-debugging`
- `skill://superpowers/test-driven-development`
- 等等...

### 🛠️ Tools - 操作技能

#### list_skills

列出所有可用技能，支持按来源过滤。

```
列出所有 superpowers 核心技能
```

#### get_skill

获取指定技能的完整内容和使用说明。

```
获取 brainstorming 技能
```

#### search_skills

按关键词搜索技能。

```
搜索与 debug 相关的技能
```

### 🎯 Prompts - 快速启动工作流

使用预定义的 prompts 快速开始常用工作流：

| Prompt | 用途 |
|--------|------|
| `session_start` | 会话启动，了解如何使用技能 |
| `brainstorm` | 头脑风暴新功能或设计 |
| `debug` | 系统化调试问题 |
| `tdd` | 测试驱动开发 |
| `code_review` | 准备代码审查 |
| `write_plan` | 编写详细实施计划 |

使用方式：

```
使用 brainstorm prompt 开始讨论新功能
```

## 技能优先级

Superpowers 支持三层技能系统：

```
项目技能 (.skills/)           ← 最高优先级
    ↓
个人技能 (~/.cursor/skills/)
    ↓
核心技能 (~/.superpowers/skills/) ← 标准技能库
```

创建自定义技能非常简单：

```bash
# 个人技能
mkdir -p ~/.cursor/skills/my-skill
cat > ~/.cursor/skills/my-skill/SKILL.md << 'EOF'
---
name: my-skill
description: 我的自定义技能
---

# 我的技能

[技能内容...]
EOF

# 项目技能
mkdir -p .skills/project-skill
# 创建 .skills/project-skill/SKILL.md
```

## 可用技能

### 核心工作流技能

- **brainstorming**: 头脑风暴 - 通过结构化问答探索需求和设计
- **systematic-debugging**: 系统化调试 - 4 阶段调试方法
- **test-driven-development**: TDD - RED-GREEN-REFACTOR 循环
- **writing-plans**: 编写计划 - 将任务分解为小步骤
- **executing-plans**: 执行计划 - 批量执行并设置检查点

### 协作技能

- **subagent-driven-development**: 子代理驱动开发 - 两阶段审查流程
- **requesting-code-review**: 请求代码审查 - 预审查清单
- **receiving-code-review**: 接收代码审查 - 响应反馈
- **dispatching-parallel-agents**: 并行代理调度

### Git 工作流

- **using-git-worktrees**: Git Worktree - 并行开发分支
- **finishing-a-development-branch**: 完成开发分支 - 合并/PR 决策

### 元技能

- **using-superpowers**: 技能系统介绍
- **writing-skills**: 编写新技能

## 使用示例

### 场景 1: 设计新功能

```
使用 brainstorm prompt
```

AI 会：
1. 了解项目背景
2. 逐步提问细化需求
3. 提出 2-3 种设计方案
4. 分段展示设计，确认理解
5. 生成设计文档

### 场景 2: 调试问题

```
我遇到一个 bug：用户登录后会话立即失效
请使用系统化调试流程
```

AI 会：
1. **理解阶段**: 复现问题，收集信息
2. **假设阶段**: 提出可能的原因
3. **验证阶段**: 逐一验证假设
4. **修复阶段**: 实施修复并验证

### 场景 3: TDD 开发

```
使用 tdd prompt 开发一个用户认证模块
```

AI 会：
1. **RED**: 先写失败的测试
2. **GREEN**: 写最少的代码让测试通过
3. **REFACTOR**: 重构优化代码
4. 循环直到功能完成

## 文档

- **[CURSOR_SETUP.md](./CURSOR_SETUP.md)** - 详细的 Cursor 配置指南
- **[MCP_ARCHITECTURE.md](./MCP_ARCHITECTURE.md)** - 技术架构和实现细节
- **[主项目文档](../README.md)** - Superpowers 完整文档

## 故障排查

### MCP Server 未启动

1. 检查 Node.js 版本（需要 >= 18.0.0）:
   ```bash
   node --version
   ```

2. 检查配置文件路径是否正确

3. 查看 Cursor 开发者工具（Help > Toggle Developer Tools）的错误日志

### 技能未找到

使用 `list_skills` 工具查看当前可用的技能：

```
使用 list_skills 工具，source 参数设为 all
```

### 调试模式

MCP server 会在 stderr 输出调试信息：

```bash
# 手动启动 server 查看输出
node ~/.superpowers/mcp/index.js
```

输出示例：

```
[Superpowers MCP] 配置信息:
  核心技能目录: /Users/.../.superpowers/skills
  个人技能目录: /Users/.../.cursor/skills
  项目技能目录: /path/to/project/.skills
[Superpowers MCP] Server initialized successfully
[Superpowers MCP] Server running on stdio
```

## 环境变量

自定义技能目录位置：

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `SUPERPOWERS_SKILLS_DIR` | `~/.superpowers/skills` | 核心技能目录 |
| `SUPERPOWERS_PERSONAL_SKILLS` | `~/.cursor/skills` | 个人技能目录 |
| `SUPERPOWERS_PROJECT_SKILLS` | `${workspaceFolder}/.skills` | 项目技能目录 |

在 `mcp_config.json` 中配置：

```json
{
  "mcpServers": {
    "superpowers": {
      "command": "node",
      "args": ["..."],
      "env": {
        "SUPERPOWERS_SKILLS_DIR": "/custom/path/to/skills"
      }
    }
  }
}
```

## 更新

```bash
cd ~/.superpowers
git pull
cd mcp
npm install
```

重启 Cursor 使更新生效。

## 与其他平台的比较

| 平台 | 技能加载 | 自动注入 | 配置方式 |
|------|---------|---------|---------|
| Claude Code | `Skill` tool | SessionStart hook | Native plugin |
| Cursor (MCP) | `get_skill` tool + Resources | Prompt (手动) | mcp_config.json |
| OpenCode | `use_skill` tool | chat.message hook | Plugin file |

## 技术栈

- **协议**: [Model Context Protocol](https://modelcontextprotocol.io)
- **SDK**: [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk)
- **传输**: stdio (标准输入/输出)
- **语言**: Node.js (ES Modules)

## 贡献

欢迎贡献新技能、改进现有技能或报告问题！

1. Fork 项目
2. 创建功能分支
3. 提交 Pull Request

## 许可证

MIT License - 详见 [LICENSE](../LICENSE)

## 致谢

- 原始 Superpowers 项目: [obra/superpowers](https://github.com/obra/superpowers)
- MCP 协议: [Anthropic](https://www.anthropic.com/)

## 获取帮助

- **GitHub Issues**: https://github.com/obra/superpowers/issues
- **文档**: https://github.com/obra/superpowers
- **MCP 规范**: https://modelcontextprotocol.io

## 下一步

1. 阅读 [CURSOR_SETUP.md](./CURSOR_SETUP.md) 完成配置
2. 尝试 `session_start` prompt 了解技能系统
3. 使用 `brainstorm` prompt 开始你的第一个项目
4. 创建自己的个人技能
5. 探索所有可用技能

祝编程愉快！🚀
