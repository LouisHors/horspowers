# Superpowers MCP - Cursor 配置指南

本指南帮助你在 Cursor 中配置和使用 Superpowers MCP server。

## 前置要求

- [Cursor](https://cursor.sh) 最新版本（支持 MCP）
- Node.js 18.0.0 或更高版本
- Git

## 安装步骤

### 1. 克隆 Superpowers 仓库

```bash
# 克隆到你选择的目录
git clone https://github.com/obra/superpowers.git ~/.superpowers

# 切换到 MCP 分支
cd ~/.superpowers
git checkout lh-feature-mcp
```

### 2. 安装依赖

```bash
cd ~/.superpowers/mcp
npm install
```

### 3. 配置 Cursor

#### 方法一：全局配置（推荐）

在 Cursor 设置中添加 MCP server 配置：

**macOS/Linux:**

编辑 `~/.cursor/mcp_config.json`（如果不存在则创建）：

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

编辑 `%USERPROFILE%\.cursor\mcp_config.json`：

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

> **注意**：将 `YOUR_USERNAME` 替换为你的实际用户名。

#### 方法二：项目级配置

在你的项目根目录创建 `.cursor/mcp.json`：

```json
{
  "mcpServers": {
    "superpowers": {
      "command": "node",
      "args": ["/Users/YOUR_USERNAME/.superpowers/mcp/index.js"],
      "env": {
        "SUPERPOWERS_PROJECT_SKILLS": "${workspaceFolder}/.skills"
      }
    }
  }
}
```

### 4. 重启 Cursor

配置完成后，重启 Cursor 使配置生效。

## 验证安装

重启 Cursor 后，在聊天窗口中：

1. **查看可用工具**: 输入 `@superpowers` 应该能看到 MCP server 的工具
2. **列出技能**: 使用工具 `list_skills` 查看所有可用技能
3. **测试 prompt**: 尝试使用预定义的 prompt，如 `session_start`

## 使用方法

### 1. 查看可用技能

```
使用 list_skills 工具查看所有可用的 Superpowers 技能
```

AI 会调用 `list_skills` 工具，显示所有技能列表。

### 2. 加载特定技能

```
使用 get_skill 工具获取 brainstorming 技能
```

或者直接说：

```
我想使用 brainstorming 技能开始一个新功能的设计
```

### 3. 搜索技能

```
搜索与 debug 相关的技能
```

### 4. 使用预定义 Prompts

Superpowers MCP 提供了快速启动常用工作流的 prompts：

- **session_start**: 会话启动（介绍如何使用技能）
- **brainstorm**: 头脑风暴流程
- **debug**: 系统化调试
- **tdd**: 测试驱动开发
- **code_review**: 代码审查准备
- **write_plan**: 编写实施计划

使用方式：

```
使用 brainstorm prompt 开始讨论我的想法
```

### 5. 浏览技能文档（Resources）

在 Cursor 的 Resources 浏览器中，你可以直接查看所有技能文档：

- `skill://superpowers/brainstorming`
- `skill://superpowers/systematic-debugging`
- `skill://superpowers/test-driven-development`
- 等等...

## 技能优先级

Superpowers 支持三个级别的技能：

1. **项目技能** (`.skills/`) - 最高优先级，项目特定的技能
2. **个人技能** (`~/.cursor/skills/`) - 个人自定义技能
3. **核心技能** (`~/.superpowers/skills/`) - Superpowers 提供的标准技能

高优先级的技能会覆盖低优先级的同名技能。

## 创建自定义技能

### 个人技能

在 `~/.cursor/skills/` 创建你的技能：

```bash
mkdir -p ~/.cursor/skills/my-skill
```

创建 `~/.cursor/skills/my-skill/SKILL.md`：

```markdown
---
name: my-skill
description: 这是我的自定义技能
---

# 我的技能

## 概述

这里写技能的使用说明...

## 流程

1. 步骤一
2. 步骤二
3. 步骤三
```

### 项目技能

在项目根目录创建 `.skills/` 目录：

```bash
mkdir -p .skills/project-specific-skill
```

创建 `.skills/project-specific-skill/SKILL.md`（格式同上）。

## 环境变量配置

你可以通过环境变量自定义技能目录位置：

| 环境变量 | 说明 | 默认值 |
|---------|------|--------|
| `SUPERPOWERS_SKILLS_DIR` | 核心技能目录 | `~/.superpowers/skills` |
| `SUPERPOWERS_PERSONAL_SKILLS` | 个人技能目录 | `~/.cursor/skills` |
| `SUPERPOWERS_PROJECT_SKILLS` | 项目技能目录 | `${workspaceFolder}/.skills` |

## 故障排查

### MCP Server 未启动

1. 检查 Cursor 是否支持 MCP（需要最新版本）
2. 检查 `mcp_config.json` 路径和语法是否正确
3. 查看 Cursor 的开发者工具（Help > Toggle Developer Tools）查看错误日志

### 技能未找到

1. 确认技能目录路径正确
2. 使用 `list_skills` 工具查看当前可用的技能
3. 检查环境变量是否正确配置

### 工具调用失败

1. 检查 Node.js 版本（需要 >= 18.0.0）
2. 确认已在 `mcp/` 目录下运行 `npm install`
3. 查看 stderr 输出（Cursor 开发者工具）

### 调试模式

启动 server 时会在 stderr 输出调试信息：

```
[Superpowers MCP] 配置信息:
  核心技能目录: /Users/.../.superpowers/skills
  个人技能目录: /Users/.../.cursor/skills
  项目技能目录: /path/to/project/.skills
[Superpowers MCP] Server initialized successfully
[Superpowers MCP] Server running on stdio
```

## 更新 Superpowers

```bash
cd ~/.superpowers
git pull
cd mcp
npm install
```

重启 Cursor 使更新生效。

## 获取帮助

- GitHub Issues: https://github.com/obra/superpowers/issues
- 主文档: https://github.com/obra/superpowers

## 下一步

- 阅读 [核心技能列表](../README.md) 了解可用的技能
- 查看 [MCP_ARCHITECTURE.md](./MCP_ARCHITECTURE.md) 了解技术细节
- 尝试使用 `brainstorm` prompt 开始你的第一个项目
