# Superpowers MCP - 5 分钟快速开始

## 1️⃣ 安装（2 分钟）

```bash
# 克隆仓库（如果还没有）
git clone https://github.com/obra/superpowers.git ~/.superpowers

# 切换到 MCP 分支
cd ~/.superpowers
git checkout lh-feature-mcp

# 安装依赖
cd mcp
npm install
```

## 2️⃣ 配置 Cursor（1 分钟）

创建或编辑 `~/.cursor/mcp_config.json`：

**macOS/Linux:**
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

**Windows:**
```json
{
  "mcpServers": {
    "superpowers": {
      "command": "node",
      "args": ["C:\\Users\\YOUR_USERNAME\\.superpowers\\mcp\\index.js"]
    }
  }
}
```

> 替换 `YOUR_USERNAME` 为你的实际用户名

## 3️⃣ 重启 Cursor（10 秒）

重启 Cursor 使配置生效。

## 4️⃣ 验证安装（1 分钟）

在 Cursor 聊天窗口中输入：

```
使用 list_skills 工具查看所有可用技能
```

如果看到技能列表，说明安装成功！🎉

## 5️⃣ 开始使用（1 分钟）

### 场景 1: 了解技能系统

```
使用 session_start prompt
```

AI 会介绍如何使用 Superpowers 技能系统。

### 场景 2: 头脑风暴新功能

```
使用 brainstorm prompt
我想设计一个用户登录功能
```

AI 会引导你通过结构化的问答过程，形成完整的设计。

### 场景 3: 调试问题

```
我遇到一个 bug：用户点击提交按钮后页面卡住了
请使用系统化调试流程帮我解决
```

AI 会使用 4 阶段调试方法帮你定位和修复问题。

### 场景 4: 测试驱动开发

```
使用 tdd prompt
我要开发一个购物车模块
```

AI 会引导你完成 RED-GREEN-REFACTOR 循环。

## 常用命令速查

| 想做什么 | 输入这个 |
|---------|---------|
| 查看所有技能 | `使用 list_skills 工具` |
| 获取特定技能 | `使用 get_skill 工具获取 brainstorming` |
| 搜索技能 | `使用 search_skills 工具搜索 "debug"` |
| 头脑风暴 | `使用 brainstorm prompt` |
| 调试问题 | `使用 debug prompt` |
| TDD 开发 | `使用 tdd prompt` |
| 编写计划 | `使用 write_plan prompt` |
| 代码审查 | `使用 code_review prompt` |

## 可用的 15 个技能

### 🎯 核心工作流
- **brainstorming** - 头脑风暴和设计
- **systematic-debugging** - 系统化调试
- **test-driven-development** - TDD 开发
- **writing-plans** - 编写实施计划
- **executing-plans** - 执行计划

### 🤝 协作技能
- **subagent-driven-development** - 子代理开发
- **requesting-code-review** - 请求代码审查
- **receiving-code-review** - 接收代码审查
- **dispatching-parallel-agents** - 并行代理调度

### 🔧 Git 工作流
- **using-git-worktrees** - Git Worktree
- **finishing-a-development-branch** - 完成开发分支

### 📝 文档驱动
- **document-driven-bridge** - 文档驱动桥接

### 🎓 元技能
- **using-superpowers** - 使用指南
- **writing-skills** - 编写新技能
- **verification-before-completion** - 完成前验证

## 故障排查

### ❌ MCP server 未启动

**检查 Node.js 版本:**
```bash
node --version  # 需要 >= 18.0.0
```

**检查配置文件:**
```bash
# macOS/Linux
cat ~/.cursor/mcp_config.json

# Windows
type %USERPROFILE%\.cursor\mcp_config.json
```

**查看 Cursor 日志:**
- Help > Toggle Developer Tools
- 查看 Console 中的错误信息

### ❌ 技能未找到

在 Cursor 中输入：
```
使用 list_skills 工具
```

如果技能列表为空，检查技能目录路径是否正确。

### 💡 调试模式

手动启动 server 查看详细日志：
```bash
node ~/.superpowers/mcp/index.js
```

正常输出：
```
[Superpowers MCP] 配置信息:
  核心技能目录: /path/to/skills
  个人技能目录: /path/to/.cursor/skills
  项目技能目录: /path/to/project/.skills
[Superpowers MCP] Server initialized successfully
[Superpowers MCP] Server running on stdio
[Superpowers MCP] Ready to accept requests
```

## 下一步

### 📚 深入学习
- 阅读 [README.md](./README.md) 了解完整功能
- 查看 [MCP_ARCHITECTURE.md](./MCP_ARCHITECTURE.md) 了解技术细节

### 🎨 自定义技能
创建个人技能：
```bash
mkdir -p ~/.cursor/skills/my-skill
cat > ~/.cursor/skills/my-skill/SKILL.md << 'EOF'
---
name: my-skill
description: 我的自定义技能
---

# 我的技能

[技能内容...]
EOF
```

### 🚀 更多使用场景
- 使用 `brainstorm` 设计新功能
- 使用 `debug` 调试复杂问题
- 使用 `tdd` 开发新模块
- 使用 `code_review` 准备代码审查

## 获取帮助

- 📖 **文档**: [完整文档](./README.md)
- 🐛 **Issues**: https://github.com/obra/superpowers/issues
- 💬 **讨论**: GitHub Discussions

---

**祝编程愉快！🚀**

如果这个工具帮到了你，请给项目一个 ⭐️
