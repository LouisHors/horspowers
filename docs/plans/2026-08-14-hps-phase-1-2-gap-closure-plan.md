# HPS Phase 1/2 Gap Closure Plan

## 当前状态

状态：2026-10-08 事实复核后更新。本页是 Phase 1/2 的唯一收口状态源；历史文档中的"全部完成"记录均以本页为准。冲突时采用更严格要求，不延期、不弱化验收、不用空测试桩或局部 smoke 代替完整证据。

- Core、CLI、MCP、19 个公开 operation、persistent qmd、协议/安全/生命周期收口、Codex/Claude capability adapter、注册模板和 portable helper 已实现。
- legacy route/hooks 兼容桥与默认 hooks 的 HPS 边界已接入并通过回归。
- 回归确定性缺口（见批次 D）已定位并修复。
- 批次 D 的回归确定性缺口已定位并修复。
- **用户决策（2026-10-08）：Codex / Claude Code 适配暂不作为验收闸门，本轮只聚焦 Pi agent 适配。** 因此批次 11/12 的 native probe 接入不再阻塞 Phase 1/2 收口，只按事实记录。
- 批次 13（最终验收、主线集成）仍待完成。
- 主线集成与发布尚未完成：`codex/hps-agent-cli` 未合入 main，无 PR，无版本与发布 smoke。
- 上一版本页记录的"386/386 fresh 通过"不可复现（合并跑偶发失败）。该数字已被本次的 464/464 取代，原因见批次 D。

## 不变量

Skill 保留推理和编排，HPS 只承接确定性执行。禁止任意 shell、argv、env、host、URI、collection 或 path；子进程使用固定 program/args 与 `shell:false`，继承沙盒限制。公司 Wiki fail closed。不删除文件，不自动 commit/push/merge/PR。每个新增行为先 RED，再最小 GREEN 与受影响回归。

## 不变量：生成 id 必须能通过自身校验

任何由 runtime 生成、随后作为控制态回传的 opaque id（`scope_id`、`request_id`、`checkpoint_id`、`idempotency_key`、`document_ref`）必须满足 `stateStringIsSafe`。生成器不得使用会触发校验器的字符：

- 首字符必须是字母数字（`-`/`_` 开头会被拒）。
- 不得含 `-`：`-` 是词边界，`-var-` 会命中源码内容启发式；`sk-`/`gh?_`/`sk-proj-`/`github_pat_` 会命中凭据前缀检查。
- 不得含 `_`（`gh?_`/`github_pat_` 前缀）。

本次采用小写 hex（`randomBytes(12).toString('hex')`），字符集天然不含以上任何字符。

## 已完成批次

### 批次 1：严格协议与共享 dispatch - 完成

单一 operation registry、逐操作字段/类型/必填/互斥约束、强类型 MCP schema、CLI/MCP canonical envelope 等价、稳定 HpsError 与 deferred `operation_unavailable` 已实现。

### 批次 2：Scope、snapshot 与 document cache - 完成

snapshot 基础聚合、TTL/singleflight、敏感路径 dirty、opaque document ref、document manifest/verify、自动 scope facts 校验和 cache/state/qmd 失效已实现。scope 绑定 Git identity、project/config/manifest/host/transport digest 与 revision。

### 批次 3：Persistent qmd read session - 完成

同 scope 一次 spawn/initialize/tools-list、exact read singleflight、一次安全重连、显式 close，以及失败 resolve、snapshot、scope invalidation、MCP EOF/shutdown 的释放路径已实现。

### 批次 4：真实 verification runner - 完成

`hps-unit`、`hps-regression`、`context-collector` 固定 profile 使用真实 subprocess；覆盖 canonical cwd、env allowlist、timeout/abort/kill、bounded stdout/stderr、redaction 与 process/network gate。Electron 宿主下保留 `ELECTRON_RUN_AS_NODE` marker 且不扩大 env allowlist。

### 批次 5：完整 MCP 生命周期 - 完成

initialize/initialized、唯一 request ID、并发、cancel、timeout、overload、native progress、逐帧大小限制、EOF 等待、shutdown 拒绝新调用及资源关闭全部实现。

### 批次 6：State、preview 与兼容 wrapper - 完成（route/hooks；document 保留兼容）

session/checkpoint/session_record 的 live scope、TTL、payload conflict、commit/merge preview 与递归 typed control-state 安全已实现。route 已通过 HPS bridge 保持旧 envelope 等价并只在需要写入时单次 fallback；SessionStart 使用 HPS doctor，SessionEnd 使用同进程 HPS session gate 后再走一次受控 DocumentRuntime 写入。document CLI 仍是兼容入口，尚未改为 HPS 文档写能力。

### 批次 7：真实性能与 Core 安全矩阵 - Core 完成

benchmark 使用真实 worktree cold CLI、warm snapshot、direct prepare 以及真实 `rg`/Git/entry collector I/O。Core 安全矩阵覆盖 unknown/process/network/read-only/Wiki unavailable/非法载荷/no mutation，acceptance 锁定 19 个工具与强类型 schema。OpenCode 按决策排除完整支持与验收。

### 批次 7A：协议优先级与迁移前置门 - 完成

未知 operation 固定为 `operation_not_found`、已识别 deferred operation 为 `operation_unavailable`，CLI/MCP 等价有测试。`task_prepare` schema 支持有界 `known_entry_files`/`wiki_root`，且 request root 不能提升可信 Wiki 权限。MCP 工具描述提供用途、scope 前置条件与推荐调用顺序。legacy route 的 agents/project apply、local context resolve 与 Git 预检由批次 10 的 route bridge 覆盖。

### 批次 8：Snapshot 契约对齐 - 完成

`project_snapshot(scope_id)` 复用并重验 live scope，固定输出规范化、脱敏、固定字段的 remote 摘要；Git/config/manifest/host/transport/null transition 任一变化均返回 `scope_expired`，qmd 与 snapshot 竞态清理有回归测试。CLI 与 MCP 对 success/error/result/metrics 等价。

### 批次 9：State 正文安全收口 - 完成

session/checkpoint/session_record 使用递归 typed control-state schema，拒绝正文 carrier、循环/accessor/symbol、超深/超大结构；拒绝不写 state/cache，返回值与内部缓存深度隔离。合法短小控制面状态仍可 round-trip。

### 批次 10：Skill 与兼容入口默认迁移 - 完成

Skill 保留判断、交互与编排，只把 route、document、context 和 session 的确定性步骤切到 HPS/Core；旧 stdin/stdout 契约继续可用。优先调用已发现安装根下的 `bin/hps`，无 Sidecar 时回退 `hps call` 或薄 wrapper；不扫描用户目录、不猜路径。document 读写按 Phase 边界分流：只读走 HPS `document_*`/`hps call`，写操作走受控 `document-runtime-cli.mjs` 兼容入口。

证据（2026-09-14）：`tests/hps/skill-entrypoint-chain.test.mjs` 以真实子进程证明 `bin/hps call` 的 `task_prepare`/`document_resolve` 进入 shared Core、Phase 5 写操作返回 `operation_unavailable`、`document-runtime-cli.mjs` 兼容写入协议保持，以及 Skill 文本的读写分流；两者已加入 `hps-regression` verification profile。

### 批次 D：回归确定性收口 - 完成（2026-10-08）

用户决策把"合并跑偶发失败"作为独立优先项，先于新功能修复。修复前实测：`tests/context-collector + tests/wiki-docs + tests/workflow-router + tests/hps` 合并跑（按 gap plan 口径）约 30% 概率失败，且失败项不固定。

- **D1（真实 runtime bug，非仅测试）**：`scopeToken()` 使用 `randomBytes(18).toString('base64url')`，有 3.125% 概率首字符为 `-`/`_`，而 `stateStringIsSafe` 要求首字符为字母数字。实测 200000 次 `openScope`+`sessionPrepare` 中拒绝 6233 次（3.12%）。残余类别还包括 `-var-` 词边界片段与 `sk-`/`gh?_` 凭据前缀误判（实测约 1.5e-5）。
  - RED：`tests/hps/state-preview.test.mjs` 新增 `every generated scope id satisfies the control-state contract it is echoed through`（4096 样本，覆盖 3.125% 类别）与 `generated scope ids cannot collide with control-state content heuristics`。
  - GREEN：`scopeToken()` 改为 `randomBytes(12).toString('hex')`，并把"生成 id 必须能通过自身校验"写入本页不变量。
  - 证据：1,000,000 次迭代 `rejected: 0`（修复前 200,000 次拒绝 6233 次）。
- **D2（测试基础设施竞态）**：`tests/wiki-docs/skill-document-runtime-contract.test.mjs` 的仓库审计 `walk(repoRoot)` 会遍历仓库内 `tests/.artifacts/`（实测 42012 个目录、266MB，且随运行次数无界增长），而 `tests/hps/skill-entrypoint-chain.test.mjs` 会 `rm -rf` 该目录。并行时 `readdir` 撞上已删除目录导致随机失败，且审计成本随运行上涨。
  - RED：新增 `repository audit never traverses retained in-repo test artifacts`（确定性，不依赖竞态）。
  - GREEN：`ignoredAuditDirectories` 增加 `.artifacts` 与 `.horspowers`。
- 证据：合并套件连续 5 次全绿 464/464、0 failed、0 skipped；`tests/hps/*` 单独 177/177；`git diff --check` 干净。

### 剩余待办：测试 fixture 保留策略（未完成，低优先）

`tests/.artifacts/wiki-docs` 的 fixture 被有意保留用于调试（`retainedProject`），当前无保留上限，实测已 266MB / 42012 目录。批次 D 的审计跳过已使该增长不再影响回归确定性，但仍需一个显式的保留上限或清理入口。该项不阻塞 Phase 1/2 完成门。

## 必须完成的收口批次

### 批次 11：真实 capability adapter 与 MCP 注册/发现 - 代码完成，默认 runner 未接入

- 已完成：统一宿主 capability 输入；Codex、Claude Code adapter 从可验证宿主事实映射 workspace read/write、network、process、approval；OpenCode adapter 仅保留兼容扩展；unknown 一律 false（fail closed）。
- 已完成：`hps` 可执行与 `hps serve --stdio` 的可发现注册方式，不静默修改用户级配置，不把 Sidecar 当作沙盒绕过通道。
- 已完成：Codex/Claude 必需 registration generator 可从 native installation root 生成 project-local CLI/Sidecar 配置，不改全局配置。
- 已完成：Claude project-local MCP 真实 probe 通过；Codex 临时 project-local MCP 配置准确指向安装根 `bin/hps`。
- **移出闸门（用户决策 2026-10-08）**：`scripts/run-hps-native-host-probe.mjs` 接入 `tests/codex/run-tests.sh` 与 `tests/claude-code/run-skill-tests.sh` 不再是 Phase 1/2 完成门。
- **2026-10-08 fresh 探查事实（与旧记录不一致，以本次为准）**：以 worktree 根为 native installation root、60s 超时运行 native probe，两个宿主 `status` 均为 `failed`，agent 步 `exitCode: 124`（`classification: timeout`）；把超时提到 240s 后 Codex agent 步变为 `exitCode: 1`、`classification: failed`。两宿主的 direct 通道（`hps version`、`hps call`、`hps serve --stdio` 的 19 工具 MCP 握手）均通过，Codex `mcp list` connection 为 connected，Claude 为 connected / toolCount 19 / `runtime_doctor` 调用 1 次且 `permission_blocked`。
- **结论**：旧页记录的「Claude 真实 probe pass」「Codex blocked_prerequisite/prerequisite_auth」在本机不可复现；agent 步为宿主侧超时/退出失败，归因未定。因为该维度已移出闸门，本轮不再追因，但不得再声称通过。
- OpenCode 不作为当前验收门。

### 批次 12：Portable Codex/Claude 验收 - 部分完成（真实宿主只读探针）

- 已完成：用仓库内 Node/POSIX-compatible helper 替换对 GNU `timeout` 的硬依赖；保留退出码、stdout/stderr、超时终止和子进程清理语义；Codex/Claude runner 与 skill-triggering runner 已切换；stdin 转发已补，macOS/Linux shell smoke 与 Node 回归通过。
- 已完成：native probe runner 代码与 fixture 完成；Codex direct/MCP 通过、Claude MCP 连接与 19 工具注册通过。
- **未完成 → 移出闸门（用户决策 2026-10-08）**：把 native probe 接入两个默认 runner 并在 macOS/Linux 实跑，不再是 Phase 1/2 完成门；该工作推迟到 Pi 适配阶段，与 Pi 一起按宿主矩阵一次性完成。
- OpenCode 按用户决策排除。

### 批次 13：最终验收与集成准备 - 未完成

- 重跑 HPS、context collector、router、Wiki 回归；运行性能与安全矩阵；运行 `git diff --check` 并审查无 skipped Phase 1/2 requirement、TODO、空 I/O stub 或未声明 mutation。Codex/Claude 完整 runner 不作为本门条件（用户决策 2026-10-08）。
- 更新本页五层状态。代码和测试层完成后进入正式 review；commit、PR、merge 与发布由用户选择，不能被测试结果自动标记完成。
- **安装根事实修正**：main 工作区原有的 17 个未跟踪文件（`bin/hps`、`lib/hps-*.mjs`、`portable-timeout.mjs`、`tests/hps/`）是分支产物的半部署，且 `lib/context-collector.mjs` 只剩一行占位注释、`tests/hps/` 只有 2 个旧测试文件。已备份至 `~/.config/superpowers/backups/horspowers-main-leftovers-20261008-103939` 并从 main 工作区移出。因此"native 主安装根"证据必须在合入 main 后重跑，不能沿用旧的半部署状态。
- Expected：所有阶段内验收均有 fresh 命令、退出码和计数证据，设计与计划口径一致。

## 最终完成门（未通过）

1. 批次 11 至 13 全部完成，各批次先有 RED 再有 GREEN 和受影响回归。
2. 通过 DocumentRuntime 重新读取 Phase 1、Phase 2 和本修复计划，确认状态、错误码和阶段边界一致。
3. 运行 fresh 全量回归、性能、安全矩阵、`git diff --check` 与 `git status`。Codex/Claude 完整 runner 不作为完成门（用户决策）。
4. 审查 diff，不得存在 skipped Phase 1/2 requirement、TODO、隐藏空 I/O stub 或把局部 smoke 计为完整验收。
5. 只有"代码存在、测试通过、Skill 接入"三层都有证据，才可把 Phase 1/2 实现状态标记完成。
6. 主线集成和发布继续保持独立状态；加载 finishing-a-development-branch 后只给出集成选项，不自动执行。

## 五层交付矩阵

| 层级 | 2026-10-08 状态 | 完成证据 |
|---|---|---|
| 代码存在 | 已完成 | Core、CLI、MCP 与 19 个 operation 在 `codex/hps-agent-cli` worktree 可调用 |
| 测试通过 | 部分完成 | 合并套件连续 5 次 464/464、`tests/hps/*` 177/177；批次 D 的反例已由 1,000,000/0 与 5×464/464 覆盖。Codex/Claude 探针接入已移出闸门（用户决策 2026-10-08）：两宿主 direct 通道通过，agent 步为宿主侧 timeout/failed 且归因未定；OpenCode 按决策排除 |
| Skill 接入 | 已完成 | using/brainstorming/document-management 默认确定性边界、route bridge、SessionStart/End HPS gate 已接入；document 读走 HPS、写走受控兼容入口；`tests/hps/skill-entrypoint-chain.test.mjs` 调用链探针通过 |
| 主线集成 | 未完成 | 分支未合入 main，无 PR 事实 |
| 发布 | 未完成 | 无版本、安装、MCP 注册和发布 smoke 证据 |

## 当前证据与限制

- 合并回归（`tests/context-collector/*` + `tests/wiki-docs/*` + `tests/workflow-router/*` + `tests/hps/*`）：连续 5 次 464/464 通过，0 failed、0 skipped。
- `tests/hps/*` 单独：177/177 通过。
- 确定性反例：`openScope`+`sessionPrepare` 1,000,000 次，`rejected: 0`；修复前同路径 200,000 次拒绝 6233 次。
- 性能（本次未重跑，沿用 2026-09-14 fresh 记录）：cold CLI P50/P95 约 101/113ms，slow prepare P50/P95 约 90/127ms，warm snapshot P50/P95 约 0.00/0.01ms，满足阶段阈值。
- native probe（2026-10-08 fresh，worktree 根为安装根）：Codex / Claude 的 direct 通道（version、call、`serve --stdio` 19 工具 MCP）均通过；agent 步失败（60s 为 `exitCode 124` timeout，Codex 240s 为 `exitCode 1` failed），归因未定。该维度已移出闸门。
- 历史记录「native probe 专项 9/9 通过」对应 fixture 与 project-local 只读探针，不覆盖真实 agent 步；已作废。
- OpenCode fixture：2/2 通过，仅作为兼容证据，不属于当前验收门。

## Pi agent 适配（Phase 1/2 之后，已完成）

用户决策（2026-10-08）后把 Pi 作为本轮唯一验收宿主。范围：host 抽象、MCP 注册与模板、Skill 路径解析、native probe 真实验收、文档与版本；不含 SessionStart 注入（Pi 无此机制，改用 `AGENTS.md` 上下文文件，且不由 Horspowers 写入）。

- Host 抽象：`HPS_HOSTS`、`hps-operations` 的 `host` enum、`workflow-router` 的 `VALID_HOSTS`、`hps-legacy-route-bridge` 均已支持 `pi`；OpenCode 仍不进入路由宿主集合。
- MCP 注册：`SUPPORTED_HOSTS` 新增 `pi`（`mcpServers` 形状），新增 `templates/mcp/pi.json`。
- 路径解析：`references/host-path-resolution.md` 与 `SKILL.md` 新增 Pi 行与示例；安装根由 Pi 给出的 skill 绝对路径向上解析，不扫描用户目录。
- native probe：新增 `pi` 实现。使用临时 `PI_CODING_AGENT_DIR` + 临时 `mcp.json`（`exposure: "direct"`），符号链接复用 `auth.json`/`models.json`，不复制密钥、不改写用户级配置；`pi --print --mode json` 经 stdin 传 prompt。
- 文档与版本：新增 `docs/README.pi.md`，版本 4.8.0。

证据（2026-10-08 fresh，本分支 worktree 为安装根）：

- `node scripts/run-hps-native-host-probe.mjs --host pi --installation-root <root> --cwd <root> --model zai-coding-cn/glm-5.3` → **`status: pass`，退出码 0**。direct 通道 19 工具 MCP 握手通过；`pi mcp list` connection `connected` / 19 工具；agent 步 `exitCode: 0`，真实调用 `mcp__hps__runtime_doctor` 成功，`runtimeDoctorCalls: 1`。
- 合并回归：467/467 通过，0 failed、0 skipped。
- 仓库审计：`lib/hps-native-host-probe.mjs` 的 fs mutation inventory 显式新增 `mkdir`/`symlink`，全部限定在探针自己的 `mkdtemp` artifact 目录内。

Pi 分发方式（用户决策 A）：在 Pi 的 `settings.json` 声明指向安装根的本地路径 package，并移出旧的 `~/.agents/skills/horspowers` 手工 clone，以避免同名 skill 冲突；该操作属于本机环境配置，不在仓库内提交。

## 范围说明

`project_bootstrap_*`、`document_change_*` 和 `document_transition_*` 是设计中明确的 Phase 5 后续写能力，不属于 Phase 1/2 公开工具完成门；当前保持不注册和 `operation_unavailable`。公司项目直接初始化 Wiki、Inbox submit 和状态 transition 仍不可作为 Phase 1/2 已实现效果宣传。

Pi agent 适配是 Phase 1/2 之后的新增宿主工作，本页不将其计入 Phase 1/2 完成门。用户决策（2026-10-08）：本轮聚焦 Pi agent 适配；Pi 将成为第一个需要真正通过验收的宿主，Codex/Claude 的探针接线与 Pi 一起按宿主矩阵一次性完成。
