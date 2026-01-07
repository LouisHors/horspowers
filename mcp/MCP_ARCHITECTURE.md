# Superpowers MCP - 架构文档

本文档详细说明 Superpowers MCP server 的技术架构和实现细节。

## 概述

Superpowers MCP server 将 Superpowers 技能库转换为符合 [Model Context Protocol](https://modelcontextprotocol.io) 标准的服务器，使其能够在 Cursor、VSCode、Windsurf 等支持 MCP 的 AI 编程工具中使用。

## 架构图

```
┌─────────────────────────────────────────────────────────┐
│                    MCP Client (Cursor)                  │
│                                                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐             │
│  │ Resources│  │  Tools   │  │ Prompts  │             │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘             │
└───────┼────────────┼─────────────┼───────────────────┘
        │            │             │
        │     MCP Protocol (stdio) │
        │            │             │
┌───────▼────────────▼─────────────▼───────────────────┐
│              Superpowers MCP Server                   │
│                                                        │
│  ┌──────────────────────────────────────────────┐   │
│  │         MCP Server (index.js)                │   │
│  │  - Request routing                           │   │
│  │  - Protocol handling                         │   │
│  │  - Error handling                            │   │
│  └──────────────────┬───────────────────────────┘   │
│                     │                                 │
│  ┌─────────────────┴────────────────────────────┐   │
│  │      Handler Layer (src/)                    │   │
│  │                                               │   │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  │   │
│  │  │resources │  │  tools   │  │ prompts  │  │   │
│  │  │  .js     │  │  .js     │  │  .js     │  │   │
│  │  └────┬─────┘  └────┬─────┘  └────┬─────┘  │   │
│  └───────┼─────────────┼─────────────┼────────┘   │
│          │             │             │              │
│  ┌───────▼─────────────▼─────────────▼────────┐   │
│  │       SkillsResolver (src/skills-resolver.js)│   │
│  │  - Skill discovery                          │   │
│  │  - Skill loading                            │   │
│  │  - Priority resolution                      │   │
│  │  - Caching                                  │   │
│  └──────────────────┬───────────────────────────┘   │
│                     │                                 │
└─────────────────────┼─────────────────────────────┘
                      │
          ┌───────────▼────────────┐
          │  lib/skills-core.js    │
          │  (Shared utility)      │
          │  - Parse YAML          │
          │  - Find skills         │
          │  - Strip frontmatter   │
          └───────────┬────────────┘
                      │
          ┌───────────▼────────────┐
          │   Skill Files          │
          │   (SKILL.md)           │
          │                        │
          │  - skills/             │
          │  - ~/.cursor/skills/   │
          │  - .skills/            │
          └────────────────────────┘
```

## 核心组件

### 1. MCP Server (index.js, src/server.js)

**职责：**
- 初始化 MCP server
- 配置 stdio 传输
- 注册请求处理器
- 环境变量管理

**关键代码：**

```javascript
const server = new Server({
  name: 'superpowers',
  version: '1.0.0'
}, {
  capabilities: {
    resources: {},
    tools: {},
    prompts: {}
  }
});
```

### 2. SkillsResolver (src/skills-resolver.js)

**职责：**
- 技能发现和索引
- 技能内容读取
- 优先级解析（项目 > 个人 > superpowers）
- 缓存管理

**关键方法：**

```javascript
class SkillsResolver {
  async findAllSkills()      // 查找所有技能
  async listSkills(source)    // 按来源过滤
  async getSkill(skillName)   // 获取技能内容
  async searchSkills(query)   // 搜索技能
}
```

**优先级逻辑：**

```
技能查找顺序：
1. 项目技能 (.skills/)
2. 个人技能 (~/.cursor/skills/)
3. 核心技能 (skills/)

同名技能：高优先级覆盖低优先级
```

**缓存策略：**

- TTL: 5秒
- 失效条件: 超时或手动清除
- 缓存内容: 技能列表（不含文件内容）

### 3. Resources Handler (src/resources.js)

**职责：**
- 将技能文档暴露为 MCP Resources
- 支持 URI 路由
- 处理资源读取请求

**URI 格式：**

```
skill://<sourceType>/<skillName>

示例：
- skill://superpowers/brainstorming
- skill://personal/my-custom-skill
- skill://project/project-specific-skill
```

**MCP 接口实现：**

```javascript
// resources/list
{
  resources: [
    {
      uri: "skill://superpowers/brainstorming",
      name: "brainstorming",
      description: "...",
      mimeType: "text/markdown"
    }
  ]
}

// resources/read
{
  contents: [{
    uri: "skill://superpowers/brainstorming",
    mimeType: "text/markdown",
    text: "# 技能完整内容..."
  }]
}
```

### 4. Tools Handler (src/tools.js)

**职责：**
- 提供技能操作工具
- 格式化输出
- 错误处理

**工具定义：**

#### list_skills

列出所有可用技能，支持按来源过滤。

**参数：**
- `source` (可选): "all" | "superpowers" | "personal" | "project"

**输出格式：**

```markdown
# 可用技能 (共 15 个)

## Superpowers 核心技能 (15)

- **brainstorming**: Use when starting any creative work...
- **systematic-debugging**: Use when debugging issues...
...
```

#### get_skill

获取指定技能的完整内容。

**参数：**
- `skill_name` (必需): 技能名称

**输出格式：**

```markdown
# brainstorming

> Use when starting any creative work...

**来源**: superpowers
**路径**: /path/to/skills/brainstorming/SKILL.md

---

[技能完整内容]
```

#### search_skills

按关键词搜索技能。

**参数：**
- `query` (必需): 搜索关键词

**搜索范围：**
- 技能名称
- 技能描述

### 5. Prompts Handler (src/prompts.js)

**职责：**
- 提供预定义的提示模板
- 动态注入技能内容
- 支持参数化 prompts

**Prompts 列表：**

| Prompt | 描述 | 参数 |
|--------|------|------|
| `session_start` | 会话启动，注入 using-superpowers | - |
| `brainstorm` | 头脑风暴流程 | `idea` (可选) |
| `debug` | 系统化调试 | `issue` (可选) |
| `tdd` | 测试驱动开发 | - |
| `code_review` | 代码审查准备 | - |
| `write_plan` | 编写实施计划 | - |

**Prompt 结构：**

```javascript
{
  messages: [
    {
      role: 'user',
      content: {
        type: 'text',
        text: '用户消息 + 技能内容'
      }
    }
  ]
}
```

### 6. 共享模块 (lib/skills-core.js)

**职责：**
- YAML frontmatter 解析
- 技能文件查找
- 技能路径解析
- Frontmatter 剥离

**跨平台共享：**
- Claude Code plugin
- OpenCode plugin
- MCP server

**核心函数：**

```javascript
extractFrontmatter(filePath)    // 解析 YAML frontmatter
findSkillsInDir(dir, sourceType) // 递归查找技能
resolveSkillPath(skillName, ...) // 解析技能路径
stripFrontmatter(content)       // 移除 frontmatter
```

## 数据流

### 1. 列出技能

```
User: "列出所有技能"
  ↓
Cursor 调用 MCP tools/call
  ↓
MCP Server 接收请求 { name: "list_skills", arguments: { source: "all" } }
  ↓
tools.js → handleListSkills()
  ↓
SkillsResolver.listSkills("all")
  ↓
  - 检查缓存
  - 如果缓存过期：
    - findSkillsInDir(projectDir, 'project')
    - findSkillsInDir(personalDir, 'personal')
    - findSkillsInDir(superpowersDir, 'superpowers')
    - 更新缓存
  ↓
格式化输出（Markdown）
  ↓
返回给 Cursor
  ↓
显示给用户
```

### 2. 获取技能内容

```
User: "使用 brainstorming 技能"
  ↓
Cursor 调用 MCP tools/call
  ↓
MCP Server 接收请求 { name: "get_skill", arguments: { skill_name: "brainstorming" } }
  ↓
tools.js → handleGetSkill()
  ↓
SkillsResolver.getSkill("brainstorming")
  ↓
  - resolveSkillPath("brainstorming", superpowersDir, personalDir)
  - 检查项目技能
  - 检查个人技能
  - 检查核心技能
  - 找到: skills/brainstorming/SKILL.md
  ↓
  - 读取文件内容
  - extractFrontmatter() → { name, description }
  - stripFrontmatter() → 纯内容
  ↓
返回技能对象
  ↓
格式化输出
  ↓
返回给 Cursor
  ↓
注入到对话上下文
```

### 3. 使用 Prompt

```
User 调用 prompt "brainstorm"
  ↓
Cursor 调用 MCP prompts/get
  ↓
MCP Server 接收请求 { name: "brainstorm", arguments: { idea: "..." } }
  ↓
prompts.js → buildBrainstormPrompt()
  ↓
SkillsResolver.getSkill("brainstorming")
  ↓
构建消息：
  - 用户消息：描述意图
  - 技能内容：brainstorming 完整内容
  ↓
返回 { messages: [...] }
  ↓
Cursor 将消息注入对话
  ↓
AI 根据技能内容引导用户
```

## 配置系统

### 环境变量

| 变量 | 默认值 | 说明 |
|-----|--------|------|
| `SUPERPOWERS_SKILLS_DIR` | `<repo>/skills` | 核心技能目录 |
| `SUPERPOWERS_PERSONAL_SKILLS` | `~/.cursor/skills` | 个人技能目录 |
| `SUPERPOWERS_PROJECT_SKILLS` | `<cwd>/.skills` | 项目技能目录 |

### 目录结构

```
技能目录/
├── skill-name/
│   └── SKILL.md          # 技能文档
├── another-skill/
│   └── SKILL.md
└── ...
```

### SKILL.md 格式

```markdown
---
name: skill-name
description: Use when [condition] - [what it does]
---

# Skill Title

## Overview
...

## The Process
...
```

## 性能优化

### 1. 缓存策略

- **技能列表缓存**: 5秒 TTL，避免频繁文件系统扫描
- **技能内容**: 不缓存，保证实时性
- **缓存失效**: 手动清除或超时

### 2. 延迟加载

- 技能列表在首次请求时构建
- 技能内容按需读取
- 避免启动时加载所有技能

### 3. 错误恢复

- 单个技能读取失败不影响其他技能
- 目录不存在时静默跳过
- 所有错误记录到 stderr

## 错误处理

### 技能未找到

```javascript
throw new Error(`Skill not found: ${skillName}`);
```

### URI 格式错误

```javascript
throw new Error(`Invalid skill URI: ${uri}`);
```

### 文件读取错误

```javascript
// 静默失败，返回空结果
console.error('Error reading skill file:', error);
return { name: '', description: '' };
```

## 扩展性

### 添加新工具

1. 在 `src/tools.js` 的 `TOOLS` 数组添加定义
2. 在 `callTool()` 添加处理分支
3. 实现处理函数

### 添加新 Prompt

1. 在 `src/prompts.js` 的 `PROMPTS` 数组添加定义
2. 在 `getPrompt()` 添加处理分支
3. 实现构建函数

### 支持新技能来源

1. 在 `SkillsResolver` 构造函数添加目录配置
2. 在 `findAllSkills()` 添加扫描逻辑
3. 更新优先级规则

## 测试

### 手动测试

```bash
# 启动 server（stdout 会被 MCP 协议占用，日志在 stderr）
node mcp/index.js

# 在 Cursor 中测试
# 1. 配置 mcp_config.json
# 2. 重启 Cursor
# 3. 使用 @superpowers 测试工具
```

### 调试

查看 stderr 输出：

```
[Superpowers MCP] 配置信息:
  核心技能目录: /path/to/skills
  个人技能目录: /path/to/.cursor/skills
  项目技能目录: /path/to/project/.skills
[Superpowers MCP] Server initialized successfully
[Superpowers MCP] Server running on stdio
[Superpowers MCP] Ready to accept requests
```

## 与其他实现的比较

| 特性 | Claude Code Plugin | OpenCode Plugin | MCP Server |
|-----|-------------------|-----------------|------------|
| 传输方式 | Native API | Custom tools | MCP Protocol |
| 自动注入 | SessionStart hook | chat.message hook | Prompts (手动) |
| 技能加载 | Skill tool | use_skill tool | get_skill tool + Resources |
| 平台支持 | Claude Code only | OpenCode only | Cursor, VSCode, etc. |
| 配置方式 | Plugin config | Plugin file | mcp_config.json |

## 技术限制

1. **无自动注入**: MCP 没有会话钩子，需要手动使用 `session_start` prompt
2. **Stdio only**: 当前仅支持 stdio 传输（未来可扩展 SSE）
3. **单进程**: 每个 Cursor 窗口一个 server 进程
4. **缓存共享**: 不同窗口间缓存不共享

## 未来改进

- [ ] 支持 SSE 传输（远程 server）
- [ ] 技能更新通知
- [ ] 使用统计和推荐
- [ ] 技能依赖管理
- [ ] 更智能的缓存策略
- [ ] 技能版本控制

## 参考资料

- [MCP Specification](https://spec.modelcontextprotocol.io/)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [Superpowers 主文档](../README.md)
