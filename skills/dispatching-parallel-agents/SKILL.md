---
name: dispatching-parallel-agents
description: Use when facing 2+ independent tasks that can be worked on without shared state or sequential dependencies. 中文触发场景：当用户说“并行处理这些任务”、“同时解决这些问题”、“有多个独立的失败需要修复”等需要并行代理时使用此技能。
---

# Dispatching Parallel Agents

仅将真正独立、不会竞争同一文件或顺序状态的任务并行分派；其余任务保持顺序执行。

## 先加载共享文档上下文

先阅读 `horspowers:using-horspowers/references/document-runtime.md`。通过 JSON stdin 调 `resolve`；在 ready 状态使用 `search` 找当前 task、plan、design 与未完成 bug，并以 `get` 把完整正文取回。禁止用配置存在性、目录扫描或文件路径来选择文档 backend。

每个子代理只接收与其子任务相关的完整 plan/design/task 内容、验收条件、边界和输出格式。不要只传 logical ID，因为子代理未必能访问同一运行时会话。

运行时不可用时，保留会话内已有材料并说明未持久化；仍可分派用户明确给出的独立工作，但不创建本地文档替代品。

## 分派规则

1. 先画出读写集合与依赖。任何共享文件、共享环境、需要前一任务输出的任务都不并行。
2. 给每个代理单一、可验证的目标，要求报告变更、验证、风险与未完成项。
3. 父代理负责整合结果、处理冲突并运行最终验证；不要让并行代理互相覆盖。
4. 如需记录聚合进展，使用 `update` 当前 task。`confirmation_required` 只问一次；`submitted_pending_review` 是“已投稿、待本机入库”。

完成后如进入集成或分支结束，转入相应的 review/finishing workflow，而非靠并行代理自行宣布完成。
