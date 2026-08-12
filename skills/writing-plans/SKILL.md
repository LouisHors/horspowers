---
name: writing-plans
description: You MUST use this when the user wants an approved spec or agreed approach turned into a concrete step-by-step implementation plan before coding begins. Trigger on requests like '帮我写个实施计划'、'制定开发计划'、'把这个方案拆成步骤'、'给我一份可执行的计划'。中文触发场景：当用户说“写计划”、“实施计划”、“拆解任务”、“把设计转成开发步骤”等需要编码前计划时使用此技能。
---

# Writing Plans

把已批准的设计转成可由陌生工程师逐步执行的计划。每个步骤必须有精确文件、行为、验证命令和 Expected，且不暗含关键设计决定。

**开始时声明：**“我正在使用编写计划技能。” 首次回复先确认有无已批准的设计；没有时回到 `horspowers:brainstorming`，不开始编码。

## 统一文档运行时

先阅读 `horspowers:using-horspowers/references/document-runtime.md`。只按该参考的 JSON stdin 使用 `resolve`、`search`、`get`、`create` 和 `update`，绝不以配置标记、目录或文件名决定文档 backend。

1. `resolve` 为 ready 后，以 `search` 找相关 design、decision、task 和旧 plan；对最终采用的 design 调 `get` 读取**完整正文**。
2. 先用完整设计和仓库事实列出范围、非目标、风险、依赖和验收；不从标题或摘要推断要求。
3. 用 `create` 产生 plan，需要动态追踪时再用 `create` 产生 task；修订统一用 `update`。运行时 unavailable 时把计划保留在会话，明确未持久化，绝不自行创建本地替代文档。

local backend 的 plan 保留完整 Markdown 模板，包含必要的代码片段、逐行实现说明和完整命令。Wiki backend 只能用 safe-document：

- 精确路径和操作进入 `files`。
- 命令及 Expected 进入 `commands`。
- symbol、输入、输出、规则、错误边界进入 `implementation_specs`。
- `paragraphs` 只写简短原创解释；禁止放完整源码、diff、自由 Markdown 或日志。

普通 local backend 的 plan 保持既有 `docs/plans/` 路径；Wiki backend 使用 logical ID/URI。两者都由运行时返回，不能据此反向选择 backend。

对 task 文档也使用相同边界，关联 design/plan 用 logical ID，而不是假设某个路径。`confirmation_required` 只询问一次；`safe_document_required` 或 `submission_safety_blocked` 时重构内容；`submitted_pending_review` 只能表述为“已投稿、待本机入库”；`partially_submitted` 必须分项报告。

## 计划格式

每个任务按以下粒度写：

1. 目标和前置条件。
2. 要修改或新增的精确文件与 symbol。
3. 行为、输入输出、失败路径和不可变规则。
4. 测试优先的步骤、运行命令及 Expected。
5. 明确不做的范围，避免投机性重构。

任务通常应在 2–5 分钟内形成一个可验证小步；先测试再实现，频繁验证并保留可回滚的 Git commit 边界。计划应列出建议的 commit 时机和精确变更范围，而不是把所有工作压成一个不可审查提交。

## Plan Review Gate

通过 `get` 取得**完整 plan 正文**和完整 design/spec 正文后，使用 `skills/writing-plans/plan-document-reviewer-prompt.md` 做结构化审查。子代理可用时把两个完整正文交给 reviewer；否则用同一 checklist 自审。

审查至少覆盖：未完成占位、design/spec 覆盖、每步是否有精确文件/命令/Expected、范围控制和 YAGNI。`Issues Found` 时先 `update` 修复，再重新 `get` 并审查；只有 `Approved` 才能交接执行。建议性意见不阻塞，但必须和 blocking issue 区分。

通过后让用户选择 `horspowers:subagent-driven-development`（当前会话连续推进）或 `horspowers:executing-plans`（分批检查点）；不要在此技能中直接实施。
