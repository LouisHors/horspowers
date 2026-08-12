---
name: subagent-driven-development
description: You MUST use this when the user wants an existing implementation plan executed in the current session through mostly independent tasks, continuous forward progress, or self-directed task sequencing without explicit pause-and-review checkpoints. 中文触发场景：当用户说“当前会话里连续把计划做完”、“每个任务完成后直接继续下一个”、“用子代理持续推进”时使用此技能。
---

# Subagent-Driven Development

在当前会话按小任务连续推进：每项由新子代理实现，先做规格符合性审查，再做代码质量审查，然后进入下一项。

## 加载计划与设计

先阅读 `horspowers:using-horspowers/references/document-runtime.md`。先 `resolve`，ready 后用 `search` 找当前 plan、design、task 和相关 bug，再用 `get` 读取完整正文。不要用文件系统路径、配置标记或 shell 检查推断文档 backend。

控制器在 **once before any task execution begins** 的前置步骤中读取一次完整计划，提取所有任务并在后续循环复用；不要让每个子代理重复读取文件。为每个 implementer 和 reviewer 直接提供完整任务文本、关联 design/plan 的完整约束、验收命令以及前序结论。逻辑 ID 只是引用，不能代替正文。若运行时 unavailable，保留本会话上下文并报告未持久化；继续前须确保用户已经提供足够的计划内容。

## 每个任务的固定循环

1. 提取一个边界明确、尽量不与下一项共享写集的任务。
2. 分派 implementer，只允许实现该任务并运行其验证；implementer 必须先做 self-review（完整性与测试/边界）但自审不能替代独立 review。
3. 分派规格 reviewer，对照完整 plan/design 和**实际实现代码**独立检查遗漏、范围漂移和验收缺口；不得只相信 implementer summary。
4. 分派代码质量 reviewer，检查正确性、可读性、测试与回归风险。
5. 有 blocking issue 就修复并重新进行对应审查；通过后才进入下一任务。

不要在任务间为了 “Should I continue?” 暂停：在计划仍清楚且任务独立时直接继续执行下一项。只在真正 blocker、genuine ambiguity、验证失败需要人决策或全部任务完成时停止。进展需要持久化时，使用运行时 `update`；对于 `confirmation_required` 只请求一次确认。`submitted_pending_review` 必须表述为“已投稿、待本机入库”，不能让下一个新会话依赖它。

全部任务完成后，必须先对最终全量 diff 进行一次独立 code review；发现 blocking 问题必须修复并复审，通过后才进入 `horspowers:finishing-a-development-branch`。每个任务的局部 review 和 finishing 的检查都不能替代这道最终门。
