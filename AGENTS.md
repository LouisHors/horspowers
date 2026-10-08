# AGENTS.md

本文件为在本仓库工作的 agent 宿主（Codex / Claude Code / Pi）提供指引。

## Personal Rule

Always respond in *Simplified Chinese/中文*

## 项目概述

**Horspowers** 是 [obra/superpowers](https://github.com/obra/superpowers) 的中文增强分支，提供可组合的软件开发工作流技能。

自 v4.7 起，确定性执行能力从"插件 + SessionStart hook 注入"迁移到 **HPS（Horspowers Core）**：一个 agent-first 的 CLI 与 MCP sidecar。分工是固定的：

> **技能保留推理与编排，HPS 只承接确定性执行。** 禁止任意 shell、argv、env、host、URI、collection 或 path。

- 入口：`bin/hps`（唯一缩短的可执行名；品牌、技能命名空间、插件 ID 仍是 `horspowers`）
- 设计文档：`docs/plans/2026-08-13-design-hps-agent-first-core-cli-与-mcp-sidecar.md`、`docs/plans/2026-08-13-design-hps-phase2-skill-execution-plane.md`
- **收口状态唯一来源**：`docs/plans/2026-08-14-hps-phase-1-2-gap-closure-plan.md`（其他文档里的"已完成"记录以它为准）

## 运行测试

```bash
# 共享 Core 回归（默认；约 1-2 分钟，覆盖 collector / Wiki / router / HPS）
node --test tests/context-collector/*.test.mjs \
          tests/wiki-docs/*.test.mjs \
          tests/workflow-router/*.test.mjs \
          tests/hps/*.test.mjs \
          tests/helpers/*.test.mjs

# 单套件
node --test tests/hps/*.test.mjs

# 宿主兼容套件（会真实启动宿主 CLI，慢）
bash tests/codex/run-tests.sh
bash tests/claude-code/run-skill-tests.sh
bash tests/opencode/run-tests.sh

# 集成测试（慢，10-30 分钟）
bash tests/integration/run-integration-tests.sh

# HPS 宿主验收：native probe（只读、临时 artifact，不改用户配置）
node scripts/run-hps-native-host-probe.mjs --host pi \
  --installation-root "$PWD" --cwd "$PWD" --model <provider>/<model>
```

- **测试必须从仓库根目录运行**，不要从临时目录运行。集成测试会创建真实项目并执行完整工作流。
- `tests/.artifacts/` 里保留的 fixture 由 `tests/helpers/retained-artifacts.mjs` 限量（默认保留最新 40 个、且只删 60 秒前的）：套件在 `before` 里自行清理，shell 套件调用同名 CLI。
- 目录名是**全小写**：`tests/codex/`、`tests/claude-code/`、`tests/opencode/`。（历史上文档里写过 `tests/Codex/`，在 Linux 上会失败。）
- 不要直接调 GNU `timeout`：仓库用 `scripts/portable-timeout.sh`（Node helper），macOS/Linux 都可用。
- `hps` 暴露固定 verification profile（`hps-unit`、`hps-regression`、`context-collector`），但 `verification_run` **必需 `scope_id`**，只能在 MCP 会话内调用；一次性 CLI 请直接用上面的 `node --test` 命令。

## HPS 架构

### 两条执行通道

技能通过两种接线调用 HPS，**能力相同，差别只在状态能活多久**：

| 通道 | 生命期 | 能力 |
|---|---|---|
| `hps serve --stdio`（MCP sidecar） | 一个会话 | `task_prepare` 得到的 live scope 可被后续调用复用，并复用 qmd 连接与 document/snapshot cache |
| `hps call`（JSON stdin，一次性） | 单个进程 | 只完成本次 operation；`scope_id` 随进程消失 |

`scope_id` 绑定 `root`、Git identity、project fingerprint、config/manifest revision、host config digest 与 transport digest，任一变化或进程结束都会使其失效（`scope_expired`）。因此：

- **无 MCP 时可直接一次性调用**：`task_prepare`、`project_snapshot`、`git_preflight`、`diff_snapshot`、`document_resolve`、`runtime_doctor`
- **必需 `scope_id`**：`project_context`、`document_search`、`document_get`、`document_manifest`、`document_verify`、`context_collect`、`verification_run`、`session_*`、`checkpoint_*`、`commit_preview`、`merge_preview` —— 只能在 MCP 会话内用同一 live scope 调用，或走受控兼容入口（document 读 → `document-runtime-cli.mjs`；背景收集 → `collect-context.mjs`）
- **禁止**先 `hps call` 取 `scope_id` 再在下一条 `hps call` 里使用；那只会得到 `scope_expired`
- HPS 运行态**不落盘**（`documentCache`/`sessionState`/`checkpoints`/`sessionRecords` 均为内存 Map）：MCP 提供的是会话内复用，**不是持久化**。跨会话持久化只由文档系统（`docs/` + `docs/.docs-metadata/`）与 Wiki 承担

完整分流规则见 `skills/using-horspowers/SKILL.md` 的 `## 执行通道`。

### 宿主矩阵

| 宿主 | capability adapter | MCP 注册形状 | 说明 |
|---|---|---|---|
| Codex | 必需 | `mcp_servers`（TOML/JSON） | skill discovery 走 `~/.agents/skills/` |
| Claude Code | 必需 | `mcpServers` + `--mcp-config` | `CLAUDE_PLUGIN_ROOT` 为安装根 |
| Pi | 必需 | `mcpServers`（`~/.pi/agent/mcp.json`） | 无 SessionStart hook；用 `AGENTS.md` 作为上下文文件 |
| OpenCode | 兼容扩展 | `mcp`（`type: local`） | 不承诺完整支持与验收 |

- capability 一律 **fail closed**：没有已验证的 host facts 时全部为 `false`；`persistent_session` 只来自已验证的 in-process sidecar
- 路径解析只从宿主 native skill discovery 出发，**不得扫描用户目录或猜路径**：`skills/using-horspowers/references/host-path-resolution.md`
- 各宿主安装说明：`docs/README.codex.md`、`docs/README.opencode.md`、`docs/README.pi.md`

### 仓库布局

```text
bin/hps                 CLI 入口（call / version / doctor / serve --stdio）
lib/hps-*.mjs           Core：runtime / operations / protocol / capabilities /
                        mcp-server / mcp-registration / native-host-probe / verification
lib/*.mjs, lib/*.js     共享运行时：docs-core、document-runtime、project-*、wiki-*、route-rules…
skills/<name>/SKILL.md  技能（推理与编排）
commands/               用户专用 slash command 包装
hooks/                  旧 SessionStart/End hook（薄包装，委托 Core）
tests/                  见「运行测试」
docs/plans/             设计与收口计划
```

## 技能结构

每个技能位于 `skills/<skill-name>/SKILL.md`：

```yaml
---
name: skill-name
description: Use when [condition] - [what it does]
---
```

- **Frontmatter：** `name` 用小写 kebab-case；`description` 只写触发条件，**不得包含流程步骤**
- **Description Trap：** description 一旦概括了流程，模型就会照着 description 做而不去读技能正文
- **交叉引用：** 内部引用用 `horspowers:skill-name` 格式

### Slash commands

`commands/` 下的是用户专用包装：

```yaml
---
description: Brief description
disable-model-invocation: true
---

Invoke the horspowers:skill-name skill and follow it exactly as presented to you
```

`disable-model-invocation: true` 让命令只能由用户触发。

### 技能解析

- 个人技能目录（`~/.agents/skills/`，或各宿主自己的技能目录）覆盖 horspowers 技能
- 用 `horspowers:` 前缀强制使用 horspowers 技能
- 技能通过递归查找 `SKILL.md` 发现

## Horspowers 工作流

1. **brainstorming** —— 用提问收敛想法，分节呈现设计
2. **using-git-worktrees** —— 在新分支创建隔离工作区
3. **writing-plans** —— 拆成 2-5 分钟粒度的任务
4. **subagent-driven-development** 或 **executing-plans** —— 带审查地执行
5. **test-driven-development** —— RED-GREEN-REFACTOR
6. **requesting-code-review** —— 合并前自检
7. **finishing-a-development-branch** —— 合并 / PR 决策

## 关键技能

**流程技能（先跑）：** `brainstorming`、`systematic-debugging`

**实现技能：** `test-driven-development`、`writing-plans`、`executing-plans`

**协作技能：** `subagent-driven-development`、`using-git-worktrees`、`finishing-a-development-branch`、`receiving-code-review`

**元技能：** `using-horspowers`、`writing-skills`

## 技能编写

1. 遵循 `writing-skills/SKILL.md` 的模式
2. 用命令式描述："You MUST use this when..."
3. description 只写触发条件
4. 非显然的决策点用 DOT 流程图
5. 用 `writing-skills/testing-skills-with-subagents.md` 的方法验证

**Token 效率：** 每个技能控制在 500 行以内，用渐进披露（"See X"）隐藏细节。

**测试方法论：** 技能通过 headless 宿主会话测试，解析 `.jsonl` transcript 验证技能是否被调用、是否派发 subagent、文件是否创建、测试是否通过、git 提交是否符合工作流。详见 `docs/testing.md`。

## 常见陷阱

- **Description Trap：** description 概括流程 → 模型不读技能正文
- **Rationalization：** "我知道这是什么意思" → 跳过技能调用；`using-horspowers` 列出了十余种此类模式
- **先测试后实现：** `test-driven-development` 会删掉先于测试写的代码，实现类任务必须先调用 TDD
- **未验证就合并：** `finishing-a-development-branch` 要求先跑通测试再给出合并/PR 选项
- **回归不确定性优先于新功能：** 合并跑出现"偶发失败且失败项不固定"时，先定位确定性根因（历史上就出过 `scopeToken()` 生成被自身校验器拒绝的 id，以及仓库审计与并行测试的 `rm -rf` 竞态）

## Files of Interest

- `bin/hps` —— CLI 入口
- `lib/hps-runtime.mjs` —— Core runtime（scope / cache / state）
- `lib/hps-operations.mjs` —— operation registry（19 个公开 operation 与逐操作约束）
- `lib/hps-protocol.mjs` —— CLI/MCP canonical envelope
- `.claude-plugin/plugin.json`、`.claude-plugin/marketplace.json` —— 插件元数据与版本号（根目录**没有** `plugin.json`）
- `hooks/hooks.json` —— 旧 hook 注册（薄包装）
- `lib/skills-core.js` —— Codex / OpenCode 共享工具
- `agents/code-reviewer.md` —— code reviewer agent 定义
- `RELEASE-NOTES.md` —— 版本历史与详细 changelog
- `scripts/run-hps-native-host-probe.mjs` —— 宿主验收探针

## Codex GitHub Action

本仓库通过 GitHub Actions 支持 Codex。规划或修改代码前先读：

- `.codex/agent-policy.md`
- `.codex/task-modes.md`
- `.codex/verification.md`
- `.codex/pr-rules.md`

这些文件是允许的任务、受限变更、验证要求与 PR 规则的唯一来源。
