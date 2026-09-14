# HPS Phase 2：Skill 执行底座实施计划

## 关联设计与状态

- 设计：`2026-08-13-design-hps-phase2-skill-execution-plane.md`
- 前置：`2026-08-13-design-hps-agent-first-core-cli-与-mcp-sidecar.md`
- 状态：2026-08-18 事实复核后更新。19 个 Core operation、契约/安全/生命周期、Codex/Claude 必需 capability adapter、MCP 注册模板、portable helper 和 native host probe 已实现；HPS native CLI 已安装到主根且 direct/MCP 通过。Claude 真实 native probe 通过（dontAsk 下 runtime_doctor permission-blocked 属预期），Codex agent 返回 `401 invalid_api_key`。Codex 默认 runner 和主线集成仍待收口。OpenCode 暂不纳入完整支持和验收范围。

## 范围

Phase 2 只新增共享确定性执行能力，不改 Skill 的意图判断、交互文本或编排规则；旧脚本和 hooks 保留为兼容入口。所有新增行为都必须有 RED、最小 GREEN 和受影响回归证据。

## 当前操作白名单

Core registry 当前公开 19 个操作：

- 准备与项目：`task_prepare`、`project_snapshot`、`project_context`、`git_preflight`、`diff_snapshot`。
- 文档只读：`document_resolve`、`document_search`、`document_get`、`document_manifest`、`document_verify`。
- 上下文与验证：`context_collect`、`verification_run`。
- 状态与预览：`session_prepare`、`session_record`、`checkpoint_get`、`checkpoint_put`、`commit_preview`、`merge_preview`。
- 诊断：`runtime_doctor`。

`document_change_*`、`document_transition_*`、`project_bootstrap_*` 是后续写能力，不属于 Phase 2 的公开交付；它们不出现在 MCP `tools/list`，CLI 调用稳定返回 `operation_unavailable`。

## 可执行验收矩阵

协议收口已经完成：未知 operation 与 deferred operation 的优先级、CLI/MCP 等价、`known_entry_files`/`wiki_root` 有界 schema、MCP Agent-friendly 描述均有自动化证据。Skill 迁移仍必须补 legacy route 的 agents/project apply、local context resolve 和 Git 预检语义等价，不能把协议完成等同于默认调用链完成。

| 验收项 | 2026-08-17 状态 | 缺口与完成证据 |
|---|---|---|
| 严格协议 | Core 已完成 | `contract-equivalence.test.mjs`、`phase2-acceptance.test.mjs` fresh 通过 |
| Git/Diff | Core 已完成 | 固定 `git` + `shell:false`、无 mutation；保持现有测试全绿 |
| Snapshot | 已完成 | live scope 重验/复用、脱敏 remote、变化失效与 CLI/MCP 测试已通过 |
| Scope | Core 已完成 | live facts、TTL、失效和 singleflight 保持现有测试全绿 |
| 文档读取 | Core 已完成 | opaque ref、DocumentRuntime 边界和 manifest/verify 保持现有测试全绿 |
| qmd | Core 已完成 | persistent read session 已提前纳入 Phase 1/2；保持生命周期和断线测试全绿 |
| Context | Core 已完成 | live scope 和 resolved runtime 复用保持现有测试全绿 |
| Verification | Core 已完成 | 固定 profile、真实 subprocess 与安全边界保持现有测试全绿 |
| State | 已完成 | 递归 typed control-state schema、carrier/循环/大小边界和 no-mutation/no-echo 已通过 |
| Preview | Core 已完成 | 真实 Git facts、digest 和无 mutation 保持现有测试全绿 |
| CLI/MCP | Core 已完成 | canonical envelope 和生命周期保持现有测试全绿 |
| 兼容入口与 Skill | 部分完成 | using/brainstorming/document-management 默认边界、route bridge、SessionStart/End HPS gate 已指向 HPS；document 写入口保留兼容路径 |
| capability | 已完成（fixture + probe） | Codex/Claude verified startup-facts adapter、Sidecar persistence provenance、unknown=false 与 Skill discovery 已通过；OpenCode adapter 仅保留兼容实现，不作为当前完成门；native 主安装根仍缺 `bin/hps` |
| MCP 注册/发现 | 已完成（宿主 API 前置条件独立） | 模板/生成器、native root 校验和无全局 mutation 已通过；主根 `bin/hps` 可执行，Claude/Codex project-local MCP 连接准确，未修改全局注册 |
| 沙盒 | Core 矩阵已完成 | adapter 合入后重跑 read-only/network-off/Wiki unavailable/非法载荷/no mutation |
| 性能 | Core 基线已完成 | 全部收口变更后重新跑真实 P50/P95，阈值不变 |
| Codex/Claude 完整 runner | 部分完成（Claude pass，Codex API 前置条件阻塞） | helper、stdin 转发、native probe fixture、Codex/Claude Skill discovery 和 project-local MCP 连接已通过；Claude agent probe=`pass`，Codex agent probe=`prerequisite_auth`（401 invalid_api_key）；Codex 默认 runner 仍待收口；OpenCode 按决策排除 |
| 主线/发布 | 未完成 | commit/PR/merge 与版本/安装/发布 smoke 分别留证 |

## 真实性能验收

2026-08-14 的 343 项 Core 并行回归数据：

- cold CLI P50 约 100.73ms，P95 约 113.11ms。
- warm snapshot P50 约 0.00ms，P95 约 0.01ms，满足 <100ms。
- direct prepare P50 约 0.49ms，P95 约 2.28ms，满足 <=200ms。
- collector-backed slow prepare P50 约 89.54ms，P95 约 126.93ms，满足 <=1.2s。

慢路径使用真实 worktree 的 `rg`、Git 与 entry 文件 I/O；没有注入空 `projectSnapshot` 或空 collector。

最新 fresh 复核测得 cold CLI P50/P95 约 101/113ms，slow prepare P50/P95 约 90/127ms，warm snapshot P50/P95 约 0.00/0.01ms，均在阶段阈值内；真实宿主 CLI 仍需在对应环境重跑。

## 实施任务状态

1. 协议、shared dispatch、scope/cache、document read、persistent qmd、verification runner、MCP 生命周期：Core 完成。
2. `project_snapshot` scope/remote 契约：已完成；live scope、规范化脱敏 remote、变化失效与 CLI/MCP 等价均有测试。
3. session/checkpoint 递归正文安全：已完成；typed control-state schema、嵌套/循环/大小边界、拒绝后无 mutation/no echo 均有测试。
4. Skill 和旧入口默认迁移：部分完成；默认确定性边界、legacy route bridge、SessionStart/End HPS gate 已接 HPS，document 写入口保留兼容路径。
5. Codex/Claude capability adapter 与 MCP 注册/发现：adapter、模板/generator、Skill discovery 与 Claude project-local 连接已完成；native 主安装根暴露仍待收口；OpenCode 仅保留兼容实现。
6. portable Codex/Claude runner：已完成仓库 helper 与 shell smoke；真实 CLI 待环境；OpenCode 按决策排除。
7. 最终性能、安全、回归、主线集成和发布：部分完成；native probe 专项 9/9 通过，真实宿主仍受 timeout/auth 前置条件阻塞，主线/发布未完成。

## 验证记录

- 最新 HPS + collector + workflow-router + Wiki 全量：386/386 通过，0 失败、0 skipped（包含 route bridge、hooks、Claude MCP 协议和 stdin timeout 回归；OpenCode 按决策排除）。
- OpenCode fixture：2/2 通过，仅作为兼容证据，不属于当前验收门。
- Codex：legacy compatibility 4/4；主根 native probe direct version/call/MCP 通过，临时 MCP connected，但 agent 返回 401 invalid_api_key 并分类为 `blocked_prerequisite/prerequisite_auth`；主安装根已具备 `bin/hps`。
- Claude：Skill discovery 通过；主根 native probe project-local MCP 显示 `hps: connected`、19 个工具可见，API 调用完成，runtime_doctor 在 dontAsk 下 permission-blocked，整体分类为 `pass`。
- portable timeout helper 与 shell/Node smoke 已完成，并覆盖 stdin 转发；native probe fixture 9/9 通过；完整默认 runner/native root 仍待收口；OpenCode 不作为本阶段前置条件。
- native probe 当前作为独立入口运行，尚未接入 `tests/codex/run-tests.sh` / `tests/claude-code/run-skill-tests.sh`；默认套件不因专项 probe 通过而自动改判为完整 runner 通过。

## 收口执行顺序

1. 先为 snapshot scope/remote 和 state 正文绕过补失败测试，再修复 Core 契约。
2. 为 Codex/Claude 必需能力输入定义统一 adapter 接口和 fixture，确保 unknown=false，再接 Sidecar/CLI；OpenCode 仅保留兼容 fixture。
3. 把 route、hooks 和目标 Skill 的确定性调用迁移到 HPS/Core；document 写入口保留受控 compatibility path；每个入口保留兼容协议并增加调用链测试。
4. 增加 Sidecar 安装/发现声明与 portable timeout helper，运行三个宿主的完整 runner。
5. 重跑 HPS、collector、router、Wiki、Codex/Claude、性能和安全矩阵，审查不存在 skip/TODO/空 I/O stub；OpenCode 不纳入本阶段验收。
6. 只有前五步全部通过，才把“代码存在、测试通过、Skill 接入”标记完成；提交/主线集成/发布继续依据实际事实单独标记。

## 提交边界

当前没有自动 commit、push、merge 或 PR。`project_bootstrap_*`、`document_change_*`、`document_transition_*` 和跨进程持久化仍是 Phase 5 后续产品范围，不影响 Phase 2 完成门；它们保持不注册和 `operation_unavailable`，不能伪装为 Phase 1/2 已实现能力。
