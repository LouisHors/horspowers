# HPS Agent-first Core CLI 与 MCP Sidecar 实施计划

## 关联设计

- 设计：`2026-08-13-design-hps-agent-first-core-cli-与-mcp-sidecar.md`
- 分支：`codex/hps-agent-cli`
- 状态：2026-08-18 事实复核后更新。Core、CLI、MCP、协议/安全/生命周期收口、真实 capability adapter、宿主注册模板、portable helper 和 native host probe 已实现；HPS native CLI 已安装到主根。Claude project-local MCP 真实 probe 通过；Codex direct/MCP 通过但 agent 返回 `401 invalid_api_key`。Codex 默认 runner、主线集成和发布尚未完成。OpenCode 暂不纳入完整支持和验收范围。

## 范围与非目标

本计划交付共享 Core、`hps` JSON CLI、MCP stdio Sidecar、强类型 Agent tool schema、能力 envelope、metrics、进度/取消、内存 scope/cache、默认 Skill 接入和兼容 wrapper。保留 Skill 的判断与编排，保留旧入口，不提供任意 Shell、任意路径读写、删除、自动 commit/push/merge，也不扩大沙盒或网络权限。bootstrap 与 document submit/transition 写操作仍属于 Phase 5，在当前公开工具集中不注册并统一返回 `operation_unavailable`；这不是 Phase 1/2 的遗留项。

## 已实现的 Core 基线

### 1. 协议、Core 与 CLI

- `lib/hps-protocol.mjs` 定义严格请求/结果 envelope、大小限制、稳定 error 与脱敏 progress。
- `lib/hps-operations.mjs` 提供单一 operation registry、逐操作字段/类型/必填/互斥约束和共享 dispatch。
- `lib/hps-cli.mjs` 与 `bin/hps` 实现 EOF JSON 调用、version、doctor；stdout 只含最终 envelope，stderr 只含脱敏 NDJSON progress。
- CLI 与 MCP 对同一成功或失败调用返回逐字段等价的 canonical envelope。

### 2. 共享 collector 与 task_prepare

- `lib/context-collector.mjs` 承接 repository、Git、entry 与 Wiki 分支的并行收集；旧 collector 保持薄 wrapper。
- direct route 不解析项目、文档或 qmd；非 direct route 生成不可预测 scope，并复用已解析 context。
- capabilities 未知值统一为 false；公司 Wiki unavailable 时禁止 qmd 全局搜索和本地 Wiki grep 回退。

### 3. Scope、cache 与 qmd 生命周期

- scope 绑定 canonical root、Git identity digest、project fingerprint、config hash/revision、manifest hash/revision、host config/transport digest 与 TTL。
- 每次 scope 操作自动复核事实；变化或过期返回 `scope_expired`，清除 document/state/reference cache 并关闭旧 qmd。
- persistent qmd client 在同一 Sidecar scope 内复用一次 initialize/tools-list，exact read singleflight，断线最多安全重连一次。
- snapshot 临时 qmd、失败的 Wiki resolve、MCP EOF/shutdown 均显式释放资源；CLI 不宣称跨进程复用。

### 4. Phase 2 确定性能力

- 项目/Git：`project_snapshot`、`project_context`、`git_preflight`、`diff_snapshot`。
- 文档只读：`document_resolve`、`document_search`、`document_get`、`document_manifest`、`document_verify`；本地路径仅通过 opaque `document_ref` 间接使用。
- 上下文与验证：`context_collect` 从 scope 取 runtime context；`verification_run` 必须带 live scope，只运行安装包固定 profile。
- 状态与 preview：session/checkpoint/session_record 全部绑定 scope 和 TTL；幂等 payload 冲突返回 `session_conflict`；commit/merge preview 只返回 Git 事实与 plan digest。

### 5. 真实 verification runner

- 固定 profile：`hps-unit`、`hps-regression`、`context-collector`。
- 使用 `spawn`、`shell:false`、固定 program/args、canonical cwd 和环境 allowlist。
- 覆盖 pass/fail/timeout/abort、SIGTERM/SIGKILL、stdout/stderr 截断、凭据脱敏、local_process/network capability。
- 请求侧 command/argv/env/path/host override 一律拒绝。

### 6. MCP 完整生命周期

- 完整 initialize/initialized、tools/list/call、ping、并发、重复 ID、overload、timeout、`$/cancelRequest`、progress、逐帧大小、shutdown 与 EOF。
- 公开 19 个已实现工具；bootstrap、document change/transition 写工具不注册，CLI 返回 `operation_unavailable`。
- 旧 route、collector、document CLI 与 session hooks 仍保留原协议。collector、route bridge、SessionStart/End 已明确迁移到 shared Core；document CLI 仍是受控 compatibility writer，避免改变既有文档写语义。

## 2026-08-17 实现差距

协议收口已经完成：未知 operation、deferred operation 的优先级分别固定为 `operation_not_found` 与 `operation_unavailable`，CLI/MCP 等价测试已覆盖；`task_prepare` schema 已支持有界 `known_entry_files`/`wiki_root`，请求 root 不能覆盖 runtime trusted root；MCP tool description 已包含用途、scope 前置条件和调用顺序。迁移仍未完成的核心是 legacy route 的 agents/project apply、local context resolve 和 Git 预检语义，Skill 默认切换前必须补共享 prepare/apply 内核或有明确安全门的初始化回退。

| 差距 | 当前事实 | 完成要求 |
|---|---|---|
| Skill 默认接入 | 已完成：using/brainstorming/document-management、route、hooks 已进入 HPS；document 读走 HPS、写走受控兼容入口，并有调用链探针 | 高频确定性路径默认调用 HPS/Core；旧入口只保留为薄兼容层，并有调用链测试 |
| MCP 宿主注册 | 已完成；主根 `bin/hps`、Claude/Codex project-local MCP 连接通过 | 保持不修改用户全局配置；Codex 默认 runner 仍需 API key 有效 |
| `project_snapshot` scope | schema 接受 `scope_id`，运行时未使用该参数 | 解析、校验并复用 live scope；过期或不匹配返回稳定错误 |
| `project_snapshot` remote | 设计要求 remote 摘要，当前结果缺失 | 返回规范化、脱敏、固定字段的 remote 摘要并补等价性测试 |
| state 正文安全 | 当前主要按字段名拒绝 `content/body/path`，其他载体名可绕过 | 递归检查嵌套字符串和内容特征；源码、diff、日志、正文、URI、凭据稳定拒绝且不回显 |
| capability adapter | Codex/Claude 必需 adapter、Skill discovery 与 fail-closed probe 已通过；OpenCode adapter 保留为可选兼容实现 | Codex API key 修复后完成默认 runner；OpenCode 不作为当前验收门，unknown 保持 false |
| Codex/Claude 完整验收 | portable helper、stdin 转发、native probe fixture、runner shell smoke、Claude project-local MCP 连接和真实 Claude probe 已通过；Codex agent=`prerequisite_auth`（401 invalid_api_key） | 更新 Codex API key 后运行 Codex 完整 runner |

2026-08-17 最新实现证据还包括：scoped snapshot 复用 live scope 并对 Git/config/manifest/transport 变化 fail closed；session/checkpoint 使用递归 typed control-state schema；known-entry symlink/realpath 越界被拒绝；可信 personal Wiki root 只能来自验证后的 `wiki.local_root`；MCP cancel/timeout/EOF/shutdown 等待底层 operation settle 并释放 scope/qmd；CLI one-shot runtime 始终关闭；Codex/Claude 必需 capability adapter、OpenCode 可选兼容 adapter、registration generator 和 portable timeout helper 已有专项测试。当前合并回归需在 host registration 文件稳定后重新采样。
| 主线和发布 | 所有 HPS 文件与本计划仍只在未提交 worktree | 完成审查、提交、集成、安装/版本验证后分别记录 |

## 性能与安全验收

真实 worktree I/O benchmark 不注入空 projectSnapshot/collector。2026-08-14 记录属于历史 Core 基线，不代表 2026-08-17 的完整交付验收：

- cold `hps call`：最新 fresh 并行回归 P50 约 100.73ms、P95 约 113.11ms。
- warm Sidecar `project_snapshot`：P50 约 0.00ms、P95 约 0.01ms，门槛 <100ms。
- direct `task_prepare`：P50 约 0.49ms、P95 约 2.28ms，门槛 <=200ms。
- collector-backed slow `task_prepare`：P50 约 89.54ms、P95 约 126.93ms，门槛 <=1.2s。

最新 fresh 复核中的 cold CLI P50/P95 约 101/113ms，slow prepare 约 90/127ms，warm snapshot P50/P95 约 0.00/0.01ms，满足阶段阈值；真实宿主 CLI 仍需在对应环境重跑。

安全矩阵覆盖 read-only、workspace_write=false、local_process=false、external_network=false、unknown capability、Wiki unavailable、任意 shell/argv/env/host/path/URI/collection 拒绝和 no-mutation 证据。

## 已有验证记录

- `node --test tests/context-collector/collector.test.mjs tests/wiki-docs/*.test.mjs tests/hps/*.test.mjs`：386/386 通过，0 failed、0 skipped；包含 route bridge、hooks、Claude MCP protocol negotiation 和 stdin timeout；OpenCode 按当前决策不验收。
- `bash tests/opencode/run-tests.sh`：2/2 通过。
- Codex legacy compatibility 4/4；主根 native probe direct version/call/MCP 通过，临时 project-local MCP connected，但 agent 返回 401 invalid_api_key；native 主安装根已具备 `bin/hps`。
- Claude Skill discovery 通过；主根 native probe project-local MCP 显示 `hps: connected`、19 个工具可见，API 调用完成，runtime_doctor 在 dontAsk 下 permission-blocked，整体 probe pass。
- portable timeout shell/Node smoke 已通过，并已覆盖 stdin 转发；native probe 专项 fixture 9/9 通过；默认 runner/native root 仍未完成。
- native probe 是独立只读验收入口，尚未接入两个宿主默认套件；完整默认 runner 仍需在宿主前置条件满足后单独通过。
- 这些证据证明 Core 回归和局部兼容性，不证明 Codex/Claude 默认接入或发布可用；OpenCode 不属于当前支持承诺。

## 收口批次与完成门

1. 契约收口：修复 `project_snapshot` 的 `scope_id` 使用和 remote 摘要；补 CLI/MCP/schema/失效测试。Expected：专项 RED 先失败，修复后相关 HPS 测试全绿。
2. 状态安全：以递归 payload 检查替代字段名黑名单；覆盖别名、嵌套数组/对象、源码/diff/日志/URI/凭据。Expected：受阻内容不落盘、不进入错误或 progress。
3. Skill 与入口迁移：让 route、hooks 和目标 Skill 的确定性部分委托 Core；document 写保留受控 compatibility path；保留原协议。Expected：调用链探针证明默认路径进入 HPS，原回归仍通过。
4. 宿主适配：实现 Codex/Claude 必需 capability adapter 与 Sidecar 发现/注册闭环；OpenCode 仅保留可选兼容实现。Expected：能力值来自 fixture/宿主事实，unknown 全为 false，安装不静默改全局配置。
5. Portable 验收：以仓库内 Node/shell helper 替换 GNU `timeout` 假设。Expected：Codex、Claude 完整 runner 在 macOS/Linux 可执行并通过；OpenCode 暂不执行，不阻塞本阶段。
6. 最终交付：fresh 全量测试、性能、安全矩阵、`git diff --check` 和范围审查。Expected：无 Phase 1/2 TODO 或跳过项后，才可进入提交、主线集成和发布流程。

完成状态按以下五层单独更新：

| 层级 | 当前状态 | 标记完成所需证据 |
|---|---|---|
| 代码存在 | 已完成 | 指定 worktree 中实现可调用 |
| 测试通过 | 部分完成 | Core/collector/Wiki/HPS/route/hooks/adapter/registration/portable fresh 全绿；Codex/Claude 显式宿主探针有证据，完整默认 runner/native root 仍待收口；OpenCode 按决策排除 |
| Skill 接入 | 已完成 | route bridge、hooks HPS gate、`tests/hps/skill-entrypoint-chain.test.mjs` 调用链探针与兼容 wrapper 测试通过；document 读走 HPS、写走受控 compatibility path |
| 主线集成 | 未完成 | commit/PR/merge 事实 |
| 发布 | 未完成 | 版本、安装、宿主注册与发布 smoke |

## 提交边界

当前未自动 commit、push、merge 或创建 PR。即使收口批次测试全部通过，也只能先把前三层更新为完成；主线集成和发布必须依据各自事实单独更新。
