---
name: using-horspowers
description: Use at the entry to a substantive Horspowers workflow so the local router can select one safe target workflow. 中文触发场景：实质性开发、调试、计划、评审、文档或历史上下文任务的统一入口。
---

# Horspowers 工作流路由入口

## 目的

此 Skill 是短入口，不自行展开完整技能树、配置问答或背景检索。先安全调用本地路由器；它在同一进程内完成只读 Plan、确定性路由和必要的幂等 Apply。

只在宿主能从 native skill discovery 确定脚本位置时调用。不要按仓库名扫描用户目录，也不要猜测未知宿主的路径。

## 安全输入契约

路由器只接收一份 JSON stdin：

```json
{
  "schema_version": 1,
  "host": "codex",
  "cwd": "/absolute/project/path",
  "message": "当前用户原文",
  "active_route": null
}
```

- 必须由宿主的结构化输入或安全环境变量生成 JSON。
- 不得把用户原文拼接到 shell command、argv 或代码字符串。
- 执行前验证脚本是普通可读文件并解析真实路径；详细路径见 `references/host-path-resolution.md`。

Codex macOS/Linux 的安全管道示例：

```bash
printf '%s' "$HORSPOWERS_ROUTER_INPUT" | \
  node "$HOME/.agents/skills/horspowers/using-horspowers/scripts/route-request.mjs"
```

Claude Code 与 Windows PowerShell 示例见 `references/host-path-resolution.md`。脚本只能从 stdin 获取 JSON，argv 必须为空。

## 处理结果

解析 stdout 的唯一 JSON 对象后严格按 `routing` 处理：

1. `blocked_by` 非空：不得加载候选 Skill；报告“外置文档运行时尚未就绪，Horspowers 工作流已安全暂停”，普通手工代码操作仍可继续。
2. `target_skill` 非空：立即加载这个唯一 Skill，不再进行泛化 Skill 判断。
3. `direct`：直接处理请求，不调用 qmd 或流程 Skill。
4. `uncertain`：只在 `candidates` 中比较；仍无法消歧时只问一个关键问题。
5. CLI non-zero：不假设配置或初始化已经成功，回退到 LLM 的安全路由判断且不执行额外写入。

`mutations` 只报告 AGENTS 托管区块、项目配置和通用 docs 的状态。路由脚本在任何 Apply 前完成规则评分；Plan 失败或规则无效时返回 `uncertain` 且 `mutations` 为空。

## 项目配置与文档

缺失配置只会在安全的具体项目根由路由器静默创建团队配置和通用 docs。已有配置、过期配置、旧配置或无效配置从不被静默覆盖；读取 `references/config-bootstrap.md` 后走明确的用户确认流程。

托管 AGENTS marker 损坏、重复或嵌套时，路由器拒绝写入并返回可操作错误。不得手工覆盖 marker 外的用户内容。

## 宿主工具映射

Codex 使用 native skill discovery、`update_plan` 和本机工具。Claude 专用工具名称的映射在 `references/codex-tools.md`；路径解析在 `references/host-path-resolution.md`。
