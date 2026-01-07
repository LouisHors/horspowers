# Superpowers MCP - 使用演示

这个文档展示了 Superpowers MCP server 的实际使用场景和效果。

## 场景 1: 查看所有可用技能

**用户输入:**
```
使用 list_skills 工具查看所有可用技能
```

**AI 响应:**
```markdown
# 可用技能 (共 15 个)

## Superpowers 核心技能 (15)

- **brainstorming**: Use when starting any creative work - creating features, 
  building components, adding functionality, or modifying behavior. Explores 
  user intent, requirements and design before implementation.
  
- **systematic-debugging**: Use when debugging issues - helps structure a 
  4-phase approach: understand, hypothesize, verify, fix.
  
- **test-driven-development**: Use when implementing any code - enforces 
  RED-GREEN-REFACTOR cycle, writes tests first.
  
- **writing-plans**: Use when starting implementation work - breaks tasks 
  into 2-5 minute steps with clear verification points.
  
... (显示所有 15 个技能)

使用 `get_skill` 工具查看技能详情。
```

---

## 场景 2: 头脑风暴新功能

**用户输入:**
```
使用 brainstorm prompt
我想为我的应用添加用户认证功能
```

**AI 响应:**
```
好的，我来帮你设计用户认证功能。让我先了解一下项目背景。

[AI 查看项目文件...]

我看到这是一个 web 应用。关于用户认证，我有几个问题：

**问题 1**: 你希望支持哪些认证方式？

A. 仅邮箱密码登录
B. 邮箱密码 + 社交登录（Google、GitHub 等）
C. 仅社交登录
D. 其他方式

请选择 A、B、C 或 D。
```

**用户回复:** `B`

**AI 继续:**
```
明白了，邮箱密码 + 社交登录。

**问题 2**: 关于会话管理，你倾向于哪种方式？

A. JWT (stateless, 适合分布式系统)
B. Session + Cookie (stateful, 传统方式)
C. 两者结合（JWT refresh token + Session）

你偏好哪种？
```

**...(继续问答，最终生成设计文档)**

```markdown
# 用户认证功能设计

## 概述
实现邮箱密码登录 + 社交登录（Google、GitHub），使用 JWT 进行会话管理。

## 架构
...

## 数据库设计
...

## API 端点
...

## 安全考虑
...

设计已保存到 docs/plans/2026-01-07-user-authentication-design.md。
你可以编辑文档调整设计，完成后说"继续"进入实施阶段。
```

---

## 场景 3: 获取特定技能

**用户输入:**
```
使用 get_skill 工具获取 test-driven-development
```

**AI 响应:**
```markdown
# test-driven-development

> Use when implementing any code - enforces RED-GREEN-REFACTOR cycle, 
> writes tests first.

**来源**: superpowers
**路径**: /Users/.../.superpowers/skills/test-driven-development/SKILL.md

---

# Test-Driven Development (TDD)

## Overview

Test-driven development is a disciplined approach where you write tests BEFORE 
writing implementation code. This skill enforces the RED-GREEN-REFACTOR cycle.

**Critical rule**: If you write ANY production code before tests, this skill 
will delete it and make you start over.

## The Process

### Phase 1: RED (Write a Failing Test)
...

### Phase 2: GREEN (Make it Pass)
...

### Phase 3: REFACTOR (Clean it Up)
...

[完整技能内容...]
```

---

## 场景 4: 搜索技能

**用户输入:**
```
使用 search_skills 工具搜索 "review"
```

**AI 响应:**
```markdown
# 搜索结果: "review" (2 个匹配)

## requesting-code-review
**来源**: superpowers
**描述**: Use when ready to submit code for review - pre-review checklist 
ensures code quality before requesting review

## receiving-code-review
**来源**: superpowers
**描述**: Use when you've received code review feedback - helps respond 
constructively and implement changes effectively

使用 `get_skill` 工具查看技能详情。
```

---

## 场景 5: 使用会话启动 Prompt

**用户输入:**
```
使用 session_start prompt
```

**AI 响应:**
```markdown
<EXTREMELY_IMPORTANT>
You have superpowers.

**Below is the full content of your 'superpowers:using-superpowers' skill - 
your introduction to using skills. For all other skills, use MCP tools to 
load them:**

[完整的 using-superpowers 技能内容]

这份技能介绍了：
- 如何使用技能系统
- 何时应该调用技能
- 常见的理由化陷阱
- 技能优先级规则

现在你已经了解了 Superpowers 系统。我可以帮你：

1. 查看所有可用技能 (使用 list_skills 工具)
2. 开始头脑风暴新功能 (使用 brainstorm prompt)
3. 调试问题 (使用 debug prompt)
4. 开始 TDD 开发 (使用 tdd prompt)

你想做什么？
</EXTREMELY_IMPORTANT>
```

---

## 场景 6: 系统化调试

**用户输入:**
```
使用 debug prompt
我的应用在生产环境中经常崩溃，错误信息是 "Connection timeout"
```

**AI 响应:**
```
我来帮你系统化地调试这个问题。根据 systematic-debugging 技能，我们会经历 4 个阶段。

## 阶段 1: 理解问题

让我先收集一些信息：

1. 崩溃频率如何？
   - 每次请求都崩溃？
   - 偶尔崩溃（几小时一次、一天几次）？
   - 特定时间段崩溃？

2. 能复现吗？
   - 可以在开发环境复现？
   - 只在生产环境出现？

3. 什么时候开始的？
   - 最近部署后才出现？
   - 一直存在？

[等待用户回答...]
```

**用户回复:** `高峰时段经常崩溃，开发环境无法复现，上周五新版本部署后开始`

**AI 继续:**
```
好的，这很有价值。让我检查日志和最近的更改...

[AI 查看代码和日志...]

## 阶段 2: 提出假设

基于信息，我有几个假设：

**假设 1**: 数据库连接池耗尽
- 新版本可能引入了未正确关闭的连接
- 高峰期连接数超过池大小

**假设 2**: 第三方 API 超时
- 上周的更改中增加了新的 API 调用
- 该 API 在高负载时响应慢

**假设 3**: 内存泄漏
- 高峰期内存使用量增长
- 最终导致 GC 压力和连接超时

让我们逐一验证...

## 阶段 3: 验证假设

[验证过程...]

## 阶段 4: 实施修复

[找到问题后实施修复...]
```

---

## 场景 7: TDD 开发新功能

**用户输入:**
```
使用 tdd prompt
我要实现一个购物车功能
```

**AI 响应:**
```
好的，我们使用 TDD 方法开发购物车功能。

根据 test-driven-development 技能，我们要严格遵循 RED-GREEN-REFACTOR 循环。

## 步骤 1: 明确需求

购物车需要哪些功能？我建议从最基本的开始：

1. 添加商品到购物车
2. 从购物车移除商品
3. 更新商品数量
4. 计算总价

同意这个顺序吗？还是有其他优先级？
```

**用户回复:** `同意`

**AI 继续:**
```
好的，我们从第一个功能开始：添加商品到购物车。

## RED: 写失败的测试

首先，我会创建测试文件和第一个测试：

\`\`\`javascript
// tests/cart.test.js
import { Cart } from '../src/cart.js';

describe('Cart', () => {
  test('should add item to cart', () => {
    const cart = new Cart();
    const item = { id: 1, name: 'Product A', price: 100 };
    
    cart.addItem(item);
    
    expect(cart.items).toHaveLength(1);
    expect(cart.items[0]).toEqual(item);
  });
});
\`\`\`

运行测试... ❌ **失败**（预期，因为 Cart 类还不存在）

## GREEN: 最小实现

现在写最少的代码让测试通过：

\`\`\`javascript
// src/cart.js
export class Cart {
  constructor() {
    this.items = [];
  }
  
  addItem(item) {
    this.items.push(item);
  }
}
\`\`\`

运行测试... ✅ **通过**

## REFACTOR: 优化代码

当前代码很简单，暂不需要重构。

继续下一个测试吗？
```

---

## 场景 8: 浏览 Resources

在 Cursor 的 Resources 面板中，可以看到：

```
📚 MCP Resources > superpowers

├── skill://superpowers/brainstorming
├── skill://superpowers/systematic-debugging
├── skill://superpowers/test-driven-development
├── skill://superpowers/writing-plans
├── skill://superpowers/executing-plans
├── skill://superpowers/subagent-driven-development
├── skill://superpowers/requesting-code-review
├── skill://superpowers/receiving-code-review
├── skill://superpowers/dispatching-parallel-agents
├── skill://superpowers/using-git-worktrees
├── skill://superpowers/finishing-a-development-branch
├── skill://superpowers/document-driven-bridge
├── skill://superpowers/using-superpowers
├── skill://superpowers/writing-skills
└── skill://superpowers/verification-before-completion
```

点击任意技能可以直接查看完整内容。

---

## 场景 9: 个人技能

**创建个人技能:**
```bash
mkdir -p ~/.cursor/skills/my-api-pattern
cat > ~/.cursor/skills/my-api-pattern/SKILL.md << 'EOF'
---
name: my-api-pattern
description: Use when building REST APIs in our project
---

# My API Pattern

## Our API Standards

1. Always use async/await
2. Use Zod for validation
3. Return consistent error format
4. Include request ID in logs

... (你的团队规范)
EOF
```

**使用个人技能:**
```
使用 get_skill 工具获取 my-api-pattern
```

AI 会加载你的个人技能并按照你的规范工作。

---

## 性能示例

### 技能加载速度
- 首次列出技能: ~50ms (需要扫描目录)
- 后续列出技能: ~5ms (使用缓存)
- 获取技能内容: ~10ms (直接读取文件)
- 搜索技能: ~15ms (遍历缓存)

### 内存占用
- Server 进程: ~50MB
- 技能列表缓存: ~10KB
- 单个技能内容: 2-5KB

### 并发支持
- 每个 Cursor 窗口: 独立的 server 进程
- 多窗口: 相互独立，不冲突

---

## 错误处理示例

### 技能不存在
**输入:** `使用 get_skill 工具获取 non-existent-skill`

**输出:**
```
错误: Skill not found: non-existent-skill

建议：
1. 使用 list_skills 工具查看所有可用技能
2. 检查技能名称拼写
3. 如果是个人技能，确认文件路径正确
```

### URI 格式错误
**输入:** `读取 resource: invalid-uri`

**输出:**
```
错误: Invalid skill URI: invalid-uri

正确格式: skill://<sourceType>/<skillName>
例如: skill://superpowers/brainstorming
```

---

## 日志示例

启动 server 时的日志输出（stderr）：

```
[Superpowers MCP] Starting server...
[Superpowers MCP] 配置信息:
  核心技能目录: /Users/username/.superpowers/skills
  个人技能目录: /Users/username/.cursor/skills
  项目技能目录: /path/to/project/.skills
[Superpowers MCP] Server initialized successfully
[Superpowers MCP] Server running on stdio
[Superpowers MCP] Ready to accept requests
```

---

## 与 Claude Code 对比

| 功能 | Claude Code | Cursor (MCP) |
|-----|------------|--------------|
| 技能加载 | `invoke Skill("brainstorming")` | `使用 get_skill 工具获取 brainstorming` |
| 自动注入 | ✅ SessionStart hook | ⚠️ 需手动使用 session_start prompt |
| 技能浏览 | 通过工具调用 | ✅ Resources 面板直接浏览 |
| 配置 | Plugin 配置 | mcp_config.json |
| 更新 | `git pull` | `git pull` + 重启 Cursor |

---

## 总结

Superpowers MCP server 提供了完整的技能库访问能力：

- ✅ **易用性**: 简单的工具和 prompt 调用
- ✅ **完整性**: 所有 15 个技能完全支持
- ✅ **可扩展**: 支持个人和项目技能
- ✅ **高性能**: 缓存优化，快速响应
- ✅ **可靠性**: 完善的错误处理

立即开始使用！查看 [QUICK_START.md](./QUICK_START.md) 完成 5 分钟配置。
