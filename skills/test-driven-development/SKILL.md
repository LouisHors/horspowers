---
name: test-driven-development
description: "You MUST use this when the user wants a feature or bugfix driven from a failing test, reproducing case, or acceptance test before implementation code is written. Trigger on requests like '先写失败测试'、'先补一个复现测试'、'先补一个能复现问题的测试'、'把验收行为写成自动化测试'、'先用一个 failing case 把问题固定住'、'drive this from a failing test first'. Do NOT use this when the root cause is still unknown and the immediate need is investigation; use systematic-debugging first. Also do NOT use it for generic test-after implementation work when the user did not ask for test-first flow. 中文触发场景：当用户说'开始写这个功能'、'实现XXX功能'、'修复这个bug'、'用TDD方式开发'等需要测试驱动开发时使用此技能。"
---

# Test-Driven Development

**铁律：没有先失败的测试，就不能写生产代码。**

**开始时声明：**“我正在使用测试驱动开发技能；下一步会先用失败或复现测试固定行为。” 首次回复后才检查仓库或写测试。

## RED-GREEN-REFACTOR

1. **RED**：写一个最小、真实代码路径上的测试，只表达一个期望行为。
2. **验证 RED**：亲眼确认它因功能缺失而失败，不是语法、夹具或环境错误。若意外通过，测试没有锁定新行为，应重写。
3. **GREEN**：写刚好通过该测试的最小实现；不得顺手扩张、重构或增加未被测试要求的选项。
4. **验证 GREEN**：运行目标测试及受影响的回归测试，修复代码而非篡改断言。
5. **REFACTOR**：仅在全绿后消除重复、改善命名或提取小单元；继续保持绿灯。

每个新行为重复这个循环。测试应清晰、最小、可重跑，除非不可避免不要用 mock 测 mock。

## Bug 文档运行时

先阅读 `horspowers:using-horspowers/references/document-runtime.md`。当 RED 出现非预期既有失败时，先 `resolve`；ready 后以 `create` 建立 bug，GREEN 后用 `update` 写入修复与验证结果。不得根据配置标记、目录或环境变量路径决定 backend，也不得直接操作文档。

Wiki backend 的 bug 采用 safe-document：受影响测试和代码进入 `files`，复现和验证命令/Expected 进入 `commands`，根因函数的输入输出、规则、错误边界进入 `implementation_specs`；段落只放原创摘要，不能放整个堆栈、源码或 diff。local backend 仍可经运行时保存完整复现细节。

对于 `confirmation_required` 只问一次；`safe_document_required` 或 `submission_safety_blocked` 时移除不安全正文并结构化重试；`submitted_pending_review` 必须说明“已投稿、待本机入库”；runtime unavailable 时保留会话中的 bug 内容并说明未持久化。

## 完成前检查

- 每个新增行为均有先失败的测试。
- 每次失败都因预期缺失而非测试错误。
- 所有目标与受影响回归测试通过，输出没有未解释的警告。
- 修复覆盖边界与错误情况，不测试实现细节或 mock 行为。
