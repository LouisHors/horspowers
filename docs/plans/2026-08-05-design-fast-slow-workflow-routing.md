# 设计：Horspowers 快慢工作流路由与并行背景检索

## 基本信息

- 创建时间：2026-08-05
- 设计者：Codex 与项目所有者
- 状态：已批准，待实施
- 当前代码基线：`main@a18dc42`
- 计划文档：[`2026-08-05-fast-slow-workflow-routing-implementation.md`](2026-08-05-fast-slow-workflow-routing-implementation.md)

## 设计背景

Horspowers 当前同时依赖全局 `AGENTS.md`、`using-horspowers`、目标 Skills 和个人 Wiki/qmd 来约束 Agent。现有规则以高召回为主，但入口范围过宽，导致轻量任务也会串行经历 Skill 判断、Wiki 索引读取、qmd 关键词查询、语义查询和页面读取，增加首响时延与 token 消耗。

项目所有者的主要使用场景不是闲聊，而是：

1. 已经比较明确的需求讨论。
2. 需要补齐事实和边界的探索型讨论。

因此不能简单关闭背景检索，也不能把所有请求都交给 LLM 做开放式意图判断。本设计用确定性脚本处理高置信度请求，把只有上下文才能消歧的请求留给 LLM，并把 Wiki、仓库和 Git 背景检索收束到真正需要它们的目标 Skill。

### 当前实现事实

以下事实已在 `main@a18dc42` 核验：

- Codex 通过 `~/.agents/skills/horspowers` 原生发现 Skills。
- `skills/using-horspowers/SKILL.md` 同时承载 Skill 使用原则、配置初始化、迁移和文档系统检查，正文约 300 行。
- `hooks/session-start.sh` 会把完整 `using-horspowers` 内容和配置状态注入 Claude Code 会话。
- `lib/config-manager.js` 的默认配置是个人模式；初始化写入不是“仅在不存在时创建”的原子语义。
- `lib/docs-core.js` 可创建通用 `docs/` 目录，但构造函数本身带写入副作用。
- `tests/skill-trigger/corpus.yaml` 有 48 条正样本，没有 `should_trigger: false` 样本。
- 当前工作树已有与本设计无关的用户修改；实施必须在独立 worktree 中进行并避免覆盖这些修改。

## 设计目标

1. 用一次本地脚本调用完成项目配置快检和高置信度意图路由。
2. 高置信度只返回一个 `target_skill`；不确定时才交给 LLM。
3. 将全局 `AGENTS.md` 收缩为安全边界和短入口，不承载完整工作流。
4. 缺少项目配置时，仅在安全、明确的项目根静默创建团队模式配置和通用文档系统。
5. 将 Wiki/qmd、仓库、Git 和已知入口文件检索放入 brainstorming，并行执行。
6. 不假设 `rg` 或 qmd 在每台设备上都存在，提供有边界的回退链。
7. 保持 Codex 与 Claude Code 两个主要宿主可验证，其他宿主安全降级。

## 非目标

1. 不建设位于主 LLM 调用之前的宿主级代理或网络服务。
2. 不让脚本读取、总结或持久化完整会话历史。
3. 不向 `~/.claude/CLAUDE.md` 注入内容。
4. 不自动迁移、覆盖或重建已有配置。
5. 不在 `my-code-wiki`、用户根、临时目录或普通非项目目录初始化通用文档系统。
6. 不为 qmd 语义检索实现另一个 embedding 或向量检索后端。
7. 不在本轮扩展 `.horspowers-config.yaml` schema 来保存 Wiki 路径或检索排除目录。

## 方案对比

### 方案 A：只缩短全局 AGENTS.md

优点是改动小。缺点是 `using-horspowers` 仍然宽泛，配置检查和 Wiki 检索仍会在目标意图确定前发生，无法解决主要时延来源。

### 方案 B：全部依赖宿主原生 Skill discovery

优点是入口上下文最小。缺点是不同宿主的 Skill 召回行为不一致，容易重新出现意图遗漏，也无法统一配置初始化和安全边界。

### 方案 C：AGENTS 短入口 + 本地确定性路由 + 目标 Skill 执行

这是采用的方案。它保留一个稳定入口，用本地脚本处理高置信度分类，把复杂背景检索推迟到目标 Skill，同时保留 LLM 对相邻意图和历史语义的判断能力。

### 方案 D：宿主级前置路由器

理论上时延最低，但需要为 Codex、Claude Code 和其他宿主分别维护 wrapper 或 hook，部署与兼容成本超过当前需求，因此不采用。

## 最终设计

### 三层路由

```text
用户请求
  -> 第一层：全局 AGENTS.md
       安全边界 + using-horspowers 短入口
  -> 第二层：using-horspowers
       结构化 stdin 调用本地统一脚本
       -> 高置信度：唯一 target_skill
       -> direct：不加载流程 Skill
       -> uncertain：LLM 在候选流程中判断
  -> 第三层：目标 Skill
       执行具体流程
       brainstorming 才并行获取 Wiki / 仓库 / Git 背景
```

主 LLM 仍会先加载精简版 `using-horspowers`，但不再自行展开完整技能树。它的第一项动作是运行本地脚本，并严格消费脚本返回的唯一 `target_skill`。

## 组件与文件边界

### 1. 统一入口脚本

新增 `skills/using-horspowers/scripts/route-request.mjs`。它只负责：

- 从 stdin 读取一份 JSON 请求。
- 调用 `lib/workflow-router.mjs`。
- 向 stdout 输出一份稳定 JSON。
- 将诊断写入 stderr，不把用户原文拼进 shell 命令。

脚本不接受把用户消息作为 argv 的调用方式，避免空格、引号、反引号和命令替换造成安全问题。

### 2. 路由规则与校验

新增：

- `skills/using-horspowers/references/route-rules.json`
- `skills/using-horspowers/references/route-rules.schema.json`
- `lib/route-rules.mjs`

`route-rules.json` 是运行时规则的唯一事实源。Skill descriptions 解释语义边界，corpus 验证结果，但运行时不临时解析 Markdown 来生成规则。

`lib/route-rules.mjs` 在评分前完成严格校验：

- schema 版本必须兼容。
- route 必须属于固定 allowlist。
- 非 `direct` / `uncertain` route 必须映射到已知唯一 `target_skill`。
- 阈值、分差和规则权重必须是合法数字。
- 未知 route、未知 Skill 或不兼容版本返回 `uncertain`，不得执行 Apply。

### 3. 确定性路由器

`lib/workflow-router.mjs` 负责合并规则命中、项目 Plan 和 Apply 结果。路由评分固定为：

- 显式 Skill 或工作流名：`100`
- 两个不冲突的强组合信号：`80`
- 单一弱信号：`40`
- 相邻流程冲突：最高 `60`

只有第一候选 `>= 80` 且领先第二候选至少 `20` 时，才返回高置信度。否则返回 `uncertain`。

支持的 route：

| route | target_skill / 行为 |
|---|---|
| `direct` | 不加载流程 Skill |
| `brainstorming` | `horspowers:brainstorming` |
| `debugging` | `horspowers:systematic-debugging` |
| `tdd` | `horspowers:test-driven-development` |
| `planning` | `horspowers:writing-plans` |
| `checkpoint_execution` | `horspowers:executing-plans` |
| `continuous_execution` | `horspowers:subagent-driven-development` |
| `code_review` | `horspowers:requesting-code-review` |
| `docs` | `horspowers:document-management` |
| `uncertain` | LLM 只在返回的候选中判断 |

### 4. 项目资格与静默初始化

新增 `lib/project-initializer.mjs`，并对 `lib/config-manager.js` 增加“仅在缺失时创建”的原子 API。

通用 docs 不调用当前有构造副作用且 `init()` 会在构造后误判“已存在”的组合。`lib/docs-core.js` 新增无覆盖的 `ensureDocsInitialized(projectRoot)`：先记录所缺目录，再只创建 `docs/plans`、`active`、`archive`、`context`、`.docs-metadata`，并仅在 index 不存在时以 `wx` 创建空 index。返回 `created / updated / unchanged / failed`，不改写已有 index 或文档。

统一脚本必须按固定顺序执行：

1. **Plan，全只读**：解析输入、执行 `realpath`、确定项目根、检查敏感目录和标记、验证现有配置、检查 docs 和 AGENTS 状态、完成路由评分，生成内存 mutation plan。
2. **Apply，幂等写入**：只有 Plan 完整成功并得到合法路由结果后，才依次写入 AGENTS 托管区块、缺失配置和缺失 docs。

Plan 失败时零写入。Apply 每一步独立返回 `unchanged / created / updated / skipped / failed`；后一步失败不删除前一步已经创建的内容，下次调用只续作仍缺失的步骤。

自动初始化只允许：

- Git 能识别的仓库根；或
- 有 `.horspowers-project-root` 的非 Git 项目根。

以下真实路径必须跳过：

- 文件系统根。
- 用户根。
- 系统临时目录及其子目录。
- 无法识别项目根的普通目录。
- `my-code-wiki` 真实路径和软链接入口。
- 同时存在 `wiki/index.md` 与 `schema/wiki-native-automation.md` 的 Wiki-native 项目。
- 有 `.horspowers-no-auto-init` 的项目。
- 不可写目录。

缺少配置时静默创建：

```yaml
development_mode: team
branch_strategy: worktree
testing_strategy: tdd
completion_strategy: pr
documentation:
  enabled: true
```

实际文件仍包含当前 `CONFIG_VERSION`。已有且有效、无需迁移的配置保持字节级不变；旧版、过期或无效配置继续走显式提示，不自动覆盖。

### 5. Codex 全局 AGENTS 托管区块

新增：

- `lib/agents-managed-block.mjs`
- `skills/using-horspowers/templates/codex-agents-managed-block.md`

Codex 唯一允许的用户级写入目标是 `~/.codex/AGENTS.md`。托管区块使用稳定 marker 和独立版本：

```markdown
<!-- horspowers:managed-routing:start version=1 -->
## Horspowers workflow routing

- 删除、清理或覆盖用户文件前必须先获得明确授权。
- 实质性开发任务先加载 `horspowers:using-horspowers`。
- 采用脚本返回的唯一高置信度 `target_skill`；只有 `uncertain` 才由 LLM 判断。
- 具体操作和背景检索归目标 Skill 所有。
<!-- horspowers:managed-routing:end -->
```

行为规则：

- 文件不存在时创建文件和一个托管区块。
- 文件存在但没有区块时，在保留原文的前提下追加一个区块。
- 区块版本相同时字节级不变。
- 区块过期时，先创建带时间戳的备份，再只替换 marker 内内容。
- marker 损坏或重复时拒绝修改并报告一次可操作错误。
- Claude Code 和未知宿主不写任何全局指令文件。

### 6. 精简 using-horspowers

`skills/using-horspowers/SKILL.md` 收缩为短入口，只保留：

1. 何时调用统一脚本。
2. stdin / stdout 契约。
3. 高置信度、`direct`、`uncertain` 三种处理方式。
4. Apply 失败和路由失败的降级原则。
5. 按需 references 的导航。

当前大段配置创建、迁移、文档初始化和宿主工具映射分别移入：

- `skills/using-horspowers/references/config-bootstrap.md`
- `skills/using-horspowers/references/host-path-resolution.md`
- 既有 `skills/using-horspowers/references/codex-tools.md`

统一脚本路径解析固定为：Claude 使用 `${CLAUDE_PLUGIN_ROOT}/skills/using-horspowers/scripts/route-request.mjs`；Codex macOS/Linux 使用 `$HOME/.agents/skills/horspowers/using-horspowers/scripts/route-request.mjs`；Codex Windows 使用 `%USERPROFILE%\.agents\skills\horspowers\using-horspowers\scripts\route-request.mjs`。路径必须先验证文件存在并解析真实路径；未知宿主无法解析时不猜路径，直接回退 LLM 路由且零写入。

### 7. Claude SessionStart

保留 `hooks/hooks.json` 的 SessionStart / SessionEnd 注册，不写 `~/.claude/CLAUDE.md`。

`hooks/session-start.sh` 继续注入精简版 `using-horspowers` 和轻量配置状态 marker，但不在 SessionStart 做项目初始化，也不预先执行 Wiki/qmd。真正的配置 Plan / Apply 和意图路由在用户消息到达后，由 Skill 调用统一脚本完成。

### 8. brainstorming 并行背景检索

新增 `skills/brainstorming/scripts/collect-context.mjs`，由 `skills/brainstorming/SKILL.md` 在开始提问前调用。输入是结构化 JSON：

```json
{
  "schema_version": 1,
  "cwd": "/absolute/project/path",
  "query": "用户当前讨论主题",
  "wiki_root": null,
  "known_entry_files": []
}
```

`wiki_root` 只允许来自适用的项目 / 全局指令或宿主已知配置；脚本不猜测任意目录。为空时仍可使用 qmd collection；qmd 不可用且没有可信 Wiki root 时，Wiki 分支返回 `skipped`。

脚本并行启动四个有界分支：

1. Wiki/qmd 关键词检索；关键词不足时再执行语义查询。
2. 当前仓库文本和文件检索。
3. Git 近期变更。
4. 已知入口文件读取。

每个分支返回 `source_type`、`tool`、`status`、命中路径或 URI、mtime / Git commit（可得时）、摘要和错误。单一分支失败不影响其他分支。

首版硬边界固定为：repo / Git / entry 分支超时分别为 3s / 2s / 1s，qmd search 为 4s，只有关键词结果少于 3 个唯一有效命中时才运行 qmd query，query 超时 8s；collector 总超时 10s。单分支 stdout 最多 64 KiB、stderr 最多 8 KiB，最终 JSON 最多 256 KiB；Wiki 最多 8 个命中、仓库最多 40 个、Git 最多 20 个 commit、入口文件最多 12 个且单文件最多读取 32 KiB。

检索能力每次调用只探测一次并缓存：

| 能力 | 首选 | 回退 |
|---|---|---|
| 仓库文本 | `rg -n` | `git grep -n`；完整工作树需要时使用有排除的 `grep -RIn` |
| 文件枚举 | `rg --files` | `git ls-files`；非 Git 使用 `find` |
| Wiki 关键词 | `qmd search` | 对可信 Wiki root 使用同一文本检索链扫描 Markdown |
| Wiki 语义 | `qmd query` | 无语义替代，保留关键词结果 |
| 近期变更 | `git log` | 非 Git 项目跳过 |

固定排除 `.git`、`node_modules`、`vendor`、`.venv`、`venv`、`dist`、`build`、`target`、`coverage`、`.cache`。如果 grep 不支持 `--exclude-dir`，先通过文件枚举回退链获得候选文件，再逐个 grep，禁止无边界递归扫描。

任何检索和入口读取都跳过 `.env`、`.env.*`、`*.pem`、`*.key`、`*.p12`、`*.pfx`、`id_rsa*`、`id_ed25519*`、`.npmrc`、`.pypirc`、`credentials*`、`secrets*`、`*token*`、`*.kdbx`；只返回“已因敏感文件规则跳过”的计数，不返回文件内容。

Skill 合成结果时必须区分：

- 当前仓库事实：可直接只读核验。
- Wiki 历史记录：可能滞后，带页面和更新时间向用户确认。
- 用户已确认事实。
- Agent 推断。

同一讨论主题只做一次完整扫描；出现新项目、新模块或新事实缺口时才增量查询。

## 数据契约

### 输入

```json
{
  "schema_version": 1,
  "host": "codex",
  "cwd": "/absolute/project/path",
  "message": "当前用户原文",
  "active_route": null
}
```

- `cwd` 必须在脚本内再次 `realpath`。
- `active_route` 只有宿主能可靠提供时才填写。
- 脚本不接收 Agent 自己生成的意图标签。
- “继续”“按刚才方案做”等历史依赖型短请求，在 `active_route` 为空时固定返回 `uncertain`。

### 输出

```json
{
  "schema_version": 1,
  "device": {
    "agents_block": "installed",
    "router_version": 1
  },
  "project": {
    "eligibility": "project",
    "config": "created",
    "development_mode": "team",
    "documentation_enabled": true,
    "docs": "created"
  },
  "routing": {
    "route": "brainstorming",
    "target_skill": "horspowers:brainstorming",
    "confidence": 0.94,
    "routing_rule_version": 1,
    "matched_rules": ["exploration_request", "solution_not_approved"],
    "candidates": ["brainstorming", "writing-plans"],
    "context_policy": "parallel_background"
  },
  "mutations": [
    {"kind": "agents_block", "status": "created"},
    {"kind": "project_config", "status": "created"},
    {"kind": "docs", "status": "created"}
  ]
}
```

输出不得包含配置正文、完整文件内容或用户敏感数据。

## direct 边界

`direct` 只能由显式 allowlist 命中，不能通过“没有命中其他 Skill”反推：

1. 用户提供文本的简单翻译、改写或格式转换，且不需事实核验。
2. 输入完整的纯计算、单位换算或确定性字符串转换。
3. 不涉及具体项目、当前状态、历史决策、最新事实或外部工具的简短概念解释。
4. 单个无副作用命令的语法写法，且不要求执行或根据本机定制。

以下任一信号禁止 `direct`：修改、创建、修复、调试、规划、评审、测试或执行；具体仓库、模块、路径、Wiki 或历史上下文；当前 / 最新 / 线上事实；文件系统、网络、人员或服务副作用；依赖上一轮语义；显式 Skill 名。

## 错误处理

- stdin 不是合法 JSON、输入 schema 不兼容、字段超限或 `cwd` 非绝对路径属于调用契约错误：CLI non-zero、stdout 为空，Plan 阶段零写入，调用方回退 LLM 路由。
- 输入 envelope 合法，但 route rules 版本不兼容、规则内容无效、分类器异常或无法得到合法唯一 route：返回稳定 `uncertain` JSON，附有限 `routing_error` code，Plan 阶段零写入，CLI exit 0。
- 项目根无法识别或命中敏感目录：跳过项目初始化，继续返回路由结果。
- Apply 部分失败：保留已成功写入的文件，不删除、不回滚；只有目标 Skill 依赖失败项时才阻塞。
- 已有配置无效或需要迁移：不覆盖，输出明确状态交给现有显式流程。
- AGENTS 写入失败：继续依赖 native skill discovery，报告一次可操作错误。
- qmd、`rg`、`git grep`、`grep`、`find` 或 Git 分支失败：保留其他来源并继续 brainstorming。
- Wiki 与仓库冲突：同时展示来源，让用户确认适用基线。

## 安全与隐私

- 所有路径在写入前执行 `realpath` 并重新验证目标范围。
- 所有用户文本通过 stdin 传递，不插入 shell command string。
- 不删除、移动或覆盖用户文件。
- AGENTS 更新只允许修改受控 marker 内内容。
- 已有配置默认只读；自动创建使用原子 `wx` 语义。
- 背景检索只读、限量、带排除目录，不读取常见 secret 文件内容。
- 输出只包含状态、有限命中和来源，不回显完整配置或凭据。

## 影响范围

预计新增或修改：

- `skills/using-horspowers/SKILL.md`
- `skills/using-horspowers/scripts/route-request.mjs`
- `skills/using-horspowers/references/config-bootstrap.md`
- `skills/using-horspowers/references/host-path-resolution.md`
- `skills/using-horspowers/references/route-rules.json`
- `skills/using-horspowers/references/route-rules.schema.json`
- `skills/using-horspowers/templates/codex-agents-managed-block.md`
- `lib/route-rules.mjs`
- `lib/workflow-router.mjs`
- `lib/project-initializer.mjs`
- `lib/agents-managed-block.mjs`
- `lib/config-manager.js`
- `lib/docs-core.js`
- `skills/brainstorming/SKILL.md`
- `skills/brainstorming/scripts/collect-context.mjs`
- `hooks/session-start.sh`
- `docs/README.codex.md`
- `.codex/INSTALL.md`
- `tests/workflow-router/`
- `tests/context-collector/`
- `tests/skill-trigger/`
- Claude / Codex 对应 smoke tests

不修改当前设备的真实 `~/.codex/AGENTS.md` 作为开发步骤；所有自动写入测试必须使用隔离的临时 home。真实文件只会在发布后的 `using-horspowers` 首次正常调用中按设计处理。

## 实施顺序

1. 先建立规则 schema、路由契约和纯函数测试。
2. 再实现项目资格、配置原子创建和 AGENTS 托管区块。
3. 合并为单进程 Plan / Apply CLI。
4. 收缩 `using-horspowers` 并调整 Claude SessionStart。
5. 实现 brainstorming 并行背景收集器及命令回退。
6. 扩充正负 corpus、统计和基准。
7. 最后运行双宿主回归和文档验证。

## 验收标准

### 安全与初始化

- 普通 Git 项目缺配置时静默创建团队配置和通用 docs。
- 已有且有效、无需迁移的配置字节级不变。
- 文件系统根、用户根、临时目录、普通目录和 opt-out 项目不产生配置或 docs。
- `my-code-wiki` 的真实路径与软链接入口均不产生通用配置或 docs。
- 非 Git 目录只有 `.horspowers-project-root` 才允许初始化。
- AGENTS 托管区块重复执行只有一份，区块外内容不变。
- 测试和失败路径不删除任何用户文件。

### 路由质量

- 高置信度请求只返回一个已知 `target_skill`。
- 相邻意图冲突和历史依赖短句返回 `uncertain`。
- `route-rules.json` 通过 schema 校验；未知 route、Skill 和版本被拒绝。
- 现有 48 条 Codex 正样本保持 `exact + acceptable = 48/48`、`miss = 0`、`wrong = 0`。
- 新增至少 24 条 `should_trigger: false` 负样本，`over-trigger <= 5%`。
- `direct` 负样本的流程 Skill 加载数和 qmd 调用数都是 0。
- 不超过 4 KiB 输入的 100 次独立进程调用 P95 不高于 150ms，并记录 OS、CPU、Node 版本和完整冷启动耗时。

### 背景检索

- 有 `rg` 时使用 `rg`；没有 `rg` 时通过 `git grep` / `grep` 完成有边界检索。
- 文件枚举按 `rg --files -> git ls-files -> find` 回退。
- 没有 qmd 时仍能从可信 Wiki root 获取关键词背景。
- Wiki、仓库、Git 和入口文件并行执行，单一分支失败不阻塞。
- 输出明确区分仓库事实、Wiki 历史与 Agent 推断。

## 发布与回滚

首版以 router version `1` 和 route-rule version `1` 发布。实现按独立提交拆分；若宿主回归失败，可回滚 Skill / hook 集成提交而保留纯函数和测试资产。AGENTS 托管区块有独立 marker 和备份，不要求删除用户内容作为回滚手段。

## 结果评估

上线后比较以下指标：

- `direct` 请求首响时延和 token 使用量。
- 实质性请求的 Skill exact / acceptable / miss / wrong。
- `uncertain` 占比及用户澄清次数。
- brainstorming 背景分支耗时、命中率和失败率。
- 自动初始化 created / skipped / failed 分布。

若 `direct` over-trigger 超过 5%，优先收窄 allowlist；若 `uncertain` 过高，优先增加不冲突的强组合规则，不通过扩大弱关键词范围解决。

## 相关文档

- 实施计划：[`2026-08-05-fast-slow-workflow-routing-implementation.md`](2026-08-05-fast-slow-workflow-routing-implementation.md)
- 触发评估设计：[`2026-05-11-design-skill-trigger-evaluation-framework.md`](2026-05-11-design-skill-trigger-evaluation-framework.md)
- Codex 原生发现说明：[`../README.codex.md`](../README.codex.md)
