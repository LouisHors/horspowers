# HPS Phase 2：Skill 执行底座设计

## 状态与边界

- 日期：2026-08-13；最近事实校准：2026-08-17；分支：`codex/hps-agent-cli`。
- 状态：设计方向已批准；19 个 Core operation 已存在并通过专项测试，但 Skill 默认执行链与若干契约仍未达到本设计效果。
- Skill 的意图识别、澄清、方案取舍、调试推理、计划编排、子代理调度和用户确认保持不变。
- HPS 只承接 Skill 依赖的确定性执行：项目解析、上下文收集、文档只读、Git 预检、验证 profile、会话状态和受控 preview。
- 不提供任意 Shell、任意路径读写、删除、自动 commit/push/merge，也不以 CLI 取代 Skill。

## 目标问题

不同 Skill 反复启动 Node 脚本，重复解析 Git/project identity/config/manifest，重复建立 qmd MCP 连接，重复读取入口文件和 Git 摘要，并各自处理超时、输出裁剪和错误归一化。Phase 2 将这些边界耗时收敛到共享 Core 与 Sidecar scope。

## 分层

```text
Skill（判断、交互、编排）
        │ JSON operation
HPS Core（确定性执行、验证、安全边界）
        ├─ project/context snapshot
        ├─ document read runtime
        ├─ git/worktree inspection
        ├─ verification profiles/evidence
        ├─ session/checkpoint state
        └─ guarded preview
Transport：hps call / hps serve --stdio
```

## Phase 2 操作

### 项目与上下文

- `project_snapshot`：一次返回 canonical root、identity、脱敏 remote 摘要、branch/dirty、project fingerprint、config/manifest revision 摘要。传入 `scope_id` 时必须校验并复用 live scope，不能忽略该字段重新构造无关 snapshot。
- `project_context`：复用 snapshot，返回文档 backend 状态、Wiki capability 和安全 scope。
- `git_preflight`：只读返回 branch/upstream、未提交/未推送、冲突和 worktree 状态。
- `context_collect`：复用已解析 runtime，在同一 scope 并行采集 Wiki/repository/Git/entry branches。

### 文档只读

- `document_resolve`、`document_search`、`document_get`：统一委托 DocumentRuntime；Wiki 读取必须经过 Registry/config/manifest 与 URI 边界。
- `document_manifest`、`document_verify`：只返回已验证 metadata、revision、digest，不暴露凭据和远端 stderr。

### 验证与会话

- `diff_snapshot`：结构化 diff/stat，限制输出，不执行写入。
- `verification_run`：只运行预注册 profile，继承宿主 cwd、网络和 writable roots；禁止通过 input 传 command/argv。
- `session_prepare`、`session_record`、`checkpoint_get`、`checkpoint_put`：会话内状态，短 TTL；只保存控制面字段，不保存凭据、源码、diff、日志、文档正文、URI 和跨会话权限。检查必须递归覆盖任意字段名和嵌套容器。

## Scope 与缓存

Sidecar scope 绑定 canonical root、Git identity digest、project fingerprint、host config digest、manifest revision/hash 和 TTL。snapshot/context/document read/verification discovery 可缓存；确认、审批、投稿正文、写入 revision 不缓存。任何绑定事实变化立即失效。相同 scope 的精确只读请求 singleflight，写请求不合并。

Phase 1/2 已采用比初版更严格的 qmd 基线：persistent read session、一次 initialize/tools-list、exact read singleflight、最多一次安全重连和 scope/EOF/shutdown 释放均属于当前阶段。该提前实现不改变 CLI 跨进程无复用的事实，也不引入 Phase 5 写权限。

## 安全边界

- 所有 operation 继续使用 HPS envelope、稳定错误码和 capability；unknown capability 一律 false。
- `verification_run` 仅接受 profile ID；profile 从安装包内 allowlist 解析，不能由请求动态定义。
- `document_get/search` 不接受任意 URI/collection；由已解析 runtime 约束。
- `diff_snapshot`、`git_preflight` 不执行 shell 语法；底层使用 shell=false 的固定子命令。
- read-only、network-off、Wiki unavailable 时 fail closed；不回退本地 Wiki grep，不扩大沙盒。
- preview 只生成事实摘要和计划，不进行 commit/push/merge/delete。
- capability 由 Codex、Claude Code 宿主 adapter 从可验证事实映射；OpenCode adapter 可作为兼容扩展但不属于当前完整支持承诺。静态默认值不能表示真实授权，unknown 一律 false。

## Skill 与宿主接入

- Skill 继续负责判断、推理、交互和编排；其确定性步骤默认通过 HPS operation 完成。
- 旧 route、document CLI、collector 和 hooks 保留输入输出兼容，但实现应成为 Core 的薄 wrapper，不得形成第二套业务逻辑。
- 插件安装层提供 `hps` 可执行发现和 `hps serve --stdio` 注册方式；不能要求 Agent 猜路径，也不能静默修改用户级宿主配置。
- 无 Sidecar 时允许回退 `hps call` 或兼容 wrapper；回退只影响性能，不得改变安全和错误语义。
- Codex/Claude 验收脚本不能依赖 macOS 默认不存在的 GNU `timeout`，必须使用仓库内 portable 限时机制；OpenCode 暂不纳入当前验收。

## 验收

- Skill 的意图、交互和编排语义不变；默认确定性执行链已切换到 HPS/Core，并有调用链证据。
- 同 scope 的项目解析只执行一次；context branches 并行；document resolve/search/get 复用一次 runtime/qmd 连接。
- CLI 与 MCP 对同一 operation 返回等价 result/error/metrics。
- 非法 command/argv/path/URI/profile、network-off、身份歧义、revision conflict 均返回稳定 fail-closed 错误。
- Phase 2 第一批普通 snapshot P50 ≤ 100ms（warm scope），context 慢路径沿用 ≤1.2s 目标；冷启动单独记录，不以语言替换掩盖 I/O 成本。
- `project_snapshot` 的 `scope_id` 被实际校验和复用，输出包含稳定 remote 摘要；CLI/MCP 等价。
- state payload 用任意载体名和嵌套结构承载正文时仍被拒绝，错误和 progress 不回显原文。
- capability fixture 与 Codex/Claude 真实探针一致；无法证明的权限保持 false。OpenCode 仅保留 fixture/模板级兼容，不作为当前验收门。
- Codex、Claude Code 的完整 runner 在 macOS/Linux 可移植执行并通过。

交付采用五层状态：代码存在、测试通过、Skill 接入、主线集成、发布。任何一层只能由本层证据标记完成；Core 测试通过不能替代 Skill 默认调用、分支合入或发布验证。

## 实施阶段

1. 协议扩展与 project/git snapshot。
2. document read adapter、context scope/cache 与 persistent qmd read session。
3. verification profile/evidence。
4. session/checkpoint 与受控 preview。
5. MCP/CLI 等价性、性能基准和安全矩阵。
6. `project_snapshot` scope/remote、state 正文安全和真实 capability adapter 收口已完成。
7. Skill 默认确定性边界、legacy route bridge、SessionStart/End HPS gate、MCP 宿主注册模板和 portable helper 已完成；Claude project-local MCP 连接与 Codex/Claude Skill discovery 已验证，native 主安装根/完整默认 runner 仍是收口项。
8. 主线集成和发布；每层独立记录状态。

`project_bootstrap_*`、`document_change_*` 和 `document_transition_*` 保持 Phase 5 后续写能力，不属于上述 Phase 2 收口项，也不能为了宣称 Phase 2 完成而提前暴露。
