# Horspowers 快慢工作流路由与并行背景检索实施计划

> **Execution note:** After this plan is approved, use `horspowers:executing-plans` or `horspowers:subagent-driven-development` to implement it task-by-task in the current host.

**日期**: 2026-08-05

## 目标

在不降低核心工作流意图召回的前提下，以确定性本地脚本完成 Horspowers 的配置快检和快慢路由，并将 Wiki、仓库、Git 背景检索收束到 brainstorming 中并行执行。

## 架构方案

全局 `AGENTS.md` 只保留安全边界和 `using-horspowers` 入口；`using-horspowers` 通过结构化 stdin 调用单进程 Plan / Apply 路由器，高置信度时只返回一个目标 Skill，只有 `uncertain` 才交给 LLM。brainstorming 使用独立 Node helper 并行收集 Wiki、仓库、Git 和入口文件背景，并按 `rg -> git grep -> grep`、`rg --files -> git ls-files -> find` 回退。

## 技术栈

Node.js ESM/CJS 互操作、JSON / JSON Schema、Markdown Skills、Bash hooks、Ruby skill-trigger runner、Node `node:test`、Git/qmd/rg/grep/find 命令探测

## 设计依据

- 设计文档：[`2026-08-05-design-fast-slow-workflow-routing.md`](2026-08-05-design-fast-slow-workflow-routing.md)
- 当前代码基线：`main@a18dc42`
- 当前工作树有无关用户修改；实施必须使用独立 worktree，不能在现有 dirty `main` 上修改源码。
- 新 worktree 必须基于包含本设计和计划的提交。若两份文档尚未提交，实施流程在创建 worktree 前暂停，向用户请求仅暂存并提交这两份文档的授权；没有包含文档的明确 commit/branch 时不得开始源码实施。这样 Task 9 才能在同一 worktree 中更新并提交文档状态。
- 本计划新增的 router、collector 和 baseline 测试不得删除文件，临时 fixture 与 artifacts 使用唯一目录并保留。仓库既有 Codex / Claude / integration suite 含历史 cleanup 命令；执行这些 legacy suites 前必须展示精确删除目标并向用户取得一次明确授权，未授权时跳过并记录剩余风险。

---

### Task 1: 建立版本化路由规则与严格校验器

**Files:**

- Create: `skills/using-horspowers/references/route-rules.schema.json`
- Create: `skills/using-horspowers/references/route-rules.json`
- Create: `lib/route-rules.mjs`
- Create: `tests/workflow-router/route-rules.test.mjs`

**Step 1: 写 route rules schema 的失败测试**

创建 `tests/workflow-router/route-rules.test.mjs`，使用 `node:test` 覆盖：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAndValidateRules, validateRules } from '../../lib/route-rules.mjs';

test('loads the checked-in version 1 rules', async () => {
  const rules = await loadAndValidateRules();
  assert.equal(rules.schema_version, 1);
  assert.equal(rules.routing_rule_version, 1);
  assert.equal(rules.thresholds.high_confidence, 80);
  assert.equal(rules.thresholds.minimum_margin, 20);
});

test('rejects unknown routes and target skills', () => {
  const result = validateRules({
    schema_version: 1,
    routing_rule_version: 1,
    thresholds: { high_confidence: 80, minimum_margin: 20 },
    skill_map: { surprise: 'horspowers:unknown' },
    routes: [],
    conflicts: [],
    direct: { allow: [], deny: [] }
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /unknown route|unknown target_skill/i);
});

test('rejects incompatible schema versions', () => {
  const result = validateRules({ schema_version: 999 });
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /schema_version/i);
});
```

**Step 2: 运行测试确认 RED**

Run:

```bash
node --test tests/workflow-router/route-rules.test.mjs
```

Expected: FAIL，错误指向 `lib/route-rules.mjs` 不存在或导出缺失。

**Step 3: 创建 JSON Schema**

在 `route-rules.schema.json` 固定以下顶层约束：

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "Horspowers Route Rules",
  "type": "object",
  "required": [
    "schema_version",
    "routing_rule_version",
    "thresholds",
    "skill_map",
    "routes",
    "conflicts",
    "direct"
  ],
  "properties": {
    "schema_version": { "const": 1 },
    "routing_rule_version": { "type": "integer", "minimum": 1 },
    "thresholds": {
      "type": "object",
      "required": ["explicit", "strong_pair", "weak", "conflict_cap", "high_confidence", "minimum_margin"],
      "additionalProperties": false
    },
    "skill_map": { "type": "object", "minProperties": 8 },
    "routes": { "type": "array", "minItems": 8 },
    "conflicts": { "type": "array", "minItems": 4 },
    "direct": { "type": "object", "required": ["allow_rules", "deny_patterns"] }
  },
  "additionalProperties": false
}
```

补全每个子对象的 `required`、类型和 `additionalProperties: false`，使缺字段、拼错字段和额外字段都能被测试拒绝。

运行时结构固定为：

```json
{
  "routes": [
    {
      "route": "brainstorming",
      "explicit_patterns": ["horspowers:brainstorming", "brainstorming", "头脑风暴"],
      "strong_groups": [
        {"id": "design_intent", "any_patterns": ["设计", "想法", "方案", "design", "idea", "approach"]},
        {"id": "direction_unsettled", "any_patterns": ["未确定", "还不清楚", "探索", "帮我想", "unclear", "explore"]}
      ],
      "weak_patterns": ["建议", "方向", "思路", "recommend", "option"]
    }
  ],
  "conflicts": [
    {
      "routes": ["brainstorming", "planning"],
      "prefer": [
        {"route": "brainstorming", "any_patterns": ["未确定", "探索", "unclear"]},
        {"route": "planning", "any_patterns": ["已批准", "已确认", "approved", "agreed"]}
      ],
      "when_both": "uncertain",
      "score_cap": 60
    }
  ],
  "direct": {
    "allow_rules": [
      {"id": "provided_text_transform", "any_patterns": ["翻译这段", "改写这段", "format this", "translate this"]},
      {"id": "pure_calculation", "any_patterns": ["计算", "换算", "convert units", "calculate"]},
      {"id": "short_self_contained_explanation", "any_patterns": ["是什么", "简短解释", "what is", "explain briefly"]},
      {"id": "command_syntax_only", "any_patterns": ["命令语法", "怎么写命令", "command syntax"]}
    ],
    "deny_patterns": ["修改", "创建", "修复", "调试", "计划", "评审", "测试", "执行", "仓库", "模块", "路径", "wiki", "当前", "最新", "线上", "继续", "按刚才", "modify", "create", "fix", "debug", "plan", "review", "test", "execute", "repository", "latest", "current", "continue", "horspowers:"]
  }
}
```

每个 route object 必须且只能包含 `route / explicit_patterns / strong_groups / weak_patterns`；每个 `strong_groups` 正好两个 group，命中两个 group 才得到 strong-pair 分。conflict object 必须且只能包含 `routes / prefer / when_both / score_cap`；`routes` 正好两个，`when_both` 只允许 `uncertain`。direct 必须且只能包含 `allow_rules / deny_patterns`，任何 deny 命中优先于 allow。

**Step 4: 创建 version 1 规则文件**

`route-rules.json` 必须包含以下唯一映射：

```json
{
  "direct": null,
  "brainstorming": "horspowers:brainstorming",
  "debugging": "horspowers:systematic-debugging",
  "tdd": "horspowers:test-driven-development",
  "planning": "horspowers:writing-plans",
  "checkpoint_execution": "horspowers:executing-plans",
  "continuous_execution": "horspowers:subagent-driven-development",
  "code_review": "horspowers:requesting-code-review",
  "docs": "horspowers:document-management",
  "uncertain": null
}
```

规则信号按设计文档固定为：显式名、强信号 A、强信号 B、弱信号和 deny 信号。其余 7 个 route 使用与上面完全相同的字段结构，中英文 pattern 固定覆盖：

- brainstorming：设计 / 想法 / 方案 / explore / idea + 未确定 / 探索 / 帮我想 / unclear。
- planning：已批准 / 已确认 / approved / agreed + 实施计划 / 拆步骤 / implementation plan / break into steps。
- debugging：bug / 失败 / 异常 / error + 根因 / 缩小范围 / isolate / root cause。
- tdd：功能 / bugfix / 修复 + 失败测试 / 复现测试 / failing test / acceptance test first。
- checkpoint execution：已有计划 / 按计划 + 分批 / 暂停 / 检查点 / checkpoint。
- continuous execution：已有计划 / 任务列表 + 连续推进 / 无需等待 / independent tasks / keep moving。
- code review：已有实现 / diff / commit / 变更 + bug / 回归 / 遗漏 / 偏离需求 / regression。
- docs：文档系统 / Wiki / 已有决策 / docs + 搜索 / 归档 / 恢复 / 初始化。

冲突表必须包含 brainstorming/planning、debugging/tdd、checkpoint/continuous、code-review/brainstorming 四组。

planning 的 `explicit_patterns` 除 Skill 名外，固定把明确的工作流短语视为 100 分：`实施计划`、`落地计划`、`implementation plan`、`execution plan`、`分步骤.*(计划|落地)`、`(拆成|整理成).*(步骤|阶段).*(先别|不要).*(做|开始|实现)`。因此原 corpus 的 `writing_plans_strong_002` 和 `writing_plans_confusion_002` 不需要伪造“已批准”信号。planning 的 `direction_settled` strong group 另包含 `大方向差不多`，使 `writing_plans_confusion_001` 可与步骤顺序信号组成 strong pair；`writing_plans_weak_001` 由“设计我认可了”+“下一步/推进”组成 strong pair。不得降低全局 80 分阈值来迁就这些样本。

**Step 5: 实现无第三方依赖的严格校验器**

在 `lib/route-rules.mjs` 导出：

```js
export const KNOWN_ROUTES = new Set([
  'direct', 'brainstorming', 'debugging', 'tdd', 'planning',
  'checkpoint_execution', 'continuous_execution', 'code_review',
  'docs', 'uncertain'
]);

export const KNOWN_TARGET_SKILLS = new Set([
  'horspowers:brainstorming',
  'horspowers:systematic-debugging',
  'horspowers:test-driven-development',
  'horspowers:writing-plans',
  'horspowers:executing-plans',
  'horspowers:subagent-driven-development',
  'horspowers:requesting-code-review',
  'horspowers:document-management'
]);

export function validateRules(rules) {
  const errors = [];
  // 1. 精确检查顶层 key 集合和 schema_version。
  // 2. 精确检查 thresholds 六个数字字段。
  // 3. skill_map key 必须等于 KNOWN_ROUTES，值必须为允许的唯一 Skill/null。
  // 4. routes 中每个非 direct/uncertain route 恰好出现一次，字段集合固定。
  // 5. 每个 strong_groups 恰好两个且 id 唯一，所有 pattern 都是非空字符串。
  // 6. conflicts 必须恰好覆盖批准的四组，route 成对合法，when_both=uncertain。
  // 7. direct allow_rules id 唯一且 pattern 非空，deny_patterns 非空。
  return { valid: errors.length === 0, errors };
}

export async function loadAndValidateRules(rulesPath = DEFAULT_RULES_PATH) {
  const rules = JSON.parse(await readFile(rulesPath, 'utf8'));
  const result = validateRules(rules);
  if (!result.valid) throw new Error(result.errors.join('; '));
  return rules;
}
```

不得引入 Ajv 等新依赖；schema 文件是可审阅契约，`validateRules` 是零依赖运行时执行器。

**Step 6: 运行测试确认 GREEN**

Run:

```bash
node --test tests/workflow-router/route-rules.test.mjs
```

Expected: PASS，3 个测试全部通过。

**Step 7: 提交本任务**

```bash
git add skills/using-horspowers/references/route-rules.schema.json \
        skills/using-horspowers/references/route-rules.json \
        lib/route-rules.mjs \
        tests/workflow-router/route-rules.test.mjs
git commit -m "feat: add versioned workflow route rules"
```

---

### Task 2: 实现纯函数意图评分与安全 stdin CLI

**Files:**

- Create: `lib/workflow-router.mjs`
- Create: `skills/using-horspowers/scripts/route-request.mjs`
- Create: `tests/workflow-router/classifier.test.mjs`
- Create: `tests/workflow-router/cli.test.mjs`

**Step 1: 写分类器失败测试**

覆盖以下表格，每行一个独立 test：

| 输入 | 预期 route | 预期 target_skill |
|---|---|---|
| `使用 horspowers:writing-plans` | `planning` | `horspowers:writing-plans` |
| `方案已经批准，拆成实施步骤` | `planning` | `horspowers:writing-plans` |
| `这个 bug 出现异常，先定位根因并缩小范围` | `debugging` | `horspowers:systematic-debugging` |
| `先写失败测试再修 bug` | `tdd` | `horspowers:test-driven-development` |
| `已有计划，分批执行，每批停下来汇报` | `checkpoint_execution` | `horspowers:executing-plans` |
| `已有计划和独立任务列表，连续推进，不用等我` | `continuous_execution` | `horspowers:subagent-driven-development` |
| `把这段文字翻译成英文` | `direct` | `null` |
| `继续` 且 `active_route=null` | `uncertain` | `null` |
| `继续` 且 `active_route=planning` | `planning` | `horspowers:writing-plans` |
| `继续按计划分批做` 且 `active_route=planning` | `checkpoint_execution` | `horspowers:executing-plans` |
| `改成先写失败测试` 且 `active_route=debugging` | `tdd` | `horspowers:test-driven-development` |
| 同时要求“先定位根因”和“先写失败测试” | `uncertain` | `null` |

断言高置信度结果只有一个 `target_skill`，`direct` 和 `uncertain` 不携带 Skill。

**Step 2: 运行分类器测试确认 RED**

Run:

```bash
node --test tests/workflow-router/classifier.test.mjs
```

Expected: FAIL，`classifyRequest` 尚不存在。

**Step 3: 实现确定性评分器**

在 `lib/workflow-router.mjs` 导出：

```js
export function classifyRequest({ message, active_route = null }, rules) {
  const normalized = message.normalize('NFKC').trim().toLowerCase();
  const scores = new Map();
  const matches = new Map();

  // 1. direct deny 优先。
  // 2. 显式 Skill/route 得 100。
  // 3. 同一路由 strong_a + strong_b 得 80。
  // 4. 单个 weak 得 40。
  // 5. 只有消息完全匹配 continuation-only pattern 且 active_route 合法时，active route 得 80。
  // 6. 当前消息显式或 strong route 优先于 active_route，允许用户切换流程。
  // 7. 冲突双方封顶 60。
  // 8. 第一名不足 80 或 margin < 20，返回 uncertain。
  // 9. direct 只允许显式 allow 命中且没有 deny。

  return {
    route,
    target_skill: rules.skill_map[route] ?? null,
    confidence: Number((score / 100).toFixed(2)),
    routing_rule_version: rules.routing_rule_version,
    matched_rules,
    candidates,
    context_policy: route === 'brainstorming' ? 'parallel_background' : 'none'
  };
}
```

`continuation-only` 固定匹配去除标点后的完整短句：`继续`、`继续做`、`按刚才继续`、`continue`、`go on`、`proceed`。`active_route` 只允许非 `direct` / `uncertain` 的已知 route；其他值按输入 schema 错误拒绝。包含任何显式 route 或当前消息 strong pair 时，不应用 continuation 分，确保显式切换和新意图优先。

正则编译失败、规则内容错误或不兼容版本必须由 `routeRequest` 转换为稳定 `uncertain` JSON，设置有限错误码 `RULES_INVALID` 或 `RULES_VERSION_UNSUPPORTED`，并跳过所有 Apply；不能返回半合法 route，也不能让这两类可降级错误冒泡成 CLI non-zero。

**Step 4: 运行分类器测试确认 GREEN**

Run:

```bash
node --test tests/workflow-router/classifier.test.mjs
```

Expected: PASS，全部样本得到唯一且稳定的 route。

**Step 5: 写 CLI 失败测试**

`tests/workflow-router/cli.test.mjs` 使用 `spawn`，通过 stdin 写入 JSON，覆盖：

- 正常 JSON 只在 stdout 输出一个 JSON object。
- 带引号、反引号、`$()` 的用户消息不会被 shell 执行。
- argv 中出现用户消息时退出非零并打印用法。
- 超过 4 KiB 的 message 被拒绝。
- 非法 host、相对 cwd、未知字段和 malformed JSON 被拒绝，CLI non-zero、stdout 为空且不产生 mutation。
- 合法输入 envelope 下的未知 rule version / invalid rules 返回 exit 0 的 `uncertain` JSON，包含 `routing_error`，且 mutations 为空。

**Step 6: 运行 CLI 测试确认 RED**

Run:

```bash
node --test tests/workflow-router/cli.test.mjs
```

Expected: FAIL，入口脚本不存在。

**Step 7: 实现 stdin-only CLI**

入口骨架固定为：

```js
#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { routeRequest } from '../../../lib/workflow-router.mjs';

if (process.argv.length !== 2) {
  console.error('route-request.mjs accepts JSON on stdin only');
  process.exit(64);
}

try {
  const raw = await readFile(0, 'utf8');
  const input = JSON.parse(raw);
  const result = await routeRequest(input);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(error && error.exitCode ? error.exitCode : 1);
}
```

CLI 只对 JSON 解析、输入 schema、字段大小和绝对路径等调用契约错误 non-zero。`routeRequest` 此时先只返回 device/project 为 `skipped` 的路由结果；Task 5 再接入 Plan / Apply 和可降级的 `uncertain` 错误 JSON。

**Step 8: 运行 CLI 测试确认 GREEN**

Run:

```bash
node --test tests/workflow-router/cli.test.mjs
```

Expected: PASS；恶意文本测试不会创建任何 marker 文件。

**Step 9: 提交本任务**

```bash
git add lib/workflow-router.mjs \
        skills/using-horspowers/scripts/route-request.mjs \
        tests/workflow-router/classifier.test.mjs \
        tests/workflow-router/cli.test.mjs
git commit -m "feat: add deterministic workflow router CLI"
```

---

### Task 3: 实现安全项目资格判断与原子团队配置初始化

**Files:**

- Create: `lib/project-initializer.mjs`
- Modify: `lib/config-manager.js`
- Modify: `lib/docs-core.js`
- Modify: `.gitignore`
- Create: `tests/workflow-router/project-initializer.test.mjs`
- Create: `tests/workflow-router/docs-initializer.test.mjs`

**Step 1: 写项目资格矩阵的失败测试**

正向 fixture 必须创建在仓库内保留目录 `tests/.artifacts/workflow-router/<run-id>/`，每个 fixture 自己初始化嵌套 Git root，并保留路径供测试日志查看，不主动删除。只有“系统临时目录必须拒绝”的负向 case 使用 `os.tmpdir()`。覆盖：

先在 `.gitignore` 增加 `tests/.artifacts/`，并用 `git check-ignore tests/.artifacts/workflow-router/probe` 验证 retained fixture 不污染工作树。

1. 普通 Git 根：`eligible=true`。
2. Git 子目录：解析到真实 Git 根。
3. 非 Git + `.horspowers-project-root`：`eligible=true`。
4. 普通非 Git 目录：`eligible=false`。
5. 文件系统根、用户根、系统临时目录及其子目录：拒绝。
6. `.horspowers-no-auto-init`：拒绝。
7. `wiki/index.md` + `schema/wiki-native-automation.md`：拒绝。
8. Wiki-native 目录的软链接入口：按 `realpath` 拒绝。
9. 不可写根：拒绝或在当前平台无法可靠模拟时标记 platform skip。

**Step 2: 写配置原子创建的失败测试**

断言：

```js
const first = await initializeConfigIfMissing(projectRoot, 'team');
assert.equal(first.status, 'created');

const before = await readFile(configPath);
const second = await initializeConfigIfMissing(projectRoot, 'team');
const after = await readFile(configPath);
assert.equal(second.status, 'exists');
assert.equal(second.config_state, 'valid');
assert.deepEqual(after, before);
```

再覆盖已有有效配置、`documentation.enabled: false`、已有无效配置、旧配置和并发两个创建调用；任何情况都不能覆盖先存在的文件。API 状态固定为：首次 `created`；文件竞争时 `exists` 并附 `config_state=valid|invalid|needs_update`；旧配置由 Plan 在调用原子创建前标记 `needs_migration`。

**Step 3: 运行测试确认 RED**

Run:

```bash
node --test tests/workflow-router/project-initializer.test.mjs
```

Expected: FAIL，资格判断和 `initializeConfigIfMissing` 尚不存在。

**Step 4: 在 config-manager 增加原子 API**

保留现有 `initializeConfig` 兼容行为，新增：

```js
async function initializeConfigIfMissing(projectDir, mode = 'team') {
  const configPath = path.join(projectDir, NEW_CONFIG_FILENAME);
  const config = buildConfigForMode(mode);
  const content = serializeConfig(config);

  try {
    await fs.promises.writeFile(configPath, content, { encoding: 'utf8', flag: 'wx' });
    return { status: 'created', config };
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      const existing = readConfig(projectDir);
      return { status: 'exists', config_state: classifyExistingConfig(existing) };
    }
    return { status: 'failed', error: error.message };
  }
}
```

抽取并复用 `buildConfigForMode` / `serializeConfig`，避免新旧 API 生成不同格式。不要把默认 `DEFAULT_CONFIG` 改成 team；只有新路由器显式调用原子 API 时使用 team。

**Step 5: 实现只读 Plan**

`lib/project-initializer.mjs` 导出：

```js
export async function planProjectInitialization({ cwd, homeDir, tempDir }) {
  // realpath cwd -> Git root 或 marker root -> 敏感路径检查 -> Wiki/opt-out ->
  // 可写性 -> 配置状态 -> docs 状态；全程不实例化 UnifiedDocsManager。
  return {
    eligibility,
    project_root,
    config_action,
    docs_action,
    reason
  };
}
```

Git 根通过 `git -C <real cwd> rev-parse --show-toplevel` 的 argv 调用获得，不拼接 shell 字符串。非 Git 时向上寻找 `.horspowers-project-root`，到文件系统根即停止。

配置状态到 mutation plan 的映射固定为：missing -> `config_action=create`；current valid + docs enabled -> `config_action=unchanged` 且允许 docs repair；current valid + docs disabled -> config unchanged、`docs_action=skipped_disabled`；invalid -> `explicit_action_required_invalid`；old file -> `explicit_action_required_migration`；version outdated -> `explicit_action_required_update`。后三种都禁止自动 docs 初始化。

**Step 6: 为 docs-core 增加无覆盖初始化 API**

在 `lib/docs-core.js` 增加并导出独立函数，不通过 `UnifiedDocsManager` 构造函数和当前 `init()` 组合初始化：

```js
function ensureDocsInitialized(projectRoot) {
    const docsRoot = path.join(projectRoot, 'docs');
    const requiredDirs = [
        docsRoot,
        path.join(docsRoot, 'plans'),
        path.join(docsRoot, 'active'),
        path.join(docsRoot, 'archive'),
        path.join(docsRoot, 'context'),
        path.join(docsRoot, '.docs-metadata')
    ];
    const docsExisted = fs.existsSync(docsRoot);
    const missingDirs = requiredDirs.filter(dir => !fs.existsSync(dir));

    try {
        for (const dir of missingDirs) fs.mkdirSync(dir, { recursive: true });
        const indexPath = path.join(docsRoot, '.docs-metadata', 'index.json');
        let indexCreated = false;
        if (!fs.existsSync(indexPath)) {
            try {
                fs.writeFileSync(indexPath, '{}\n', { encoding: 'utf8', flag: 'wx' });
                indexCreated = true;
            } catch (error) {
                if (!error || error.code !== 'EEXIST') throw error;
            }
        }
        const changed = missingDirs.length > 0 || indexCreated;
        return {
            status: changed ? (docsExisted ? 'updated' : 'created') : 'unchanged',
            created_dirs: missingDirs,
            index_created: indexCreated
        };
    } catch (error) {
        return { status: 'failed', error: error.message };
    }
}
```

现有 class API 保持兼容；新函数不覆盖已有 index 或 Markdown 文件，也不删除部分创建结果。

**Step 7: 实现幂等 Apply**

新增：

```js
export async function applyProjectInitialization(plan) {
  if (plan.eligibility !== 'project') {
    return { config: 'skipped', docs: 'skipped' };
  }
  // Plan config_action=create 时才调用 initializeConfigIfMissing(root, 'team')。
  // created，或竞争后 exists+valid 且 documentation.enabled=true，才允许 ensureDocsInitialized(root)。
  // Plan 检出 valid+documentation.enabled=true 时只 repair 缺失 docs；false 时 docs=skipped_disabled。
  // invalid / needs_update / needs_migration 一律 config=explicit_action_required、docs=skipped。
  // 任何失败都返回状态，不删除已创建内容。
}
```

只在 `docs_action === 'create'` 或 `repair_missing_structure` 时用 `createRequire(import.meta.url)` 加载 CJS `ensureDocsInitialized`。Plan 阶段不得构造 `UnifiedDocsManager`。

**Step 8: 运行项目初始化测试确认 GREEN**

Run:

```bash
node --test tests/workflow-router/project-initializer.test.mjs
```

Expected: PASS；重复运行时配置字节不变，invalid / legacy / docs-disabled 配置不触发 docs，敏感目录没有新配置和 docs。

**Step 9: 增加非删除式 docs initializer 测试**

在 `tests/workflow-router/docs-initializer.test.mjs` 验证新 API：首次返回 `created`，第二次返回 `unchanged`，`docs/plans` 等目录和 index 存在；预先存在的 index / Markdown hash 保持不变。fixture 位于保留的 `tests/.artifacts/`，不得改变真实 HOME。

**Step 10: 运行非删除式 docs 测试**

Run:

```bash
node --test tests/workflow-router/docs-initializer.test.mjs
```

Expected: PASS；首次创建、重复 unchanged 和已有内容不覆盖均通过。既有 `tests/integration/test-docs-system.sh` 延后到 Task 9 删除行为审计与用户授权之后运行。

**Step 11: 提交本任务**

```bash
git add lib/project-initializer.mjs \
        lib/config-manager.js \
        lib/docs-core.js \
        .gitignore \
        tests/workflow-router/project-initializer.test.mjs \
        tests/workflow-router/docs-initializer.test.mjs
git commit -m "feat: safely initialize team project configuration"
```

---

### Task 4: 实现 Codex AGENTS 托管区块

**Files:**

- Create: `lib/agents-managed-block.mjs`
- Create: `skills/using-horspowers/templates/codex-agents-managed-block.md`
- Create: `tests/workflow-router/agents-managed-block.test.mjs`

**Step 1: 写托管区块失败测试**

使用隔离 fake home，覆盖：

- `~/.codex/AGENTS.md` 不存在时创建。
- 已有用户正文时只追加区块，正文逐字节保留。
- version 1 重复运行返回 `unchanged`，只有一个 start marker。
- version 0 更新到 version 1 前创建备份，只替换 marker 内文本。
- 重复 marker、缺 end marker、嵌套 marker 时返回 `failed`，原文件字节不变。
- host 为 `claude` 或 `other` 时返回 `skipped`，不创建任何全局文件。

**Step 2: 运行测试确认 RED**

Run:

```bash
node --test tests/workflow-router/agents-managed-block.test.mjs
```

Expected: FAIL，module 和模板不存在。

**Step 3: 创建 version 1 模板**

模板只包含设计文档定义的四类规则，不复制完整 Skill 流程。marker 必须是：

```markdown
<!-- horspowers:managed-routing:start version=1 -->
...
<!-- horspowers:managed-routing:end -->
```

**Step 4: 实现 Plan / Apply API**

导出：

```js
export async function planAgentsBlock({ host, homeDir, templatePath }) {
  // 只读并验证 marker；返回 create/update/unchanged/skipped/failed。
}

export async function applyAgentsBlock(plan) {
  // create 使用 wx；update 先 copyFile 到时间戳 backup，再原子写临时文件并 rename。
  // 只替换 marker 范围；不修改区块外内容；不删除任何备份。
}
```

真实 CLI 的 `homeDir` 来自 `os.homedir()`；测试通过 library 参数注入 fake home，stdin 契约不暴露 `homeDir`。

**Step 5: 运行测试确认 GREEN**

Run:

```bash
node --test tests/workflow-router/agents-managed-block.test.mjs
```

Expected: PASS；损坏 marker 测试原文件 hash 前后相同。

**Step 6: 提交本任务**

```bash
git add lib/agents-managed-block.mjs \
        skills/using-horspowers/templates/codex-agents-managed-block.md \
        tests/workflow-router/agents-managed-block.test.mjs
git commit -m "feat: manage the Codex AGENTS routing block"
```

---

### Task 5: 合并单进程 Plan / Apply 并收缩 using-horspowers

**Files:**

- Modify: `lib/workflow-router.mjs`
- Modify: `skills/using-horspowers/scripts/route-request.mjs`
- Modify: `skills/using-horspowers/SKILL.md`
- Create: `skills/using-horspowers/references/config-bootstrap.md`
- Create: `skills/using-horspowers/references/host-path-resolution.md`
- Modify: `skills/using-horspowers/references/codex-tools.md`
- Create: `tests/workflow-router/plan-apply.test.mjs`
- Create: `tests/codex/test-fast-slow-routing.sh`

**Step 1: 写“Plan 失败零写入”的失败测试**

构造以下失败输入并记录 fake HOME、项目根目录树与文件 hash：

- malformed JSON、非法输入 schema、相对 cwd：CLI non-zero、stdout 为空、零写入。
- malformed rules、不兼容 rule version、分类器内部抛错：CLI exit 0，返回 `routing.route=uncertain`、有限 `routing_error`、mutations 为空。
- AGENTS marker 重复/损坏、项目 Plan 抛错或任一 Plan 返回 `failed`：在任何 Apply 前短路为 `uncertain`、`routing_error=PLAN_FAILED`、mutations 为空。

每个 case 后断言：没有 AGENTS、配置或 docs 写入。

**Step 2: 写 Apply 续作测试**

通过依赖注入让 docs Apply 第一次失败：

1. 第一次调用：AGENTS=`created`、config=`created`、docs=`failed`，routing 仍合法。
2. 第二次调用：AGENTS=`unchanged`、config=`unchanged`、docs=`created`。
3. 没有删除或回滚第一次产物。

**Step 3: 运行 Plan / Apply 测试确认 RED**

Run:

```bash
node --test tests/workflow-router/plan-apply.test.mjs
```

Expected: FAIL，统一编排尚未接入。

**Step 4: 实现统一编排**

`routeRequest` 顺序必须固定：

```js
export async function routeRequest(input, dependencies = defaultDependencies) {
  const validated = validateInput(input);
  let routing;
  try {
    const rules = await dependencies.loadRules();
    routing = classifyRequest(validated, rules);
  } catch (error) {
    return buildUncertainWithoutMutations(classifyRoutingError(error));
  }

  const agentsPlan = await dependencies.planAgents({ host: input.host });
  const projectPlan = await dependencies.planProject({ cwd: input.cwd });

  // 到这里之前全部只读；Plan 异常或任一 plan.status=failed 时：
  // return buildUncertainWithoutMutations('PLAN_FAILED')，不得调用任何 Apply。
  if (agentsPlan.status === 'failed' || projectPlan.status === 'failed') {
    return buildUncertainWithoutMutations('PLAN_FAILED');
  }
  const agents = await dependencies.applyAgents(agentsPlan);
  const project = await dependencies.applyProject(projectPlan);

  return buildStableOutput({ routing, agents, project });
}
```

Apply 顺序是 AGENTS、配置、docs；每一步独立记录 mutation status。路由结果在任何 Apply 前完成。

**Step 5: 运行 Plan / Apply 测试确认 GREEN**

Run:

```bash
node --test tests/workflow-router/plan-apply.test.mjs
```

Expected: PASS；失败路径零写入，续作路径幂等。

**Step 6: 将配置说明迁入 reference**

把当前 `using-horspowers/SKILL.md` 中以下内容原样语义迁入 `references/config-bootstrap.md`：

- 已有配置的 valid / invalid / needs-update / needs-migration 行为。
- 通用 docs 状态与显式迁移路径。
- 团队 / 个人配置字段解释。

reference 必须明确：自动初始化只处理“配置不存在”；无效、旧版和过期配置不静默修改。

**Step 7: 重写 using-horspowers 为短入口**

先在 `references/host-path-resolution.md` 固定三条路径，不保留占位符：

```text
Claude Code:
  ${CLAUDE_PLUGIN_ROOT}/skills/using-horspowers/scripts/route-request.mjs

Codex macOS/Linux:
  $HOME/.agents/skills/horspowers/using-horspowers/scripts/route-request.mjs

Codex Windows PowerShell:
  $env:USERPROFILE\.agents\skills\horspowers\using-horspowers\scripts\route-request.mjs
```

每条路径在执行前必须验证为普通可读文件并解析真实路径。Codex 的 symlink、junction 或复制安装都以 native discovery 目录为入口；不得根据仓库名扫描整个用户目录。未知宿主无法从 native skill metadata 得到根路径时，跳过脚本并回退 LLM，零写入。

正文按宿主包含不带占位符的安全 stdin 示例。Codex macOS/Linux 示例：

```bash
printf '%s' "$HORSPOWERS_ROUTER_INPUT" | \
  node "$HOME/.agents/skills/horspowers/using-horspowers/scripts/route-request.mjs"
```

Claude 示例使用 `${CLAUDE_PLUGIN_ROOT}`；Windows 示例使用 PowerShell 管道和 `$env:USERPROFILE`。三者都必须由宿主安全序列化 JSON 到环境变量或 stdin，不得插值用户消息到 command string。

Skill 必须要求宿主用原生结构化输入或安全环境变量构造 JSON，不得把用户消息直接插入 shell。结果处理规则：

- 唯一 `target_skill`：立即加载它，不再做泛化 Skill 判断。
- `direct`：直接处理，不调用 qmd。
- `uncertain`：只比较 `candidates`，必要时问一个关键问题。
- CLI non-zero：不假设初始化成功，回退 LLM 路由。

正文目标不超过 170 行；详细配置和 Codex 工具映射按需读取。

**Step 8: 创建 Codex 文本 smoke test**

`tests/codex/test-fast-slow-routing.sh` 至少检查：

- `using-horspowers` 指向 `route-request.mjs`。
- stdin-only 约束存在。
- high-confidence / direct / uncertain 三条分支存在。
- `SKILL.md` 不再包含完整初始化问答模板。
- fake HOME + 临时 Git project 的 CLI 调用返回唯一 `target_skill`。

测试只操作 fake HOME，不读取或写入真实 `~/.codex/AGENTS.md`。

**Step 9: 运行 Task 5 测试**

Run:

```bash
node --test tests/workflow-router/*.test.mjs
bash tests/codex/test-fast-slow-routing.sh
```

Expected: Node tests全部 PASS，shell test 输出 `Fast/slow routing tests passed`。

**Step 10: 提交本任务**

```bash
git add lib/workflow-router.mjs \
        skills/using-horspowers/scripts/route-request.mjs \
        skills/using-horspowers/SKILL.md \
        skills/using-horspowers/references/config-bootstrap.md \
        skills/using-horspowers/references/host-path-resolution.md \
        skills/using-horspowers/references/codex-tools.md \
        tests/workflow-router/plan-apply.test.mjs \
        tests/codex/test-fast-slow-routing.sh
git commit -m "feat: route using-horspowers through one local script"
```

---

### Task 6: 精简 Claude SessionStart 并更新 Codex 安装说明

**Files:**

- Modify: `hooks/session-start.sh`
- Modify: `tests/claude-code/test-brainstorming-smoke.sh`
- Create: `tests/claude-code/test-fast-slow-routing.sh`
- Modify: `tests/claude-code/suite-helpers.sh`
- Modify: `docs/README.codex.md`
- Modify: `.codex/INSTALL.md`

**Step 1: 写 Claude hook 失败测试**

测试运行 `hooks/session-start.sh` 的隔离 fixture，断言：

- additionalContext 仍包含精简版 `using-horspowers`。
- 仍包含轻量 config status marker。
- 不包含旧的“请选择你的开发模式”完整问答正文。
- SessionStart 不创建 `.horspowers-config.yaml` 或 docs。
- 输出提示后续调用同一个 `route-request.mjs`。

**Step 2: 运行测试确认 RED**

Run:

```bash
bash tests/claude-code/test-fast-slow-routing.sh
```

Expected: FAIL，当前 hook 仍注入完整 skill / 旧流程。

**Step 3: 收缩 SessionStart 工作量**

保留：

- plugin root 解析。
- legacy / upgrade warning。
- 配置状态只读检测 marker。
- 精简版 `using-horspowers` 注入。
- SessionStart / SessionEnd hook 注册。

移除 SessionStart 对完整文档状态树的预展开；不在 hook 中执行项目初始化、qmd 或目标 Skill 路由。不得新增 `~/.claude/CLAUDE.md` 写入。

**Step 4: 更新 Claude smoke suite 清单**

在实际拥有 suite 清单的 `tests/claude-code/suite-helpers.sh` 中把 `test-fast-slow-routing.sh` 加入 smoke suite；不修改只负责参数和执行编排的 `run-skill-tests.sh`。保持现有 brainstorming / writing-plans smoke tests。必要时调整 `test-brainstorming-smoke.sh`，使其验证目标 Skill 仍可被加载，而不是要求 SessionStart 内含完整正文。

**Step 5: 更新 Codex 安装与冲突说明**

`docs/README.codex.md` 和 `.codex/INSTALL.md` 改为：

- native skill discovery 仍是首次发现入口。
- 首次执行 `using-horspowers` 会幂等安装 versioned AGENTS managed block。
- 不建议用户手工复制完整 bootstrap。
- marker 损坏时手工修复，不自动覆盖区块外内容。
- Windows 仍使用 junction；AGENTS 路径按用户 profile 解析。

**Step 6: 运行 Claude smoke tests**

Run:

```bash
bash tests/claude-code/test-fast-slow-routing.sh
```

Expected: 新的非删除式测试 PASS，并静态确认 `suite-helpers.sh` 已包含该文件。现有 smoke suite 延后到 Task 9 删除行为审计与用户授权之后运行。

**Step 7: 提交本任务**

```bash
git add hooks/session-start.sh \
        tests/claude-code/test-brainstorming-smoke.sh \
        tests/claude-code/test-fast-slow-routing.sh \
        tests/claude-code/suite-helpers.sh \
        docs/README.codex.md \
        .codex/INSTALL.md
git commit -m "feat: slim Claude startup routing context"
```

---

### Task 7: 实现 brainstorming 并行背景收集与工具回退

**Files:**

- Create: `skills/brainstorming/scripts/collect-context.mjs`
- Modify: `skills/brainstorming/SKILL.md`
- Create: `tests/context-collector/collector.test.mjs`
- Create: `tests/context-collector/fixtures/README.md`
- Create: `tests/claude-code/test-brainstorming-context.sh`
- Modify: `tests/claude-code/suite-helpers.sh`
- Modify: `tests/codex/run-tests.sh`
- Create: `tests/codex/test-brainstorming-context.sh`

**Step 1: 写能力探测与回退失败测试**

通过注入 command runner / capability map 覆盖：

1. 有 `rg`：文本和文件都使用 rg。
2. 无 `rg` 的 Git 项目：跟踪文件使用 `git grep` / `git ls-files`。
3. 需要未跟踪文件：文本继续回退到有边界 `grep`。
4. 无 Git、无 rg：使用 `grep` / `find`。
5. grep 无 `--exclude-dir`：先枚举文件再逐文件 grep。
6. qmd 不存在：可信 `wiki_root` 使用 Markdown 文本检索。
7. qmd 关键词结果不足：才调用 `qmd query --no-rerank`。
8. qmd query 失败：保留 search 结果。
9. 任一分支失败：其他分支仍完成。
10. 2 个唯一 qmd search 命中会触发 query，3 个不会。
11. secret 文件模式永不读取正文，只增加 skipped count。
12. 每分支 timeout、stdout/stderr cap、hit cap 和最终 JSON cap 均会截断并标记，而不是无限等待或无限输出。

**Step 2: 写真实并发失败测试**

用三个延迟 100ms 的 fake runner 分别模拟 Wiki、仓库、Git；断言总耗时显著小于 300ms，并验证四个 branch 都已启动。测试阈值给 CI 留余量，例如 `< 240ms`。另用永不完成的 fake runner 证明 collector 会在总 10s hard deadline 前返回 timeout 状态。

**Step 3: 运行 collector tests 确认 RED**

Run:

```bash
node --test tests/context-collector/collector.test.mjs
```

Expected: FAIL，collector 不存在。

**Step 4: 实现 stdin-only collector**

collector 接收设计文档中的 JSON；验证 query 不超过 4 KiB、cwd/wiki_root 为绝对路径、known entries 有数量和路径范围上限。核心并发结构：

```js
const [wiki, repository, git, entries] = await Promise.allSettled([
  collectWiki(context),
  collectRepository(context),
  collectGit(context),
  collectKnownEntries(context)
]);

return normalizeBranches({ wiki, repository, git, entries });
```

`normalizeBranches` 输出结构固定为：

```json
{
  "schema_version": 1,
  "query": "...",
  "branches": {
    "wiki": {"status": "ok", "tool": "qmd search", "items": [], "duration_ms": 12, "truncated": false, "error_code": null},
    "repository": {"status": "ok", "tool": "git grep", "items": [], "duration_ms": 8, "truncated": false, "error_code": null},
    "git": {"status": "skipped", "tool": null, "items": [], "duration_ms": 1, "truncated": false, "error_code": "NOT_GIT"},
    "entries": {"status": "ok", "tool": "readFile", "items": [], "duration_ms": 3, "truncated": false, "error_code": null}
  },
  "sensitive_files_skipped": 0,
  "total_duration_ms": 15,
  "truncated": false
}
```

每个 item 必须包含 `source_type / uri_or_path / title / excerpt / observed_at`，Git item 另含 `commit`，Wiki filesystem item 另含 `mtime`。`status` 只允许 `ok / partial / skipped / failed / timeout`；错误只返回固定 `error_code`，详细命令 stderr 截断后放诊断字段且不得含 secret 内容。

所有命令必须通过 `spawn(command, args, { cwd, shell: false })` 调用。输出设置字节和条数上限，超限时标记 `truncated: true`。

硬边界固定为：

| 分支 / 命令 | timeout | 命中 / 读取上限 |
|---|---:|---:|
| repository | 3s | 40 hits |
| git log | 2s | 20 commits |
| known entries | 1s | 12 files，单文件 32 KiB |
| qmd search | 4s | 8 hits |
| qmd query | 8s | 8 hits |
| collector overall | 10s | final JSON 256 KiB |

每个 subprocess stdout 最多 64 KiB、stderr 最多 8 KiB。qmd search 少于 3 个唯一非空结果定义为 `sparse`，只有此时才执行 query。

**Step 5: 实现固定回退链**

实现并在输出中记录实际 `tool`：

```text
text:  rg -n -> git grep -n -> grep -RIn with excludes
files: rg --files -> git ls-files -> find
wiki:  qmd search -> bounded Markdown text search
query: qmd query only after sparse search; no semantic replacement
git:   git log; skip outside Git
```

固定排除目录必须与设计一致。默认已知入口最多读取 12 个：`AGENTS.md`、`CLAUDE.md`、`README.md`、`package.json`、`pyproject.toml`、`go.mod`、`Cargo.toml` 和用户明确传入且位于项目根内的文件。

目录枚举、文本检索和入口读取统一跳过：`.env`、`.env.*`、`*.pem`、`*.key`、`*.p12`、`*.pfx`、`id_rsa*`、`id_ed25519*`、`.npmrc`、`.pypirc`、`credentials*`、`secrets*`、`*token*`、`*.kdbx`。输出只记录 `sensitive_files_skipped` 数量，不返回路径或正文。

**Step 6: 运行 collector tests 确认 GREEN**

Run:

```bash
node --test tests/context-collector/collector.test.mjs
```

Expected: PASS；无 rg / 无 qmd / 分支失败和并发测试全部通过。

**Step 7: 更新 brainstorming Skill**

在 Explore project context 阶段加入：

- 无需为 qmd 单独询问。
- 在开始澄清问题前调用 collector。
- 同一主题一次完整扫描，后续按新事实缺口增量查询。
- 用“仓库事实 / Wiki 历史 / 用户事实 / Agent 推断”标签提问。
- 单一背景分支失败不阻塞 brainstorming。

保留现有用户逐题确认、方案对比、设计审查与 writing-plans gate。

**Step 8: 增加双宿主文本与 smoke 测试**

- 新建非删除式 `tests/claude-code/test-brainstorming-context.sh`，检查并行 collector、来源标签和 qmd 无需确认，并加入 `suite-helpers.sh` smoke 清单。
- `tests/codex/test-brainstorming-context.sh` 在可控 fixture 中调用 collector，验证无 rg 时的 fallback 输出。
- 将 Codex test 加入 `tests/codex/run-tests.sh`。

**Step 9: 运行 brainstorming 相关测试**

Run:

```bash
node --test tests/context-collector/collector.test.mjs
bash tests/codex/test-brainstorming-context.sh
bash tests/claude-code/test-brainstorming-context.sh
```

Expected: 新增的非删除式测试全部 PASS；测试输出明确显示 fallback tool 和四分支状态。既有 `test-brainstorming.sh` 和完整 runner 延后到 Task 9 授权门之后。

**Step 10: 提交本任务**

```bash
git add skills/brainstorming/scripts/collect-context.mjs \
        skills/brainstorming/SKILL.md \
        tests/context-collector/collector.test.mjs \
        tests/context-collector/fixtures/README.md \
        tests/claude-code/test-brainstorming-context.sh \
        tests/claude-code/suite-helpers.sh \
        tests/codex/test-brainstorming-context.sh \
        tests/codex/run-tests.sh
git commit -m "feat: collect brainstorming context in parallel"
```

---

### Task 8: 扩充正负 corpus、统计 over-trigger 并加入路由基准

**Files:**

- Modify: `tests/skill-trigger/corpus.yaml`
- Modify: `tests/skill-trigger/rubric.md`
- Modify: `tests/skill-trigger/runs/baseline-template.yaml`
- Modify: `tests/skill-trigger/run_full_baseline.rb`
- Create: `tests/skill-trigger/host_trace_parser.rb`
- Create: `tests/skill-trigger/test_host_trace_parser.rb`
- Create: `tests/skill-trigger/scripts/evaluate_router.mjs`
- Create: `tests/workflow-router/benchmark.mjs`
- Modify: `tests/skill-trigger/README.md`

**Step 1: 为 corpus schema 写失败检查**

在 `evaluate_router.mjs` 首先验证：

- 原 48 条正样本 ID 保持不变。
- 每条都有 `should_trigger`、`expected_skill` 和可推导 route。
- 新增至少 24 条 `should_trigger: false`。
- 负样本按 4 类各至少 6 条：自包含改写/翻译、纯计算/转换、简短概念解释、无副作用命令语法。
- 至少 8 条邻界负样本含项目词汇但仍应 `uncertain`，不能误判为某个具体 Skill。

**Step 2: 运行 schema 检查确认 RED**

Run:

```bash
node tests/skill-trigger/scripts/evaluate_router.mjs --validate-only
```

Expected: FAIL，当前只有 48 条正样本。

**Step 3: 新增 24+ 负样本**

负样本使用 `expected_skill: ""` 并增加 `expected_route: direct` 或 `expected_route: uncertain`。不得把涉及写入、删除、外部服务、最新事实、具体仓库状态的请求标成 direct。

在原 48 条正样本增加 `expected_route`，映射关系与 `route-rules.json` 一致，但不改变原 ID、user_message 和 expected_skill。

**Step 4: 扩展 rubric 和 run template**

- 保留 primary outcomes：exact、acceptable、miss、wrong、no-trigger-expected。
- 增加派生指标 `over-trigger`：`should_trigger=false` 但加载了流程 Skill。
- 增加 `direct_without_tools`：direct 且流程 Skill/qmd 调用数都为 0。
- summary 分别记录 positive_total、negative_total、over_trigger_count、over_trigger_rate。

**Step 5: 实现确定性 router evaluator**

`evaluate_router.mjs` 对每条 corpus 调用 `classifyRequest`，输出：

```json
{
  "positive": { "exact": 48, "acceptable": 0, "miss": 0, "wrong": 0 },
  "negative": { "total": 24, "over_trigger": 0, "rate": 0 },
  "failures": []
}
```

任何正样本 miss/wrong、负样本 over-trigger 超过 5%、未知 target_skill 都以非零退出。

**Step 6: 运行 evaluator 并调窄规则直到通过**

Run:

```bash
node tests/skill-trigger/scripts/evaluate_router.mjs
```

Expected: 原 48 条 `exact + acceptable = 48/48`，`miss=0`、`wrong=0`；负样本不少于 24，`over-trigger <= 5%`。

若失败，只调整 `route-rules.json` 或 corpus 中确实错误的边界说明；不得删除难例来提高分数。

**Step 7: 让 host runner 正确处理 no-trigger 样本**

修改 `run_full_baseline.rb`：

- `expected_skill` 为空时不尝试 Skill 名匹配。
- 支持 `SKILL_TRIGGER_ONLY_HOST=codex|claude`。
- `should_trigger=false` 时统计 no-trigger-expected / over-trigger。
- route-rule version 写入独立 run metadata。
- 删除 `ROUTE_ONLY_INSTRUCTION` 中的 `Do not use tools`，Claude 不再传 `--tools ""`。
- route-only prompt 明确只允许执行当前 worktree 的绝对 `route-request.mjs`，读取它返回的 JSON，加载/宣布唯一 target Skill 后停止；不得执行用户原始任务。
- Codex 使用 `codex exec --json`；Claude 使用 `--output-format stream-json --verbose`，保留 tool events。
- 不再调用会 `rm_rf` 真实 `~/.agents/skills/horspowers` 的 `ensure_skill_symlink`。runner 直接把当前 worktree 的精简 `using-horspowers` startup profile 和绝对 route script 路径交给宿主，不修改真实 HOME 或 native skill 目录。
- `ARTIFACT_ROOT` 改为 `runs/artifacts/<run-id>-<pid>`；目录若已存在立即失败，不覆盖旧 results、summary 或 stdout/stderr。
- 所有输出文件用 exclusive create；runner 结束后保留 artifacts，不主动删除。
- 每次 run 用 `Dir.mktmpdir` 的非 block 形式创建并保留唯一 fake HOME 与 Git fixture；route script 子进程单独设置 `HOME=<fake-home>`，输入 `cwd=<fixture-root>`，宿主进程仍使用其正常认证环境。fixture 路径写入 run metadata，禁止指向真实项目或真实全局 AGENTS。

新增 `host_trace_parser.rb`，按宿主结构化事件解析：

```ruby
TraceResult = Struct.new(
  :router_calls, :router_json, :target_skill_mentions,
  :qmd_calls, :other_tool_calls, :runtime_failures,
  keyword_init: true
)
```

使用 Ruby 2.6.10 可用的 `Struct.new(..., keyword_init: true)`，不得使用 Ruby 3.2 才提供的 `Data.define`。

评分依据固定为：router JSON 的 route / target_skill 是路由正确性事实；宿主是否执行一次 router、是否遵守唯一 target Skill、direct 后是否还有流程 Skill 或 qmd 调用是宿主集成事实。不能只凭自然语言包含 Skill 名就判 exact。

**Step 8: 为结构化 trace parser 写并运行测试**

`test_host_trace_parser.rb` 使用脱敏 fixture 字符串覆盖 Codex JSONL、Claude stream-json、direct 无工具、qmd over-trigger、runtime failure 和 malformed trace。

Run:

```bash
ruby tests/skill-trigger/test_host_trace_parser.rb
```

Expected: PASS；每个 fixture 得到确定的 router_calls、target skill、qmd_calls 和 failure 分类。

**Step 9: 创建 100 次独立进程 benchmark**

`tests/workflow-router/benchmark.mjs`：

- 建立隔离 fake HOME 和普通 Git fixture。
- 使用固定、不超过 4 KiB 的 corpus 输入。
- 运行 100 次独立 `node route-request.mjs` 进程。
- 不排除首次进程和冷启动。
- 计算 P50 / P95 / max。
- 输出 OS、CPU、Node 版本、router version 和 rule version。
- P95 > 150ms 时非零退出。

**Step 10: 运行 benchmark**

Run:

```bash
node tests/workflow-router/benchmark.mjs
```

Expected: 100 次完成，P95 <= 150ms；输出完整环境元数据。

**Step 11: 提交本任务**

```bash
git add tests/skill-trigger/corpus.yaml \
        tests/skill-trigger/rubric.md \
        tests/skill-trigger/runs/baseline-template.yaml \
        tests/skill-trigger/run_full_baseline.rb \
        tests/skill-trigger/host_trace_parser.rb \
        tests/skill-trigger/test_host_trace_parser.rb \
        tests/skill-trigger/scripts/evaluate_router.mjs \
        tests/workflow-router/benchmark.mjs \
        tests/skill-trigger/README.md
git commit -m "test: add router negatives and latency benchmark"
```

---

### Task 9: 运行跨宿主验收并记录结果

**Files:**

- Create: `tests/skill-trigger/runs/2026-08-05-fast-slow-routing-v1.yaml`
- Modify: `RELEASE-NOTES.md`
- Modify: `docs/plans/2026-08-05-design-fast-slow-workflow-routing.md`
- Modify: `docs/plans/2026-08-05-fast-slow-workflow-routing-implementation.md`

**Step 1: 运行纯函数与安全边界测试**

Run:

```bash
node --test tests/workflow-router/*.test.mjs
node --test tests/context-collector/*.test.mjs
node tests/skill-trigger/scripts/evaluate_router.mjs
node tests/workflow-router/benchmark.mjs
```

Expected: 全部 exit 0；router evaluator 和 P95 达到 Task 8 阈值。

**Step 2: 审计 legacy suite 的删除行为并请求执行授权**

先只读列出本阶段计划调用脚本中的 `rm`、`rm_rf`、cleanup trap 和可能替换 skill link 的位置：

```bash
if command -v rg >/dev/null 2>&1; then
  rg -n 'rm(_rf)?\b|rm -|cleanup|ensure_horspowers_skill_dir' \
    tests/codex tests/claude-code tests/integration
elif git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git grep -n -E 'rm(_rf)?\b|rm -|cleanup|ensure_horspowers_skill_dir' -- \
    tests/codex tests/claude-code tests/integration
else
  grep -RIn -E 'rm(_rf)?\b|rm -|cleanup|ensure_horspowers_skill_dir' \
    tests/codex tests/claude-code tests/integration
fi
```

Expected: 输出精确文件和行号。向用户说明这些命令只针对各测试创建的临时 fixture / output，另行指出任何可能触及 `~/.agents/skills/horspowers` 的脚本；在用户明确批准前，不运行 Step 3–5 的 legacy suites。

若用户拒绝，跳过 Step 3–5，在 run record 写枚举值 `not_run_user_did_not_authorize_cleanup`；不得把它们记为 PASS。Task 9 的新 router host baseline 不依赖这些 suite，仍可继续。

**Step 3: 获批后运行 Codex compatibility suite**

Run:

```bash
bash tests/codex/run-tests.sh
```

Expected: `All Codex compatibility tests passed`。若本机缺 `timeout`，运行所有不依赖 timeout 的窄测试，并在 run record 记录未执行项和风险。

**Step 4: 获批后运行 Claude smoke 与相关 full tests**

Run:

```bash
bash tests/claude-code/run-skill-tests.sh --suite smoke
bash tests/claude-code/test-brainstorming.sh
```

Expected: smoke suite 与 brainstorming full test PASS；宿主 CLI 缺失时只允许测试 runner 明确 SKIP，不得记录为 PASS。

**Step 5: 获批后运行文档系统和完整 workflow integration**

Run:

```bash
bash tests/integration/test-docs-system.sh
bash tests/integration/run-integration-tests.sh
```

Expected: 文档自动初始化和跨 Skill 流程均通过；任何真实宿主异常单独记录。

**Step 6: 运行非删除式 Codex 48 条正样本 route-only 验收**

Run:

```bash
SKILL_TRIGGER_ONLY_HOST=codex \
SKILL_TRIGGER_ROUTE_ONLY=true \
ruby tests/skill-trigger/run_full_baseline.rb
```

Expected: 原 48 条正样本 `exact + acceptable = 48/48`、`miss=0`、`wrong=0`；新增负样本 `over-trigger <= 5%`。外部服务错误、stream disconnect 和 timeout 单独归为 host runtime failure，不得伪装成路由通过。

runner 为每次 run 创建并保留唯一 fake HOME、Git fixture 和 artifact directory；route script 子进程使用 fake HOME，不写真实 `~/.codex/AGENTS.md`，不修改真实 `~/.agents/skills`。结构化 trace parser 必须证明每个样本恰好调用一次 router，并以 router JSON 而不是自然语言关键词评分。

**Step 7: 视可用性运行非删除式 Claude route-only 验收**

Run:

```bash
SKILL_TRIGGER_ONLY_HOST=claude \
SKILL_TRIGGER_ROUTE_ONLY=true \
ruby tests/skill-trigger/run_full_baseline.rb
```

Expected: 强触发样本 `miss=0`、`wrong=0`；负样本 over-trigger 单独统计。若 Claude CLI 不可用，在 run record 标为 not-run。

**Step 8: 创建独立 run record**

从 `baseline-template.yaml` 创建 `2026-08-05-fast-slow-routing-v1.yaml`，填写：

- 测试 commit。
- router / rule version。
- Codex / Claude model 与 startup profile。
- 72+ 样本统计。
- P50 / P95 / max 和环境。
- host runtime failures。
- legacy suite 状态固定为 `passed / failed / skipped_missing_command / not_run_user_did_not_authorize_cleanup`，不得使用自由文本代替。

不得覆盖 2026-05-11 或 2026-05-13 的历史记录。

**Step 9: 更新发布说明与文档状态**

在 `RELEASE-NOTES.md` 记录用户可见变化、兼容边界和回滚说明。只有所有必需验收通过后，才把设计状态改为“已实施”，并在本计划末尾追加实际验证命令和结果；否则保持“待实施”或标记具体阻塞项。

**Step 10: 运行最终 diff 检查**

Run:

```bash
git diff --check
git status --short
```

Expected: `git diff --check` exit 0；status 只包含本计划列出的实现文件，不包含当前主工作树的 README、beads、codex-issue-action 既有修改。

**Step 11: 提交验收记录**

```bash
git add tests/skill-trigger/runs/2026-08-05-fast-slow-routing-v1.yaml \
        RELEASE-NOTES.md \
        docs/plans/2026-08-05-design-fast-slow-workflow-routing.md \
        docs/plans/2026-08-05-fast-slow-workflow-routing-implementation.md
git commit -m "docs: record fast slow routing verification"
```

## 完成标准

只有同时满足以下条件，实施才可声明完成：

1. 规则 schema、纯路由、Plan / Apply、项目资格、AGENTS 和 collector 测试全部通过。
2. 敏感目录、Wiki-native 和软链接测试证明没有项目初始化写入。
3. 原 48 条 Codex 正样本保持 48/48 exact+acceptable。
4. 新增至少 24 条负样本且 over-trigger 不高于 5%。
5. 100 次独立进程 P95 不高于 150ms。
6. 无 rg、无 qmd、grep 缺 exclude-dir 和单分支失败均有通过的回退测试。
7. 非删除式 Codex baseline 已执行，Claude 在 CLI 可用时已执行；legacy suites 只有获删除授权后才运行，未授权项必须记录，完成声明不得写成“完整回归全部通过”。
8. `git diff --check` 通过，且未覆盖用户当前的无关修改。

## 设计验收标准映射

| 设计验收项 | 实施任务 | 唯一主验证入口 |
|---|---|---|
| 安全项目资格与静默团队初始化 | Task 3 | `node --test tests/workflow-router/project-initializer.test.mjs` |
| AGENTS 幂等注入、备份与区块外不变 | Task 4 | `node --test tests/workflow-router/agents-managed-block.test.mjs` |
| Plan 失败零写入、Apply 可续作 | Task 5 | `node --test tests/workflow-router/plan-apply.test.mjs` |
| 唯一 target Skill、冲突 uncertain、direct allowlist | Task 1–2 | `node --test tests/workflow-router/route-rules.test.mjs tests/workflow-router/classifier.test.mjs` |
| 原 48 条正样本与 24+ 负样本质量 | Task 8 | `node tests/skill-trigger/scripts/evaluate_router.mjs` |
| Codex / Claude 实际调用 router 并遵守结果 | Task 8–9 | 非删除式 `run_full_baseline.rb` + `host_trace_parser.rb` |
| 100 次独立进程 P95 | Task 8 | `node tests/workflow-router/benchmark.mjs` |
| brainstorming 四分支并行、无 rg/qmd 回退 | Task 7 | `node --test tests/context-collector/collector.test.mjs` |
| Claude 精简 SessionStart | Task 6 | `bash tests/claude-code/test-fast-slow-routing.sh` |
| 旧宿主 / integration 回归 | Task 9 | 用户授权后的 legacy suites；状态写入 run record |

## 执行交接

计划获批后，先使用 `horspowers:using-git-worktrees` 创建独立 worktree，再选择：

1. `horspowers:subagent-driven-development`：当前会话按 Task 连续推进并逐任务审查。
2. `horspowers:executing-plans`：独立会话按批次执行，在 Task 2、5、8、9 后设置检查点。

## 实际验收记录（2026-08-05）

- Task 1–8 的实现以独立提交落地；Task 9 最终测试提交为 `b79be82aeb12a26ce455667da3b37b1973e1f911`，run record 为 [`2026-08-05-fast-slow-routing-v1.yaml`](../../tests/skill-trigger/runs/2026-08-05-fast-slow-routing-v1.yaml)。
- 已运行：`node --test tests/workflow-router/*.test.mjs`（38 passed）、`node --test tests/context-collector/*.test.mjs`（11 passed）、`node tests/skill-trigger/scripts/evaluate_router.mjs`（48 exact、24 negative、0 over-trigger）、`node tests/workflow-router/benchmark.mjs`（100 次、P95 57.375ms）、`ruby tests/skill-trigger/test_host_trace_parser.rb`（8 passed）及 `ruby tests/skill-trigger/test_run_full_baseline.rb`（8 passed）。
- 非删除式 opaque route-only baseline 已在 Codex 与 Claude 执行：每宿主 72/72；48/48 正样本 exact、24/24 负样本无 over-trigger；逐样本 router_calls=1、extra tools=0、runtime failures=0、integration failures=0。Codex 最终 artifact 使用 fixture-local router 命令，72 条均未回退到长绝对路径转写。
- `git diff --check` 在写入本记录前通过。`tests/codex/run-tests.sh`、Claude smoke / full、docs-system integration 及完整 workflow integration 未运行，因为它们含清理行为且用户未授权；run record 使用枚举值 `not_run_user_did_not_authorize_cleanup`，不宣称“完整回归全部通过”。
