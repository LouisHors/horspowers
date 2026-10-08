# HPS Agent-first Core、CLI 与 MCP Sidecar 设计

## 状态与目标

- 日期：2026-08-13；最近事实校准：2026-08-17；分支：`codex/hps-agent-cli`。
- 设计状态：目标已批准；Phase 1/2 Core、协议/安全/生命周期收口、真实 capability adapter、宿主注册模板和 portable helper 已实现；默认 Skill 的确定性边界、legacy route bridge、SessionStart/End HPS gate 已切到 HPS。Codex/Claude Skill discovery 与 Claude project-local MCP 已验证；native 主安装根、完整默认 runner、主线集成和发布仍在收口，不能标记为完整交付。
- 目标：统一 Horspowers 高频、可复用、确定性的执行能力，减少进程启动、重复项目解析、SSH/qmd 重连和 Agent 工具往返。
- 非目标：不合并全部 Skill、测试和辅助脚本；不删除现有入口；不扩大沙盒、网络或文档权限；第一版不做 daemon、HTTP、WebSocket 或 Unix socket。

## 核心判断

当前主要瓶颈不是脚本文件数量，而是 Agent 多轮调用、重复解析 Git/项目/Wiki 配置和每次 qmd 读取的新 SSH/MCP 握手。本机基线为 route 约 100ms、document resolve 约 100ms、context collect 约 848ms；仅换命令外壳收益有限，必须做组合调用与会话内复用。

## 架构

- `Horspowers Core`：共享 router、project identity/context、document runtime、context collector、session runtime 和 transport。
- `hps call`：Agent/CI 的 JSON stdin/stdout 回退入口。
- `hps serve --stdio`：宿主管理的 MCP Sidecar，负责工具发现、结构化调用、scope/cache、进度和取消。
- `bin/hps` 是唯一缩短的可执行名；品牌、Skill namespace、插件 ID、配置文件、环境变量和 Wiki marker 继续使用 `horspowers`。
- 旧 route-request、document-runtime-cli、collect-context 和 hooks 保留为薄兼容 wrapper，逐步改为调用 Core。

## Agent-first 协议

`hps call` 接收 `{schema_version,request_id,operation,cwd,input}`；stdout 只输出一个 JSON，stderr 只输出脱敏 NDJSON progress；不使用颜色、表格和交互提示，正文不进入 argv、环境变量、进程标题或日志。CLI 单请求以 EOF 结束；MCP 使用逐行 JSON-RPC framing，测试覆盖分块输入、无尾随换行和 PTY 边界。

### 入口与操作映射

Core 先执行一次 operation 并生成统一 result envelope；CLI 和 MCP 只负责传输编码，禁止在两个入口各自解释业务结果。

| Core operation | `hps call` 请求 | MCP tool | 输入映射 | 输出约束 |
|---|---|---|---|---|
| `task_prepare` | `operation=task_prepare`, `cwd`, `input` | `task_prepare` | `cwd` 保留在 envelope；`input` 作为 tool arguments | `result/error/metrics` 完全相同 |
| `document_resolve` / `document_search` / `document_get` / `document_manifest` / `document_verify` | 同名 `operation` | 同名 tool | tool arguments 等价于 `input`；`scope_id` 显式传递 | 不暴露凭据和远端 stderr；manifest/verify 不返回正文 |
| `project_snapshot` / `project_context` / `git_preflight` / `diff_snapshot` | 同名 `operation` | 同名 tool | `cwd`、`scope_id`、`input` 一一对应 | 只读、固定字段 |
| `context_collect` / `verification_run` | 同名 `operation` | 同名 tool | 同上；profile 仅传 ID | progress 仅作为 transport 事件 |
| `session_prepare` / `session_record` / `checkpoint_get` / `checkpoint_put` | 同名 `operation` | 同名 tool | `scope_id` 和结构化输入显式传递 | 不保存凭据/投稿正文 |
| `commit_preview` / `merge_preview` | 同名 `operation` | 同名 tool | preview 参数等价于 `input` | 只生成计划，不执行写入 |
| `runtime_doctor` | `operation=runtime_doctor` | `runtime_doctor` | 仅接受协议允许的诊断输入 | 只报告脱敏能力和运行状态 |

CLI stdout 的 envelope 与 MCP `tools/call` 的返回内容必须可按 `schema_version/request_id/status/result/error/metrics` 逐字段比较；CLI stderr 的 progress event 对应 MCP `notifications/progress`，不改变最终 envelope。未知 operation 由 Core 返回 `operation_not_found`。

当前契约已经固定未知 operation 与 deferred operation 的校验优先级：未知 operation 返回 `operation_not_found`，已识别但 deferred 的 operation 即使携带未知字段也优先返回 `operation_unavailable`；CLI/MCP 等价测试已覆盖两条路径。`task_prepare` schema 已接受有界 `known_entry_files`/`wiki_root`，但 request 中的 Wiki root 不能提升权限，collector 只使用经过 host config 验证的 canonical trusted root。legacy route 的 agents/project apply、local context resolve 与 Git 预检仍需在默认 Skill 迁移批次保持语义等价。

第一轮实际暴露的工具仅限上述 Phase 1/2 operation；bootstrap、document submit/transition 和其他写工具在 Phase 5 前不得注册到 `tools/list`，即使 Core 内部保留类型定义也必须统一返回 `operation_unavailable`。

完整产品路线中的操作：

- `task_prepare`：一次完成高置信度 route、Git/project identity、document backend resolve；仅当 context policy 要求时并行收集 Wiki、repository、Git 和入口文件；返回 target skill、scope、next actions、capabilities 和 metrics；direct 路径不启动 qmd/context。
- `document_resolve/search/get`：只读，受已验证 collection、project root 和 manifest 约束。
- `document_change_preview/submit`、`document_transition_preview/submit`：Phase 5 写能力；读写分离，submit 重验身份、manifest、revision 和 digest。
- `project_bootstrap_preview/submit`：Phase 5 写能力；生成 Registry、config、initial context、manifest、content hashes 和幂等 ID；submit 只投 Inbox，不直接写 Wiki。
- `session_record`、`runtime_doctor`：会话记录和能力/性能诊断。第一版不提供删除工具。

## Sidecar scope、缓存和 qmd 复用

Sidecar 返回内存不透明 `scope_id`，绑定 canonical root、Git identity digest、project fingerprint、host config digest、Registry/config/manifest revision/hash、能力快照和短 TTL。`scope_id` 只在当前 Sidecar session 内有效；CLI 不持久化 scope，每次调用都重新解析或在单次组合请求内复用。Git/host config/manifest/transport/TTL 变化即失效，后续调用统一返回 `scope_expired`，不得隐式扩大 scope。`task_prepare` 是唯一创建/刷新 scope 的入口；Agent 必须重新调用 `task_prepare` 后再重试，其他工具不自动恢复。MCP session 关闭即丢弃所有 scope。 不缓存确认、审批、凭据、投稿正文、未入库 Inbox 或跨会话权限。同 scope 与 exact URI 的并发读可 singleflight，写不合并。

2026-08-14 的严格差距修复基线已把 qmd persistent read session 提前纳入 Phase 1/2，并取代原先“延期到 Phase 4”的安排。Sidecar 在固定 transport key 和 live scope 内维护最多一个只读 session，复用 initialize/tools-list、支持 exact read singleflight 和最多一次安全重连；不允许动态 SSH alias、任意命令或 Shell。CLI 仍不得宣称跨进程或跨请求复用。该调整只提前只读性能能力，不把 Phase 5 写能力带入 Phase 1/2。

### MCP stdio 生命周期

Sidecar 使用换行分隔 JSON-RPC 2.0。server stdout 只能输出协议帧；日志和 progress 走 stderr。启动后必须完成 `initialize` 请求/响应和客户端 `notifications/initialized`，再允许 `tools/list`、`tools/call`。server capabilities 至少声明 `tools`，不声明未实现的分页、采样或资源能力。request id 允许 JSON-RPC string/number，单个 session 内不得重复；请求可并发，但每个响应 id 必须对应原请求。允许 `$/cancelRequest`，取消后返回稳定 `cancelled` error；progress token 通过 MCP 原生通知传递。拒绝空行、超过单帧大小或非法 JSON；兼容 CRLF、分块输入和无尾随换行。`shutdown` 后停止接收新请求并在 EOF 退出，不监听网络端口。

## 沙盒和安全

命令及子进程继承宿主沙盒；Sidecar 不是越权通道。返回 `workspace_read/write`、`external_network`、`local_process`、`wiki_read/submit`、`persistent_session`、`approval_available`，unknown 不得视为 true。HPS 不修改 config.toml、不扩大 writable_roots、不启动代理或 socket 绕过限制。network off 时 SSH/qmd 返回 `network_required`，公司项目不回退本地 Wiki grep；read-only 时 submit 返回 `permission_required`。环境变量显式 allowlist，错误不回显远端 stderr、凭据和不必要路径。

MCP 工具按读写和副作用拆分并标注 readOnlyHint/destructiveHint/openWorldHint；注解不代替服务端授权、输入、revision 和 digest 校验。

capability envelope 必须来自宿主或启动适配器提供的真实能力事实，而不是由 HPS 静态假设。Codex、Claude Code 是当前必需宿主，各自需要显式 adapter；OpenCode adapter 可保留为兼容扩展，但暂不承诺完整支持或真实验收。所有宿主都把可确认的 workspace read/write、network、process 和 approval 状态映射为 `true` 或 `false`；缺失、未知或无法验证的值保持 `false`。Sidecar 声明 `persistent_session=true` 只表示本进程具备复用机制，不能推导网络、写入或审批权限。

session/checkpoint 只允许保存控制面字段和短小结构化状态。安全检查必须递归覆盖所有字符串值和嵌套容器，不能只按 `content`、`body`、`path` 等字段名判断；源码、diff、日志、文档正文、URI、凭据或可作为正文载体的长文本必须稳定拒绝。错误不得回显被拒绝的正文。

## 错误、进度和 bootstrap

结果 envelope 为 `{schema_version,request_id,status,result,error,metrics}`；error 使用稳定 code/category/retryable/required_action。CLI stderr 或 MCP progress 报告阶段开始/完成，长阶段持续报告，支持取消。

Bootstrap 本机入库分阶段并明确成功边界：`core_committed`（Registry/config/manifest/context 事务包生成并成功投稿 Inbox）→ `index_pending`（等待 qmd refresh）→ `index_refreshed` 或 `index_failed`。qmd refresh 属于附属阶段，不阻塞核心事务；任何 refresh 失败都返回 `core_committed + index_pending/index_failed`，不得伪报 bootstrap 完成。entity/source/MOC/README/overview 导航同步仍是附属阶段。Horspowers 负责事务包和 Inbox 投稿，my-code-wiki native CLI 负责审核入库。

### Preview / submit 与审批

HPS 不自行弹出确认窗口；审批由宿主 Agent/UI 的工具审批层负责。preview 返回事实快照、受影响目标、`plan_digest`、当前 revision 和所需 capability。submit 必须显式携带 `scope_id`、`plan_digest`、preview revision 以及宿主签发的 `approval_token`（若宿主支持），并重新解析身份、manifest、revision 和目标事实；任一变化返回 `conflict`。审批能力未知或不可用时，submit 稳定返回 `approval_required`/`permission_required`，不猜测同意。CLI 与 MCP 只传递结构化确认结果，不保存 token 或 preview 跨 session。

## 验收与交付

功能验收：CLI/MCP 结果等价；direct prepare 不启动 context/qmd；慢路径只 resolve 一次并行收集；公司项目一次 prepare 只读一次 Registry/config/manifest；Sidecar 只 initialize/tools-list 一次；preview 后事实变化返回 conflict；read-only/network-off/Wiki-unavailable fail closed；无删除、任意 Shell/host/path。`project_snapshot` 在收到 `scope_id` 时必须使用并校验该 live scope，且返回经过脱敏和规范化的 remote 摘要。性能目标：普通 prepare 中位 <=200ms，本地慢路径 <=1.2s，公司项目较旧流程降低 >=30%，并返回 metrics/cache hits。

接入验收：旧入口保留协议，但其确定性执行必须委托共享 Core；目标 Skill 的正常路径必须默认调用 `hps`/Core，而不是继续直接启动旧实现。`task_prepare` 迁移必须保持 legacy `routeRequest` 的 agents block/project apply、local context resolve 与 Git 预检语义；在共享 prepare/apply 内核或安全初始化回退完成前，不能替换旧入口。MCP 工具描述必须包含用途、scope 前置条件和推荐调用顺序，不能只返回 `HPS ${name}`。宿主安装层必须提供可发现的 `hps` 路径和 `hps serve --stdio` 注册方式，且不静默修改用户全局配置。Codex、Claude Code 的完整 runner 必须使用仓库内 portable timeout helper，在 macOS/Linux 上实际执行并通过；OpenCode 暂不属于当前支持和验收范围。

交付状态必须按五层分别记录，后一层不能由前一层自动推导：

| 层级 | 完成定义 | 2026-08-17 状态 |
|---|---|---|
| 代码存在 | Core、CLI、MCP 和 operation 实现在开发 worktree 中可调用 | 已完成 |
| 测试通过 | 专项与受影响回归有 fresh 通过证据 | Core/collector/Wiki/HPS/registration/portable 目标回归已覆盖；真实 Codex/Claude CLI 探针需宿主可用后重跑，OpenCode 按决策排除 |
| Skill 接入 | 默认 Skill/hook/兼容入口实际复用 Core | 部分完成：using/brainstorming/document-management 默认边界、hooks 与 legacy route bridge 已写入 HPS；document 写入口保留受控兼容路径 |
| 主线集成 | 变更已提交并进入目标主分支 | 未完成 |
| 发布 | 安装、宿主注册、版本和发布验证完成 | 未完成 |

阶段基线：1) Core + `hps call` + `task_prepare` + doctor；2) MCP stdio、19 个公开工具、scope/cache/cancel、提前实现的 qmd persistent read session；3) 真实 capability adapter、安装注册模板和 portable helper 已完成，Skill 默认边界已迁移但 legacy route/hook 语义 smoke 仍待完成；4) Codex/Claude 真实 CLI 探针、主线集成；OpenCode 暂不纳入当前验收；5) bootstrap preview/submit、document submit/transition 与 Wiki native 快路径；6) 发布。Phase 5 写能力不属于 Phase 1/2 完成门，在公开工具集中继续保持未注册和 `operation_unavailable`。
