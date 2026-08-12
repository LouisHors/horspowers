---
name: finishing-a-development-branch
description: You MUST use this when implementation is complete, all tests pass, and the user needs to decide how to integrate the work. Present structured options for merge, PR, or cleanup. 中文触发场景：当用户说“做完了”、“可以合并了吗”、“准备提 PR”、“收尾一下分支”等需要结束开发分支时使用此技能。
---

# Finishing a Development Branch

在提出 merge、PR 或保留分支选项前，先证明实现完成且 tests pass。不得自动 merge 或丢弃工作。

## Step 1：验证

1. 运行计划规定的测试、静态检查和构建。
2. 测试失败、输出异常或需求未满足时停止；修复后重新验证，不进入集成选项。
3. 读取当前分支、基线和差异，确认没有无关修改。

## 文档完成记录

先阅读 `horspowers:using-horspowers/references/document-runtime.md`。使用 JSON stdin 先 `resolve`，ready 后 `get` 当前 task/bug 的完整正文，再通过 `update` 标记完成、以 `archive` 归档已完成追踪文档、必要时用 `record-session` 留下会话引用。不得由配置标记、目录或环境变量路径推断 backend，也不得直接移动、删除或写入文档。

Wiki backend 的 update/archive/record-session 都是 Inbox-only 提议。`confirmation_required` 时只询问一次；`submitted_pending_review` 必须明确“已投稿、待本机入库”；`partially_submitted` 逐项报告；`submission_safety_blocked` 时不回显受限内容。runtime unavailable 时保留完成摘要在会话并说明未持久化，继续完成代码验证但绝不创建本地替代记录。

Bug 记录的删除永远需要用户明确选择且仅能通过受支持的运行时能力；没有删除能力时保留或归档，不能以 shell 或直接文件操作绕过。

## Step 2：交付选择

测试通过、review gate 通过且用户获得完整变更摘要后，按团队策略提出合适选项：

1. 推送并创建 PR。
2. 本地合并到确认的基线分支。
3. 保留当前分支稍后处理。
4. 丢弃工作（仅在用户明确授权并确认目标后）。

解释当前推荐项、验证结果、风险和回滚方式。等待用户选择，再执行被授权的 Git 操作。
