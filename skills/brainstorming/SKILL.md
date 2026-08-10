---
name: brainstorming
description: "You MUST use this before any creative work - creating features, building components, adding functionality, or modifying behavior. Explores user intent, requirements and design before implementation. 中文触发场景：当用户说'帮我想想这个功能的实现方案'、'这个需求我该怎么设计？'、'帮我理清思路'、'我想做个XXX，有什么建议？'等需要完善想法时使用此技能。"
---

# Brainstorming Ideas Into Designs

通过自然、逐步的对话把想法变成可实施的设计。先理解问题，再提出替代方案，最后在用户批准设计后才进入实施计划。

**开始时声明：**“我正在使用头脑风暴技能来完善你的想法。”

<HARD-GATE>
在呈现设计且得到用户批准前，禁止写代码、脚手架、调用实施技能或采取任何实施动作；需求再简单也一样。
</HARD-GATE>

## 过程

1. 一次性收集受限项目上下文、近期变更与已有知识；把结论标成仓库事实、Wiki 历史、用户确认事实或 Agent 推断。
2. 一次只问一个澄清问题，确认目标、约束、成功标准和范围。
3. 提供 2–3 个方案、权衡和推荐项；不要为未被要求的功能扩张范围。
4. 分段呈现架构、组件、数据流、错误处理和验证方法，并让用户逐段校准。
5. 设计获批后，决定是否需要持久化设计；若需要，按下面的统一运行时流程处理。

复杂请求先拆成可独立验证的子项目；每个子项目单独经历设计、计划和实施循环。

## 背景上下文收集

在第一个澄清问题前调用安装目录中的 `collect-context.mjs` 一次。无需为 qmd 单独询问：进入 brainstorming 已授权这项只读收集。输入必须经宿主结构化 JSON stdin 传入，不能把用户原文插进命令字符串；收集器并行读取受限 Wiki、仓库、Git 历史和入口文件，任何一个分支失败都不阻止其他只读分支。

检索结果只是候选证据：明确区分**仓库事实**、**Wiki 历史**、用户确认事实和**Agent 推断**。若 Wiki 与仓库不一致，展示两者来源并请用户确认基线；同一主题复用已收集的结果，仅在新模块或证据缺口出现时增量收集。

## 统一文档运行时

先阅读 `horspowers:using-horspowers/references/document-runtime.md` 并严格遵守其安装根解析、JSON stdin 和结果处理契约。不得根据项目中的配置标记或目录是否存在选择文档后端，也不得直接读写文档路径。

1. 调用 `resolve`。非 `ready`、unavailable、未注册或身份歧义时，保留设计在当前会话并明确“未持久化”；绝不创建本地替代文档。
2. 调用 `search` 查找相关 context、design 和 plan 候选；对选中的 logical ID 或本地运行时路径调用 `get` 读取完整正文。
3. 仅当设计含有重要架构、数据模型、接口或技术取舍时，询问用户是否创建设计文档；简单设计可只保留在会话并进入 `horspowers:writing-plans`。
4. 获准后通过 `create` 创建 design。后续用户修订必须通过 `update`，再重新读取完整正文。

local backend 的 design content 保留完整 Markdown 设计模板及必要的代码片段。Wiki backend 必须提交 safe-document：

- 受影响路径进入 `files`；验证命令与 Expected 进入 `commands`。
- 组件 symbol、输入、输出、规则和错误边界进入 `implementation_specs`。
- `paragraphs` 只能放短、原创的设计说明，不能放完整源码、diff、日志或自由 Markdown。

普通 local backend 仍返回既有 `docs/plans/` 设计路径；Wiki backend 返回 logical ID/URI。工作流只使用运行时返回值，不以该路径选择 backend。

若结果为 `confirmation_required`，展示 preview 后只询问一次，确认时以同一结构化请求重试。`safe_document_required` 或 `submission_safety_blocked` 时重构安全结构而不回显受限正文。`submitted_pending_review` 必须说“已投稿、待本机入库”，不能说已保存或已成为后续会话的事实；`partially_submitted` 必须逐项报告。

## 设计审查门

设计创建或更新后，先调用 `get` 取得**完整设计正文**，再将完整正文和 `skills/brainstorming/spec-document-reviewer-prompt.md` 一起交给 reviewer；宿主无子代理时使用同一标准自审。

审查必须覆盖：

- 完整性：没有 TODO、TBD、占位或“实现时再定”。
- 一致性与无歧义：实现者不应被迫补做设计决定。
- 范围与 YAGNI：没有超出已确认需求的复杂度。
- 可实施性：数据流、错误处理与验证边界足够明确。

有 blocking issue 时，以 `update` 修复并重新审查，直到通过。只有结构化审查通过后才请用户审阅；用户要求修改时，重新 `update`、`get` 和审查。得到用户批准后才调用 `horspowers:writing-plans`，而不是直接开始实施。

## 可视化伴侣

当布局、流程或方案对比用图更清楚时，可以单独一次征得用户同意后使用可视化伴侣。概念、约束和接口讨论仍优先用对话与文本，不因可视化绕过设计确认。

## 原则

- 一次一个问题，优先可选择的回答。
- 保持范围小、设计可验证、假设可追溯。
- 设计文档是沟通媒介；继续前总是以运行时重新读取的完整正文为准。
- brainstorming 的终点只能是 `horspowers:writing-plans`。
