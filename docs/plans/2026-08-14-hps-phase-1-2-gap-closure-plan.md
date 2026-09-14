# HPS Phase 1/2 Gap Closure Plan

## 当前状态

状态：2026-08-18 事实复核后更新。Core、CLI、MCP、19 个公开 operation、persistent qmd、协议/安全/生命周期收口、Codex/Claude 必需 capability adapter、注册模板和 portable helper 已实现；legacy route/hooks 兼容桥与默认 hooks 的 HPS 边界已接入并通过回归。HPS native CLI 已按授权安装到 `/Users/ugreen/hors/horspowers`，未删除文件、未修改全局 MCP 配置。Claude 使用 user API-key settings 后真实 probe `status=pass`；Codex HPS direct CLI/MCP 通过，但真实 agent 返回 `401 invalid_api_key`，分类为 `blocked_prerequisite/prerequisite_auth`。主线集成和发布尚未完成。OpenCode 暂不纳入完整支持和验收范围。

本计划是 Phase 1/2 的唯一收口状态源。其他文档中的历史“全部完成”记录均以本页为准；只有下面的批次和完成门全部满足后，才能再次标记 Phase 1/2 完成。冲突时采用更严格要求，不延期、不弱化验收、不用空测试桩或局部 smoke 代替完整证据。

## 不变量

Skill 保留推理和编排，HPS 只承接确定性执行。禁止任意 shell、argv、env、host、URI、collection 或 path；子进程使用固定 program/args 与 `shell:false`，继承沙盒限制。公司 Wiki fail closed。不删除文件，不自动 commit/push/merge/PR。每个新增行为先 RED，再最小 GREEN 与受影响回归。

## Core 已实现批次

### 批次 1：严格协议与共享 dispatch - 完成

单一 operation registry、逐操作字段/类型/必填/互斥约束、强类型 MCP schema、CLI/MCP canonical envelope 等价、稳定 HpsError 与 deferred `operation_unavailable` 已实现。

### 批次 2：Scope、snapshot 与 document cache - 完成

snapshot 基础聚合、TTL/singleflight、敏感路径 dirty、opaque document ref、document manifest/verify、自动 scope facts 校验和 cache/state/qmd 失效已实现。scope 绑定 Git identity、project/config/manifest/host/transport digest 与 revision；`project_snapshot` 对传入 scope 的使用和 remote 输出仍由批次 8 收口。

### 批次 3：Persistent qmd read session - 完成

同 scope 一次 spawn/initialize/tools-list、exact read singleflight、一次安全重连、显式 close，以及失败 resolve、snapshot、scope invalidation、MCP EOF/shutdown 的释放路径已实现。

### 批次 4：真实 verification runner - 完成

`hps-unit`、`hps-regression`、`context-collector` 固定 profile 使用真实 subprocess；覆盖 canonical cwd、env allowlist、timeout/abort/kill、bounded stdout/stderr、redaction 与 process/network gate。

### 批次 5：完整 MCP 生命周期 - 完成

initialize/initialized、唯一 request ID、并发、cancel、timeout、overload、native progress、逐帧大小限制、EOF 等待、shutdown 拒绝新调用及资源关闭全部实现。

### 批次 6：State、preview 与兼容 wrapper - 已完成（route/hooks；document 保留兼容）

session/checkpoint/session_record 的 live scope、TTL、payload conflict、commit/merge preview 与递归 typed control-state 安全已经实现；正文、源码、diff、日志、URI、路径、凭据及非类型 carrier 会在写 store 前稳定拒绝且不回显。route 已通过 HPS bridge 保持旧 envelope 等价并只在需要写入时单次 fallback；SessionStart 使用 HPS doctor，SessionEnd 使用同进程 HPS session gate 后再走一次受控 DocumentRuntime 写入。document CLI 仍是兼容入口，尚未改为 HPS 文档写能力。

### 批次 7：真实性能与 Core 安全矩阵 - Core 完成

benchmark 使用真实 worktree cold CLI、warm snapshot、direct prepare 以及真实 `rg`/Git/entry collector I/O。Core 安全矩阵覆盖 unknown/process/network/read-only/Wiki unavailable/非法载荷/no mutation，acceptance 锁定 19 个工具与强类型 schema。Codex/Claude 真实宿主 capability 和完整 runner 仍未验收；OpenCode 按决策排除。

## 必须完成的收口批次

### 批次 7A：协议优先级与迁移前置门

- 未知 operation 当前可能返回 `invalid_request`；deferred operation 携带未知字段也可能先失败于 schema。先补 RED，固定未知 operation 为 `operation_not_found`、已识别 deferred operation 为 `operation_unavailable`，并验证 CLI/MCP 等价。
- `task_prepare` 的 schema 已支持有界 `known_entry_files`/`wiki_root`，且 request root 不能提升可信 Wiki 权限；迁移前仍必须覆盖 legacy route 的 agents/project apply、local context resolve 和 Git 预检，或走有明确安全门的初始化回退。
- MCP 工具描述需提供用途、scope 前置条件与推荐调用顺序；仅有 `HPS ${name}` 不能作为 Agent discoverability 验收证据。

### 批次 8：Snapshot 契约对齐

- 文件：`lib/hps-runtime.mjs`、`lib/hps-operations.mjs`、`tests/hps/phase2-acceptance.test.mjs`、`tests/hps/contract-equivalence.test.mjs`、`tests/hps/scope-cache.test.mjs`。
- 先新增失败测试，证明当前 `project_snapshot` 忽略 `scope_id` 且缺少 remote 摘要。
- 实现必须校验和复用 live scope，过期、不匹配或未知 scope 返回稳定错误；remote 只返回规范化、脱敏、固定字段摘要。
- Expected：CLI 和 MCP 对 success/error/result/metrics 等价，scope facts 变化后 snapshot fail closed。

### 批次 9：State 正文安全收口

- 文件：`lib/hps-runtime.mjs`、`tests/hps/state-preview.test.mjs`、`tests/hps/sandbox-matrix.test.mjs`。
- 先增加别名字段、深层对象、数组、长文本、源码、diff、日志、URI 和凭据载荷的失败测试。
- 安全检查递归覆盖所有字符串和容器，不依赖 `content/body/path` 等字段名；拒绝结果、错误和 progress 均不得回显原文。
- Expected：合法短小控制面状态仍可 round-trip；所有正文载体稳定拒绝且没有 state/cache mutation。

### 批次 10：Skill 与兼容入口默认迁移 - 部分完成（route/hooks 已收口）

- 文件：`skills/using-horspowers/SKILL.md`、`skills/using-horspowers/references/host-path-resolution.md`、`skills/document-management/SKILL.md`、`skills/brainstorming/SKILL.md`、`lib/session-hook-runtime.mjs`、相关旧 CLI/wrapper 和调用链测试。
- Skill 保留判断、交互与编排，只把 route、document、context 和 session 的确定性步骤切到 HPS/Core；旧 stdin/stdout 契约继续可用。
- 优先调用已发现安装根下的 `bin/hps`，无 Sidecar 时回退 `hps call` 或薄 wrapper；禁止扫描用户目录或猜路径。
- Expected：调用链探针证明正常 Skill 路径进入 shared Core，旧入口回归与 direct 快路径均保持通过。当前 route/hook 调用链已满足；document 写入口仍保留 DocumentRuntime compatibility path。

### 批次 11：真实 capability adapter 与 MCP 注册/发现 - 部分完成（fixture + project-local 实宿主）

- 文件：HPS runtime/capability 模块、`.codex-plugin/plugin.json`、`.codex/INSTALL.md`、Claude/OpenCode 安装入口及对应测试。
- 定义统一宿主 capability 输入，由 Codex、Claude Code adapter 从可验证宿主事实映射 workspace read/write、network、process、approval；OpenCode adapter 仅保留兼容扩展；unknown 一律 false。
- 提供 `hps` 可执行和 `hps serve --stdio` 的可发现注册方式，不静默修改用户级配置，不把 Sidecar 当作沙盒绕过通道。
- Expected：fixture 与 adapter smoke 的 capability 一致；未提供事实时 fail closed；Codex/Claude 必需 registration generator 可从 native installation root 生成 project-local CLI/Sidecar 配置，不改全局配置；OpenCode 不作为当前验收门。当前主安装根 `/Users/ugreen/hors/horspowers/bin/hps` 已可执行，Claude project-local MCP 真实 probe 通过，Codex 临时 project-local MCP 配置准确指向主根 `bin/hps`；native registration 已完成，Codex agent 仍受 API key 前置条件阻塞。

### 批次 12：Portable Codex/Claude 验收 - 部分完成（真实宿主只读探针）

- 文件：`tests/codex/run-tests.sh`、`tests/claude-code/run-skill-tests.sh`、`tests/claude-code/test-helpers.sh`、使用 `timeout` 的相关 runner、共享 portable timeout helper 及测试。
- 用仓库内 Node/POSIX-compatible helper 替换对 GNU `timeout` 的硬依赖；保留退出码、stdout/stderr、超时终止和子进程清理语义。Codex/Claude runner 与 skill-triggering runner 已切换。
- Expected：Codex、Claude Code 完整 runner 在 macOS 和 Linux 可进入真实宿主 probe 并通过；OpenCode 按用户决策排除；缺少 Codex/Claude 宿主二进制时只能报告明确 prerequisite，不能记为通过。当前 native probe runner 代码和 fixture 已完成：Codex direct/MCP 通过但 agent 调用分类为 `timeout`，Claude MCP 连接/19 工具通过但分类为 `prerequisite_auth`；因此完整默认 runner、native 主安装根暴露仍未完成。

### 批次 13：最终验收与集成准备

- 重跑 HPS、context collector、router、Wiki、Codex/Claude、性能和安全矩阵；运行 `git diff --check` 并审查无 skipped Phase 1/2 requirement、TODO、空 I/O stub 或未声明 mutation；OpenCode 不纳入本阶段验收。当前 HPS/collector/Wiki 回归为 386/386，Codex/Claude 真实探针证据已记录，但 native 安装根与主线/发布仍未完成。
- 更新本页五层状态。代码和测试层完成后进入正式 review；commit、PR、merge 与发布由用户选择，不能被测试结果自动标记完成。
- Expected：所有阶段内验收均有 fresh 命令、退出码和计数证据，设计与计划口径一致。

## 当前证据与限制

- warm snapshot P50 <100ms：最新 fresh 回归约 0.00ms，P95 约 0.01ms。
- direct prepare P50 <=200ms：最新 fresh 回归约 0.49ms，P95 约 2.28ms。
- collector slow prepare P50 <=1.2s：最新 fresh 回归约 89.54ms，P95 约 126.93ms。
- cold CLI 单独记录：最新 fresh 回归 P50 约 100.73ms、P95 约 113.11ms。
- 最新 fresh 全量（基线，native probe fixture 加入前）：386/386 通过，0 failed、0 skipped（collector + Wiki + HPS 回归；包含 route bridge、hooks、Claude MCP 协议协商和 stdin timeout 回归）。native probe 专项：9/9 通过。
- OpenCode fixture：2/2 通过，仅作为兼容证据，不属于当前验收门。
- Codex：legacy compatibility 4/4；主根 native probe direct version/call/MCP 全通过，临时 MCP 配置 connected，但 agent 返回 401 invalid_api_key（`blocked_prerequisite`, `prerequisite_auth`）；native 主安装根已具备 `bin/hps`。
- Claude：原生 Skill discovery 通过；主根 native probe project-local MCP 连接成功，19 个 `mcp__hps__*` 工具已注册，API 调用完成，runtime_doctor 调用一次但 dontAsk 权限阻止（整体 `pass`）。
- 仓库内 portable timeout helper 已替换 runner 对 GNU `timeout` 的依赖，并已补 stdin 转发；macOS/Linux shell smoke 与 Node 回归通过。OpenCode 按决策不验收。
- `scripts/run-hps-native-host-probe.mjs` 是独立、只读、临时 artifact runner，当前尚未接入 `tests/codex/run-tests.sh` 或 `tests/claude-code/run-skill-tests.sh`；因此专项 9/9 通过不等同于两个默认套件完整通过。
- 最新 fresh 性能：cold CLI P50/P95 约 101/113ms，slow prepare P50/P95 约 90/127ms，warm snapshot P50/P95 约 0.00/0.01ms，满足阶段阈值。

## 五层交付矩阵

| 层级 | 2026-08-17 状态 | 完成证据 |
|---|---|---|
| 代码存在 | 已完成 | Core、CLI、MCP 与 19 个 operation 在 `codex/hps-agent-cli` worktree 可调用 |
| 测试通过 | 部分完成 | 386/386 Core/collector/Wiki/HPS/route/hooks/adapter/registration/portable 基线通过，native probe 专项 9/9、host registration 16/16 通过；Claude 真实 probe pass，Codex 真实 probe 被 invalid_api_key 阻塞；Codex 默认 runner 仍待收口，OpenCode 按决策排除 |
| Skill 接入 | 部分完成 | using/brainstorming/document-management 默认确定性边界、route bridge、SessionStart/End HPS gate 已接入；document 写入口仍是兼容路径 |
| 主线集成 | 未完成 | 当前文件未提交，分支未合入主线，无 PR 事实 |
| 发布 | 未完成 | 无版本、安装、MCP 注册和发布 smoke 证据 |

### 2026-08-17 批次 8/9 与协议生命周期复核

- 批次 8 已完成：`project_snapshot(scope_id)` 复用并重验 live scope，固定输出规范化脱敏 remote；Git/config/manifest/host/transport/null transition 任一变化均返回 `scope_expired`，qmd 与 snapshot 竞态清理有回归测试。
- 批次 9 已完成：session/checkpoint/session_record 使用递归 typed control-state schema，拒绝正文 carrier、循环/accessor/symbol、超深/超大结构；拒绝不写 state/cache，返回值与内部缓存深度隔离。
- 协议与生命周期补充项已完成：unknown/deferred canonical error、`task_prepare` collector schema、MCP tool discoverability/cwd、request ID 有界历史、cancel/timeout/EOF/shutdown settle、late qmd cleanup、CLI one-shot close 和 canonical error catalog 均有测试。
- 可信 Wiki 边界已完成：known-entry symlink/realpath containment、`O_NOFOLLOW`/bounded stream、只有 validated host config `wiki.local_root` 能产生 trusted personal Wiki root，未验证时 fail closed。
- 最新合并回归：运行 `node --test tests/context-collector/collector.test.mjs tests/wiki-docs/*.test.mjs tests/hps/*.test.mjs` 得到 386/386；另有 capability、registration/native-root、Claude project-local MCP、真实 Skill discovery 与 portable stdin smoke 证据。此证据不覆盖 native 主安装根、完整默认 runner、主线或发布。

## 最终完成门（未通过）

1. 批次 8 至 12 全部完成，各批次先有 RED 再有 GREEN 和受影响回归。
2. 通过 DocumentRuntime 重新读取 Phase 1、Phase 2 和本修复计划，确认状态、错误码和阶段边界一致。
3. 运行 fresh 全量回归、Codex/Claude 完整 runner、性能、安全矩阵、`git diff --check` 与 `git status`。
4. 审查 diff，不得存在 skipped Phase 1/2 requirement、TODO、隐藏空 I/O stub 或把局部 smoke 计为完整验收。
5. 只有“代码存在、测试通过、Skill 接入”三层都有证据，才可把 Phase 1/2 实现状态标记完成。
6. 主线集成和发布继续保持独立状态；加载 finishing-a-development-branch 后仅给出集成选项，不自动执行。

## 范围说明

`project_bootstrap_*`、`document_change_*` 和 `document_transition_*` 是设计中明确的 Phase 5 后续写能力，不属于 Phase 1/2 公开工具完成门；当前保持不注册和 `operation_unavailable`。公司项目直接初始化 Wiki、Inbox submit 和状态 transition 仍不可作为 Phase 1/2 已实现效果宣传，这与阶段内必须修复的接入/契约缺口不同。
