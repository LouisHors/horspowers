---
name: executing-plans
description: "You MUST use this when the user wants an existing implementation plan executed in batches with explicit checkpoints, pause-and-review moments, or between-batch progress handoffs. Trigger on requests like '按这份计划开始做，先完成第一批，然后停下来汇报进展'、'按计划往前推，不过中间要给我几个检查点'、'我们就照文档里的步骤推进，每做完一个阶段都回顾一次'. Do NOT use this when the user still needs the plan written first; use `writing-plans` then. Do NOT use this when the work should continue autonomously in the current session across mostly independent tasks; use `subagent-driven-development` then. 中文触发场景：当用户说'按计划执行'、'开始实施计划'、'执行这个开发计划'、'先做一批再汇报'等需要执行已有计划并保留检查点时使用此技能。"
---

# Executing Plans

按批次加载、审查和执行已有计划；每批结束后汇报并等待反馈。

**开始时声明：**“我正在使用执行计划技能来实施这个计划。” 首次回复只说明将分批执行，若计划或检查点不明确最多问一个问题；在此之前不要加载文档、建 tracker 或开始任务。

## Step 0：通过运行时加载完整上下文

先阅读 `horspowers:using-horspowers/references/document-runtime.md`。只用该参考中的 JSON stdin 调用 `resolve`、`search` 和 `get`；不要根据配置文件、目录或 shell 路径猜测 backend。

1. `resolve` 为 `ready` 时，以 `search` 查找当前 task、plan 和关联 design；用 `get` 获取每个被选中的完整正文。
2. 若 task 指向 plan 或 design，优先用这些稳定 logical ID；没有候选时请用户提供计划引用，不把名称猜成文件路径。
3. 若运行时 unavailable、未注册或身份歧义，保留用户给出的计划和本会话上下文，说明文档未持久化，仍可在用户确认的范围内执行；绝不创建本地替代文档。

将完整 plan、相关 design 和当前 task 状态传给每个实施批次。先审查计划的缺口、风险或不一致；有阻塞问题先与用户确认，不能把不清楚的步骤当作可执行指令。

## Step 1：分批执行

默认先执行最小可审查的一批（通常前三个独立任务）：

1. 按计划逐项完成，严格执行指定验证。
2. 不顺手扩张范围；失败、缺依赖或指令不清时立即停止并报告证据。
3. 批次完成后，通过 `update` 记录任务进展与下一检查点。Wiki backend 的更新使用 safe-document 结构或受支持的状态变更；local backend 仍由同一运行时保留既有格式。

`confirmation_required` 时只询问一次；`submitted_pending_review` 表示“已投稿、待本机入库”，本会话继续保留检查点；`partially_submitted` 或 `submission_safety_blocked` 时准确报告，不能称已保存。

## Step 2：检查点与继续

每批报告：完成项、验证结果、已知风险、下一批建议和当前检查点。等待用户反馈后再继续下一批。计划被用户修改时，重新 `get` 完整正文并回到审查步骤。

全部完成并验证后，必须调用 `horspowers:finishing-a-development-branch`；不要自行合并、归档或跳过完成门。
