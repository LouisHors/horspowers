---
name: using-horspowers
description: Use at the entry to a substantive Horspowers workflow so the local router can select one safe target workflow. 中文触发场景：实质性开发、调试、计划、评审、文档或历史上下文任务的统一入口。
---

# Horspowers 工作流路由入口

## 目的

此 Skill 是短入口，不自行展开完整技能树、配置问答或背景检索。确定性边界默认先调用 HPS：宿主有 MCP 时复用会话级 `hps serve --stdio`，否则用一次性 `hps call`；HPS 只返回 route/context/scope 事实，Skill 仍负责判断、澄清、交互和后续编排。旧 router 保留为兼容入口，仅在 HPS 不可发现、协议不可用或 HPS 明确报告初始化回退时调用。

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

Codex macOS/Linux 的 HPS 安全管道示例：

```bash
printf '%s' "$HPS_REQUEST" | \
  "$HPS_INSTALL_ROOT/bin/hps" call
```

`HPS_INSTALL_ROOT` 必须来自宿主 native skill discovery；不得扫描用户目录或猜测路径。MCP 宿主应注册并调用 `hps serve --stdio`，先 `task_prepare`，再在同一 live scope 内调用 `project_context`、`context_collect` 或 document read 工具。没有 MCP 时，`task_prepare` 返回的 routing/context 只在本次 `hps call` envelope 内使用；不要把 CLI scope_id 当作跨进程持久 scope。若 HPS 返回普通项目的 `config_action`/`docs_action` 为 `create`、`repair_missing_structure` 或明确的 `explicit_action_required*`，必须把它视为初始化安全回退信号：保留 Skill 原有用户确认/编排，再调用一次 legacy `route-request.mjs` 完成既有幂等 apply 语义；steady-state `unchanged` 不得同时调用旧 router。

Claude Code 与 Windows PowerShell 示例见 `references/host-path-resolution.md`。脚本只能从 stdin 获取 JSON，argv 必须为空。

## 处理结果

解析 stdout 的唯一 JSON 对象后严格按 `routing` 处理：

1. `blocked_by` 非空：不得加载候选 Skill；报告“外置文档运行时尚未就绪，Horspowers 工作流已安全暂停”，普通手工代码操作仍可继续。
2. `target_skill` 非空：立即加载这个唯一 Skill，不再进行泛化 Skill 判断。
3. `direct`：直接处理请求，不调用 qmd 或流程 Skill；HPS 只做无上下文 route，Skill 直接响应。
4. `uncertain`：只在 `candidates` 中比较；仍无法消歧时只问一个关键问题。
5. HPS CLI/MCP non-zero：不假设配置或初始化已经成功；先报告 HPS 不可用，再按旧 router 兼容入口做一次安全 fallback，且不执行额外写入。旧 fallback 的输出仍必须经过原有 blocked/uncertain 语义检查。

`mutations` 只报告 AGENTS 托管区块、项目配置和通用 docs 的状态。路由脚本在任何 Apply 前完成规则评分；Plan 失败或规则无效时返回 `uncertain` 且 `mutations` 为空。

## 项目配置与文档

缺失配置只会在安全的具体项目根由路由器静默创建团队配置和通用 docs。已有配置、过期配置、旧配置或无效配置从不被静默覆盖；读取 `references/config-bootstrap.md` 后走明确的用户确认流程。

托管 AGENTS marker 损坏、重复或嵌套时，路由器拒绝写入并返回可操作错误。不得手工覆盖 marker 外的用户内容。

## 宿主工具映射

Codex 使用 native skill discovery、`update_plan` 和本机工具。Claude 专用工具名称的映射在 `references/codex-tools.md`；路径解析在 `references/host-path-resolution.md`。
