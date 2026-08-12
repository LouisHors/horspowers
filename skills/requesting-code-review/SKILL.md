---
name: requesting-code-review
description: Use when the user asks for a formal or lightweight review of existing changes to find bugs, regressions, omissions, or requirement mismatches before merge, release, or further implementation. 中文触发场景：当用户说“帮我审一下代码”、“代码 review”、“看看这些改动有没有问题”、“合并前检查一下”等需要代码审查时使用此技能。
---

# Requesting Code Review

在交付、合并或继续实施前，基于完整要求与变更请求独立 review。

**开始时声明：**“我正在使用代码审查技能。” 首次回复说明审查范围；范围不清时最多问一个问题，随后才读取代码或文档。

## 获取要求与任务上下文

先阅读 `horspowers:using-horspowers/references/document-runtime.md`。通过 JSON stdin 先 `resolve`，在 ready 状态以 `search` 查找最近 task、plan、design、bug 或 decision，再对选定候选 `get` **完整正文**。不得以本地配置、目录存在性或文件名决定文档后端。

将完整 plan/requirements、design 约束和任务状态交给 reviewer，而不是只给文件名、摘要或逻辑 ID。运行时 unavailable 时，继续用用户在会话提供的材料 review，并明确文档上下文未持久化或无法恢复；不要创建本地替代追踪文档。

## 审查过程

1. 检查变更范围、测试和当前分支差异。
2. 用 `skills/requesting-code-review/code-reviewer.md` 的标准审查正确性、回归、边界条件、安全性、测试覆盖和需求匹配。
3. 先报告 blocking issue，并按严重度、位置、复现理由和建议修复排序；不要把纯风格建议伪装成阻塞项。
4. 修复后重新审查受影响范围。若需要记录 review 进展，使用运行时 `update` 当前 task；提交状态按共享参考处理。

只有 blocking issue 已修复且重新 review 通过时，才能说明 review gate 已通过。`submitted_pending_review` 始终表述为“已投稿、待本机入库”。
