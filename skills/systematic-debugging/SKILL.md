---
name: systematic-debugging
description: You MUST use this when the user needs a bug, failure, or unexpected behavior investigated systematically before any fix is proposed. Trigger on requests like '帮忙调试一下'、'先梳理现象、假设和验证步骤'、'确认问题到底在哪一层'、'先缩小问题范围'。中文触发场景：当用户说“排查问题”、“调试一下”、“为什么失败”、“定位根因”等需要先调查再修复时使用此技能。
---

# Systematic Debugging

先证据、后假设、再最小验证；不要未经复现就猜测修复。

**开始时声明：**“我正在使用系统化调试技能。” 首次回复复述现象和下一步收集证据；原因尚不明确时不直接给修复方案。

## Phase 0：文档上下文边界

先阅读 `horspowers:using-horspowers/references/document-runtime.md`。使用 JSON stdin 的 `resolve`、`search` 和 `get` 查找相关 bug、task、plan、design 和既有决策。获取候选后必须读完整正文；不得通过配置标记、目录或文件路径决定 backend。

运行时 ready 且异常测试揭示既有 bug 时，用 `create` 建立 bug 记录；根因、复现、修复和验证经过 `update` 记录。Wiki 记录使用 safe-document：文件在 `files`，命令与 Expected 在 `commands`，接口/规则/错误边界在 `implementation_specs`，段落不复制源码、diff 或日志。local backend 经同一运行时保留完整复现文本。

runtime unavailable 时把证据和结论留在会话并说明未持久化；绝不创建本地替代文档。`confirmation_required` 只问一次；`submitted_pending_review` 表示“已投稿、待本机入库”；`partially_submitted` 和 `submission_safety_blocked` 必须准确报告。

## 四阶段流程

1. **Phase 1：调查 / 根因证据**：精确读取错误、稳定复现、记录输入/输出、检查近期变化并在组件边界收集证据。
2. **Phase 2：模式分析**：找同仓库可工作的对照，列出每个差异与依赖，不跳读关键实现。
3. **Phase 3：假设与验证**：一次只提出一个可证伪假设，并以最小实验验证；失败后回到证据，而不是叠加补丁。
4. **Phase 4：实施与验证**：根因确认后使用 `horspowers:test-driven-development` 先写失败测试，再做单一最小修复并运行验证证明修复有效。

连续三次有证据的修复假设失败时，停止追加第四个补丁，与用户讨论架构或耦合问题。
