---
name: using-horspowers
description: Use at the entry to a substantive Horspowers workflow so the local router can select one safe target workflow. 中文触发场景：实质性开发、调试、计划、评审、文档或历史上下文任务的统一入口。
---

# Horspowers 工作流路由入口

## 目的

此 Skill 是短入口，不自行展开完整技能树、配置问答或背景检索。确定性边界默认先调用 HPS：宿主有 MCP 时复用会话级 `hps serve --stdio`，否则用一次性 `hps call`；HPS 只返回 route/context/scope 事实，Skill 仍负责判断、澄清、交互和后续编排。旧 router 保留为兼容入口，仅在 HPS 不可发现、协议不可用或 HPS 明确报告初始化回退时调用。

只在宿主能从 native skill discovery 确定脚本位置时调用。不要按仓库名扫描用户目录，也不要猜测未知宿主的路径。

## 安全输入契约

两个入口接收**不同的** JSON stdin 形状，不要混用。

**`hps call`（首选）** 接收 canonical envelope：`operation` 指定本次操作，`input` 是该操作的参数。

```json
{
  "schema_version": 1,
  "request_id": "route-1",
  "operation": "task_prepare",
  "cwd": "/absolute/project/path",
  "input": {
    "host": "pi",
    "message": "当前用户原文",
    "active_route": null
  }
}
```

**legacy `route-request.mjs`（仅兼容回退）** 接收扁平对象：

```json
{
  "schema_version": 1,
  "host": "pi",
  "cwd": "/absolute/project/path",
  "message": "当前用户原文",
  "active_route": null
}
```

- 两份输入都必须由宿主的结构化输入或安全环境变量生成。
- `host` 取当前宿主：`codex`、`claude` 或 `pi`。
- 不得把用户原文拼接到 shell command、argv 或代码字符串。
- 执行前验证脚本是普通可读文件并解析真实路径；详细路径见 `references/host-path-resolution.md`。
- 把扁平对象喂给 `hps call`（或反之）只会得到 `invalid_request`；那不是 HPS 不可用，不得据此降级到兼容入口。

Codex macOS/Linux 的 HPS 安全管道示例（`HPS_CALL_REQUEST` 是上面的 canonical envelope）：

```bash
printf '%s' "$HPS_CALL_REQUEST" | \
  "$HPS_INSTALL_ROOT/bin/hps" call
```

`HPS_INSTALL_ROOT` 必须来自宿主 native skill discovery；不得扫描用户目录或猜测路径。MCP 宿主应注册并调用 `hps serve --stdio`，先 `task_prepare`，再在同一 live scope 内调用 `project_context`、`context_collect` 或 document read 工具。没有 MCP 时，`task_prepare` 返回的 routing/context 只在本次 `hps call` envelope 内使用；不要把 CLI scope_id 当作跨进程持久 scope。若 HPS 返回普通项目的 `config_action`/`docs_action` 为 `create`、`repair_missing_structure` 或明确的 `explicit_action_required*`，必须把它视为初始化安全回退信号：保留 Skill 原有用户确认/编排，再调用一次 legacy `route-request.mjs` 完成既有幂等 apply 语义；steady-state `unchanged` 不得同时调用旧 router。

Claude Code 与 Windows PowerShell 示例见 `references/host-path-resolution.md`。脚本只能从 stdin 获取 JSON，argv 必须为空。

## 执行通道（MCP 与 CLI）

HPS 的确定性能力有两种接线，**能力相同，差别只在状态能活多久**：

| 通道 | 生命期 | 能做什么 |
|---|---|---|
| `hps serve --stdio`（MCP sidecar） | 一个会话 | `task_prepare` 得到的 live scope 可被后续调用复用，并复用 qmd 连接与 document/snapshot cache |
| `hps call`（JSON stdin，一次性） | 单个进程 | 只完成本次 operation；`scope_id` 随进程消失 |

`scope_id` 绑定 `root`、Git identity、project fingerprint、config/manifest revision、host config digest 和 transport digest；任何一项变化或进程结束都会让它失效（`scope_expired`）。因此：

- **无 MCP 时可以直接一次性调用**：`task_prepare`、`project_snapshot`、`git_preflight`、`diff_snapshot`、`document_resolve`、`runtime_doctor`。
- **必需 `scope_id` 的 operation 不能跨 `hps call` 进程调用**：`project_context`、`document_search`、`document_get`、`document_manifest`、`document_verify`、`context_collect`、`verification_run`、`session_*`、`checkpoint_*`、`commit_preview`、`merge_preview`。它们要么在 MCP 会话内用同一 live scope 调用，要么走对应的受控兼容入口（document 读 → `document-runtime-cli.mjs`；背景收集 → `collect-context.mjs`）。
- **不要**先 `hps call` 取 `scope_id`，再在下一条 `hps call` 里使用；那只会得到 `scope_expired`。HPS 的运行态不落盘，MCP 提供的是**会话内复用**而不是持久化；跨会话的持久化只由文档系统与 Wiki 承担。

## 处理结果

解析 stdout 的唯一 JSON 对象后严格按 `routing` 处理：

1. `blocked_by` 非空（旧调用方的兼容字段，当前调用方看不到）：不得加载候选 Skill；报告“外置文档运行时尚未就绪，Horspowers 工作流已安全暂停”，普通手工代码操作仍可继续。
2. `project.eligibility` 为 `external_project`，或 `config_action`/`config` 为 `external_required`：这是**身份未确认**的项目 —— 没有 remote 的本地仓库，或跳板机上的公司项目。不得创建本地配置或 `docs/`，也不得用本地文档替代；说明身份未确认，请用户确认 remote 或完成外置配置注册后重试。文档操作在运行时层 fail closed，因此继续普通手工代码操作可以，但不得把结果说成已持久化。
3. `target_skill` 非空：立即加载这个唯一 Skill，不再进行泛化 Skill 判断。
4. `direct`：直接处理请求，不调用 qmd 或流程 Skill；HPS 只做无上下文 route，Skill 直接响应。
5. `uncertain`：只在 `candidates` 中比较；仍无法消歧时只问一个关键问题。
6. HPS 返回 non-zero 时**先按错误码分类**，不要一律当成 HPS 不可用：
   - `invalid_request`：调用方形状或字段错误。修正 `hps call` envelope 后重试，不得降级。
   - `operation_unavailable` / `operation_not_found`：该 operation 尚未公开或不存在。按「执行通道」走对应的受控入口，不得据此推断 HPS 不可用。
   - `scope_expired`：scope 已失效。在 MCP 会话内重新 `task_prepare`，或用一次性 `hps call` 重做本次 operation。
   - 只有 HPS 不可发现、协议不可用，或 HPS 明确报告初始化回退时，才按旧 router 兼容入口做一次安全 fallback，且不执行额外写入。
   旧 fallback 的输出仍必须经过原有 blocked/uncertain 语义检查。

`task_prepare` 的 `result` 只报告 `routing`、`project`、`collected`、`scope` 与 `capabilities`；普通项目的变更状态读 `project.config_action` 与 `project.docs_action`。`mutations` 不是 `task_prepare` 的字段：它只出现在 legacy `route-request.mjs` 兼容入口的返回里，报告 AGENTS 托管区块、项目配置和通用 docs 三项状态。路由脚本在任何 Apply 前完成规则评分；Plan 失败或规则无效时返回 `uncertain` 且不产生任何变更。

## 项目配置与文档

缺失配置只会在安全的具体项目根由路由器静默创建团队配置和通用 docs。已有配置、过期配置、旧配置或无效配置从不被静默覆盖；读取 `references/config-bootstrap.md` 后走明确的用户确认流程。

托管 AGENTS marker 损坏、重复或嵌套时，路由器拒绝写入并返回可操作错误。不得手工覆盖 marker 外的用户内容。

## 宿主工具映射

Codex 使用 native skill discovery、`update_plan` 和本机工具。Claude 专用工具名称的映射在 `references/codex-tools.md`；路径解析在 `references/host-path-resolution.md`。

Pi 使用 `read`/`bash` 等本机工具与 `mcp__hps__*`（当 `hps serve --stdio` 已注册时）；Claude 工具名到 Pi 的映射（`Task`→`subagent`、`TodoWrite`→`todo` 等）在 `references/pi-tools.md`。向路由器传 `"host": "pi"`；Pi 无 SessionStart hook，会话级说明由项目/用户 `AGENTS.md` 提供，不由本 Skill 写入。
