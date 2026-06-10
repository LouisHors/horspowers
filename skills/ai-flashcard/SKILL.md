---
name: ai-flashcard
description: |
  AI 基础知识学习卡片系统。触发场景：
  - 用户说"来一张学习卡片"、"今天学什么"、"学习卡片"、"flashcard"
  - 用户说"复习卡片"、"标记已学"、"review card"
  - 用户说"学习进度"、"卡片状态"
  - 会话开始时自动检测是否有到期卡片（可选）
  中文触发场景：当用户说"学习卡片"、"今天学什么"、"复习一下"、"标记学完了"等需要 AI 学习卡片时使用此技能。
---

# AI Flashcard — 学习卡片系统

基于 `my-code-wiki` 的 AI 基础概念页，提供间隔重复学习卡片。每张卡片是一个独立的微型知识点，包含 5 个部分：一句话定义、iOS 类比、为什么重要、和用户项目的关联、验证问题。

## 核心文件

| 文件 | 用途 |
|------|------|
| `~/my-code-wiki/wiki/concepts/ai-fundamentals/flashcards/` | 14 张已生成的卡片 |
| `~/my-code-wiki/wiki/concepts/ai-fundamentals/*.md` | 完整概念页（卡片来源） |
| `~/my-code-wiki/tools/flashcard.py` | 间隔重复调度脚本 |
| `~/my-code-wiki/tools/flashcard_state.json` | 学习状态数据库 |

## 工作模式

### 模式 1：推送今日卡片

用户说"来一张卡片"或会话开始时，执行：

```bash
cd ~/my-code-wiki && python3 tools/flashcard.py today
```

脚本返回 0-2 张卡片 ID。然后：
1. 从 `wiki/concepts/ai-fundamentals/flashcards/{id}.md` 读取卡片内容
2. 向用户展示卡片（核心信息 + 验证问题）
3. 询问用户是否已复习

如果返回空（无到期卡片），告知用户"今天没有待学习的卡片，目前进度 XX/14。"

### 模式 2：标记已复习

用户确认复习后，执行：

```bash
cd ~/my-code-wiki && python3 tools/flashcard.py review {card_id}
```

如果触发里程碑（每掌握 5 张），额外询问用户：这 5 个概念之间的关系是什么？引导用户主动建立概念连接。

### 模式 3：查看进度

用户说"学习进度"时：

```bash
cd ~/my-code-wiki && python3 tools/flashcard.py status
```

## 卡片展示格式

向用户展示卡片时，使用这个格式（简洁，不要逐字复制所有内容）：

```
**今日学习卡片: {概念名}**

{一句话定义}

{类比部分 1-2 句话精简版}

验证: {验证问题}
```

## 间隔重复策略

- 新卡片：第 1 次 → 1 天后 → 3 天后 → 7 天后 → 14 天后 → 28 天后（已掌握）
- 每日上限：最多推送 2 张（1 张复习 + 1 张新卡）
- 优先级：priority=1（必须先学的基础概念）优先于 priority=2（进阶概念）

## 行为约束

- 不要在用户没有请求时主动推送卡片
- 展示卡片要简洁——不要复制完整的类比段落，只提取最核心的那一句
- 验证问题是开放性的，不要急着给答案，让用户自己先想
