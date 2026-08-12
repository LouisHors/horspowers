---
name: document-management
description: "You MUST use this when the user wants project documentation initialized, searched, reorganized, archived, restored, or otherwise maintained as a docs system task. Trigger on requests like '初始化文档系统'、'搜索文档'、'从 docs 里翻出来'、'恢复项目上下文'、'查看当前活跃文档'、'把完成事项从活跃文档归档'. Do NOT use this for generic repository exploration or code search unless the primary object is the documentation system itself. 中文触发场景：当用户说'文档管理'、'搜索文档'、'查看文档统计'、'初始化文档系统'、'迁移文档'等需要管理文档时使用此技能。"
---

# Document Management

通过统一运行时管理项目文档。此技能不直接创建目录、读取配置、移动文件或调用旧文档实现。

**开始时声明：**“我正在使用文档管理技能。” 首次回复重述用户要进行的文档操作；目标不清时最多问一个问题，之后才执行运行时调用。

## 统一入口

先阅读 `horspowers:using-horspowers/references/document-runtime.md`。所有请求使用 JSON stdin 调用 `resolve`、`get`、`search`、`create`、`update`、`archive`、`restore`、`config-change` 或 `record-session`。不得用配置标记、目录存在性或文件路径决定 backend。

先 `resolve`：

- `ready`：执行用户所需动作，并始终使用运行时返回的 logical ID、URI 或本地路径。
- documentation disabled：说明当前没有启用的文档 backend；若用户要变更配置，准备 `config-change` 请求，而不是直接改项目文件。
- unavailable、未注册或身份歧义：保留会话内容并说明未持久化。公司项目必须先完成外置配置注册；绝不创建本地替代目录、配置或文档。

## 操作映射

| 用户目标 | 运行时动作 |
| --- | --- |
| 找回设计、计划、任务、bug 或上下文 | `search` 找候选，再 `get` 完整正文 |
| 查看单个文档 | `get` |
| 新建设计、计划、任务、bug、decision 或 context | `create` |
| 修改状态、进展或正文 | `update` |
| 归档完成记录 | `archive` |
| 恢复已归档记录 | `restore` |
| 请求文档配置变更 | `config-change` |
| 记录会话与关联文档 | `record-session` |

本版本不以直接文件迁移方式处理旧文档。先用 `search`/`get` 收集可复用内容，再把迁移需求作为受审阅的 `create`、`update` 或 `config-change` 请求；外置迁移协议未设计时明确阻断，而不是猜测目标位置。

## 写入与安全状态

local backend 的完整 Markdown 仍由运行时维护。Wiki backend 的 create/update 使用 safe-document：路径放 `files`，命令与 Expected 放 `commands`，接口约束放 `implementation_specs`，段落不包含源码、diff、日志或凭据。

- `confirmation_required`：展示 preview，只问一次确认。
- `safe_document_required`：重构为安全结构再提交。
- `submitted_pending_review`：明确“已投稿、待本机入库”。
- `partially_submitted`：逐项列出成功和失败，不能宣称整体已保存。
- `submission_safety_blocked`：不回显受阻内容，移除不安全文本后重构。

任何不可用状态都不允许回退为手工文件操作。文档审查和最终入库由本机用户负责。
