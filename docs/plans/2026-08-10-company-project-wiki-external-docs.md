# 公司项目 Wiki 外置配置与文档实施计划

> **Execution note:** After this plan is approved, use `horspowers:executing-plans` or `horspowers:subagent-driven-development` to implement it task-by-task in the current host.

**日期**: 2026-08-10

## 目标

让 Horspowers 对公司 GitLab 项目从个人 Wiki 精确读取权威配置和已入库文档，并把所有文档变更统一投递到 Wiki Inbox；任何外置链路失败时都不得在公司项目内创建 `.horspowers-config.yaml` 或 Horspowers `docs/`。

## 架构方案

先在项目初始化器前增加纯只读的 Git remote 身份识别，立即阻断公司项目的本地初始化；再通过宿主级 bootstrap、qmd stdio MCP 和严格 Registry/config schema 建立外置配置读取。所有 Skill 与 Hook 最终只调用统一的文档运行时：普通项目走现有 `docs-core.js`，公司项目走 qmd 只读检索与 Inbox-only 投稿，`documentation.submission.auto_submit` 是所有文档类型和写操作的唯一自动投稿开关。

## 技术栈

- Node.js ESM / CommonJS interoperability、`node:test`
- Git CLI（`execFile`，不经 Shell）
- SHA-256、严格 JSON schema-style validation
- MCP JSON-RPC 2025-06-18、qmd 2.5.3 stdio server
- OpenSSH 受限别名 `localwiki` / 既有 Inbox 投稿客户端
- Horspowers Skills、Claude Code SessionStart / SessionEnd hooks

---

## 规格来源与实施护栏

- 权威决策：`qmd://my-code-wiki/decisions/horspowers-wiki-external-docs-2026-08-10.md`
- 当前本机决策页：`/Users/ugreen/hors/my-code-wiki/wiki/decisions/horspowers-wiki-external-docs-2026-08-10.md`
- 当前代码基线：`main@d1b48e4`（Horspowers 4.6.0）
- 必须先在独立 worktree / `codex/` 或 `feat/` 分支实施；不要直接在 `main` 开始功能修改。
- `raw-sources/public/horspowers` 只用于 Wiki 侧 canonical 读取；实施写入实际 Horspowers 工作树。
- 不删除、移动、覆盖既有项目配置、项目文档、Wiki 页面、Inbox 原件或测试 artifacts。任何确需删除的操作先单独取得用户明确授权。
- 不新增 YAML 依赖。Wiki Registry、项目配置和投稿元数据都使用带固定 marker 的严格 JSON 代码块，避免把现有浅层 `parseSimpleYAML` 扩展成不完整 YAML 解析器。
- 不直接写 Wiki 正文，不运行远端 `qmd update`，不把 Inbox 待审核内容当成可检索事实，也不增加跳板机草稿缓存。
- 每个 Task 独立提交。Task 1 是可单独合并的安全止血提交；Task 2–5 建立运行时；Task 6–7 才迁移 Skill 和 Hook。

## 固定数据契约

### 宿主 bootstrap

宿主配置默认只从 `~/.config/horspowers/host.json` 读取，不自动创建。仓库仅提供示例模板：

```json
{
  "schema_version": 1,
  "wiki": {
    "transport": {
      "kind": "ssh-stdio-mcp",
      "ssh_alias": "localwiki",
      "timeout_ms": 20000,
      "max_response_bytes": 262144
    },
    "collection": "my-code-wiki",
    "registry_uri": "qmd://my-code-wiki/projects/horspowers-registry.md",
    "inbox": {
      "command": "/data/horsliu/bin/wiki-inbox-submit",
      "timeout_ms": 20000,
      "max_payload_bytes": 262144
    }
  }
}
```

约束：`kind` 只能是 `ssh-stdio-mcp`；`ssh_alias` 只能匹配 `[A-Za-z0-9._-]{1,64}`；URI 必须位于配置 collection；命令必须是绝对路径且调用时使用 `spawn(command, [safeFilename], { shell: false })`。

### Registry 机器块

````markdown
<!-- horspowers-registry:start -->
```json
{
  "schema_version": 1,
  "projects": {
    "sha256:<64-lowercase-hex>": {
      "project_id": "ugnas/ugcli-lib",
      "config_uri": "qmd://my-code-wiki/projects/ugcli-lib/horspowers-config.md"
    }
  }
}
```
<!-- horspowers-registry:end -->
````

Registry 只能通过 `registry_uri` 精确读取，并按完整 fingerprint 精确查表。不得使用 `query`、文件名相似度或项目显示名选择配置。

### 项目配置机器块

````markdown
<!-- horspowers-config:start -->
```json
{
  "schema_version": 1,
  "project_id": "ugnas/ugcli-lib",
  "project_fingerprint": "sha256:<64-lowercase-hex>",
  "development_mode": "team",
  "branch_strategy": "worktree",
  "testing_strategy": "tdd",
  "completion_strategy": "pr",
  "documentation": {
    "enabled": true,
    "backend": "wiki",
    "collection": "my-code-wiki",
    "root_uri": "qmd://my-code-wiki/projects/ugcli-lib",
    "manifest_uri": "qmd://my-code-wiki/projects/ugcli-lib/index.md",
    "submission": {
      "mode": "inbox-only",
      "auto_submit": true
    }
  }
}
```
<!-- horspowers-config:end -->
````

未知字段、重复 marker、超限内容、URI 越界、Registry 与配置的 project ID/fingerprint 不一致都必须报字段级错误并 fail closed。

### 文档 manifest 机器块

````markdown
<!-- horspowers-manifest:start -->
```json
{
  "schema_version": 1,
  "project_id": "ugnas/ugcli-lib",
  "project_fingerprint": "sha256:<64-lowercase-hex>",
  "documents": {
    "implement-feature": {
      "document_type": "task",
      "uri": "qmd://my-code-wiki/projects/ugcli-lib/tasks/implement-feature.md",
      "revision": 2,
      "status": "active",
      "content_sha256": "<64-lowercase-hex>",
      "updated_at": "2026-08-10T00:00:00Z"
    }
  }
}
```
<!-- horspowers-manifest:end -->
````

manifest 页面最大 256 KiB，只允许上述顶层字段和文档字段；`documents` key 就是唯一 logical ID，必须匹配 `[a-z0-9][a-z0-9-]{0,80}`。`document_type` 只允许 `design/plan/task/bug/decision/context/config/session`，`status` 只允许 `active/completed/archived`，revision 是正整数，时间是 UTC RFC 3339。project ID/fingerprint 必须与配置一致，每个 URI 必须同时位于配置的 collection 和 `root_uri`；content hash 必须与 `get` 到的正文一致，否则返回 `manifest_content_mismatch`。未知字段、重复 marker、超限、越界 URI 或非法 revision 一律 fail closed。

每个已注册公司项目的 manifest 必须存在固定 key `horspowers-config`：`document_type=config`、`status=active`，其 `uri` 必须与 Registry 为当前 fingerprint 选中的 `config_uri` 完全一致，`content_sha256` 必须匹配 qmd 精确读取到的完整配置页面，`revision` 是配置修订的唯一权威版本。项目配置 JSON 自身不再重复 revision。缺少该条目、URI/hash 不一致或 revision 非正整数返回 `config_manifest_mismatch`，文档读取和 config-change 都 fail closed。

config-change 的 `base_revision` 必须等于该 manifest 条目的当前 revision，`proposed_revision = base_revision + 1`；不接受客户端自报其他基线。用户本机入库配置投稿时，必须把配置页面正文和 manifest 的 `revision/content_sha256/updated_at` 作为同一次 Wiki 原生更新完成，再运行 qmd update。若只更新一边，后续读取会因 mismatch 继续 fail closed，避免静默覆盖并发修订。

### 文档运行时 stdin/stdout

Skills 和 Hooks 只通过下面的 JSON stdin 调用 `lib/document-runtime-cli.mjs`，不得把标题、正文、查询词或路径拼进 Shell：

```json
{
  "schema_version": 1,
  "cwd": "/absolute/project/path",
  "action": "resolve|get|search|create|update|archive|restore|config-change|record-session",
  "request": {},
  "confirmed": false
}
```

stdout 始终是单个 JSON 对象并退出，至少含 `status`、`backend`、`project_id`；错误时含稳定 `error_code`，不得用“已保存”描述未成功入库或投稿的内容。

所有写 action 最终转换成统一 mutation：

```json
{
  "operation": "create|update|archive|restore|config-change",
  "document_type": "design|plan|task|bug|decision|context|config|session",
  "logical_id": "stable-logical-id",
  "base_revision": 1,
  "content_kind": "document",
  "content": {
    "schema_version": 1,
    "format": "safe-document",
    "title": "Document title",
    "sections": [
      {
        "heading": "Summary",
        "paragraphs": ["Sanitized summary text"],
        "bullets": ["Sanitized fact"],
        "files": [
          { "operation": "modify", "path": "lib/project-identity.mjs" }
        ],
        "implementation_specs": [
          {
            "kind": "function",
            "language": "javascript",
            "symbol": "normalizeRemoteUrl",
            "inputs": ["remoteUrl: string"],
            "outputs": ["normalized remote identity or invalid"],
            "rules": ["parse supported URL forms", "match the complete host"],
            "errors": ["return invalid for malformed input"]
          }
        ],
        "commands": [
          {
            "program": "node",
            "args": ["--test", "tests/wiki-docs/project-identity.test.mjs"],
            "expected": "PASS"
          }
        ]
      }
    ],
    "references": [
      { "document_type": "decision", "logical_id": "related-decision" }
    ]
  }
}
```

`config-change` 使用同一 mutation envelope，但 content 是第二个且唯一的 discriminated variant：

```json
{
  "operation": "config-change",
  "document_type": "config",
  "logical_id": "horspowers-config",
  "base_revision": 1,
  "content_kind": "project-config",
  "content": {
    "schema_version": 1,
    "project_id": "ugnas/ugcli-lib",
    "project_fingerprint": "sha256:<64-lowercase-hex>",
    "development_mode": "team",
    "branch_strategy": "worktree",
    "testing_strategy": "tdd",
    "completion_strategy": "pr",
    "documentation": {
      "enabled": true,
      "backend": "wiki",
      "collection": "my-code-wiki",
      "root_uri": "qmd://my-code-wiki/projects/ugcli-lib",
      "manifest_uri": "qmd://my-code-wiki/projects/ugcli-lib/index.md",
      "submission": { "mode": "inbox-only", "auto_submit": true }
    }
  }
}
```

该 variant 必须复用 Task 3 的 `validateWikiProjectConfig()`，并再次绑定当前 identity、Registry project ID、collection/root URI。它不接受 safe-document 或 status-transition 字段。合法 config 被 runtime 序列化成唯一 `horspowers-config` JSON machine block，再放进普通 Inbox submission 的 `## Proposed document`；仍使用 `base_revision/proposed_revision`、同一 secret scanner、同一 payload 上限和同一 `auto_submit` 判定。新配置只有用户在本机入库并刷新 qmd 后才生效。

archive/restore 使用 metadata-only `status-transition`；content kind 的完整 allowlist 固定为 `document/project-config/status-transition`。transition envelope 为：

```json
{
  "operation": "archive",
  "document_type": "task",
  "logical_id": "implement-feature",
  "base_revision": 2,
  "content_kind": "status-transition",
  "content": {
    "uri": "qmd://my-code-wiki/projects/ugcli-lib/tasks/implement-feature.md",
    "content_sha256": "<64-lowercase-hex>",
    "from_status": "active",
    "to_status": "archived"
  }
}
```

固定规则：

- 只有 `archive/restore` 可用该 variant；archive 只允许 `active|completed → archived`，restore 只允许 `archived → active`。
- runtime 每次精确读取 manifest entry 和 URI 正文，校验 logical ID、document type、URI、base revision、status 和 content hash 全部一致。
- `proposed_revision = base_revision + 1`；正文 hash 与 URI保持不变，只提议更新 manifest 的 status/revision/updated_at。Wiki archive 是逻辑状态，不移动页面。
- Inbox payload 的 `## Proposed document` 放唯一 `horspowers-status-transition` JSON machine block，不复制既有正文。用户本机入库时只更新 manifest entry；冲突或正文 hash 改变则拒绝该投稿。
- create/update/record-session 生成的正文变更必须用 `document`，config-change 必须用 `project-config`；任何 operation/content-kind 组合错误都 fail closed。

除严格 `project-config` variant 外，公司项目 runtime 不接受任意 Markdown、raw source、日志、diff、blockquote、HTML 或附件作为 mutation content；普通文档只接受上述 `safe-document` AST，并由 runtime 自己序列化 Markdown。每个字段都有长度/数量上限：

- `files[].path` 只能是无 `..`、无 NUL、无绝对前缀的仓库相对路径；operation 只允许 `create/modify/test/review`。
- `commands` 是 `program + args[] + expected`，不是 shell 字符串；program 使用测试/构建 allowlist，参数拒绝 command substitution、重定向、管道、凭据和绝对敏感路径。它们只被渲染为文档，不由 runtime 执行。
- `implementation_specs` 是行为契约而非源码：只允许固定 language/kind、合法 symbol、短输入输出签名、行为 rules 和 errors；禁止任意 code/content/body 字段、字符串字面量块、源码语法树或可复制实现。runtime 把它渲染成“实现约束”表，而不是代码 fence。
- `references` 只能是已验证 manifest logical ID；外部链接不进入自动投稿正文。
- `lib/source-similarity-guard.mjs` 对段落、bullets 和 implementation spec 文本生成规范化 shingle，与 `git ls-files --cached --others --exclude-standard` 返回的跟踪及未跟踪非忽略文本做有界匹配。任一非平凡行或连续 20 字符与项目文件一致即标记 `raw_source_detected`；预算不足标记 `source_scan_incomplete`，两者都禁止投稿并要求改写。
- 私钥/token/认证头/高熵凭据、日志/diff/stack 形态和逐字长引用在 AST 校验、源码相似度检查及序列化后扫描中任一命中即拒绝。

无法安全表示的内容返回 `safe_document_required`，必须改写为结构化摘要、仓库相对引用、结构化命令或 implementation spec；不存在按次安全确认、review token 或第二个自动化开关。验证通过后严格服从 `documentation.submission.auto_submit`：true 自动投递，false 才按全局规则请求确认。Wiki backend 的 `writing-plans` 计划语义相应固定为“行为完备、不可复制源码”：精确文件、symbol、输入输出、行为规则、错误、测试命令和 Expected 结果必须齐全，但不保存完整源码片段；实际编码仍按 TDD 在项目工作树完成。

#### safe-document 固定限制

以下数值是 schema 1 的组成部分，不得在实现时自行调整：

| 项目 | 固定限制 |
|---|---|
| 完整 AST JSON | UTF-8 最大 192 KiB；序列化 Markdown 最大 224 KiB，为 Inbox receiver 的 256 KiB 上限保留 envelope 空间 |
| title | 1–160 个 Unicode code points，禁止换行/NUL |
| sections | 1–32 个 |
| heading | 1–120 code points，禁止 Markdown fence/HTML |
| paragraphs | 每 section 0–12 条；每条 1–1000 code points；全篇合计最大 24,000 |
| bullets | 每 section 0–30 条；每条 1–300 code points；全篇合计最大 300 条 |
| files | 全篇最大 64；path 最大 240 UTF-8 bytes，匹配 `^[A-Za-z0-9._/-]+$`，segment 不得为空、`.` 或 `..` |
| implementation_specs | 全篇最大 64；language 只允许 `javascript/typescript/python/go/rust/shell/json/yaml/text`；kind 只允许 `function/class/module/script/schema/command`；symbol 匹配 `^[A-Za-z_][A-Za-z0-9_.:-]{0,119}$` |
| spec inputs/outputs | 各 0–16 条，每条 1–160 code points |
| spec rules/errors | 各 0–24 条，每条 1–500 code points；全篇 rules+errors 最大 512 条 |
| commands | 全篇最大 64；program 只允许 `node/npm/npx/pnpm/yarn/bun/bash/sh/git/go/cargo/pytest/python3/ruby/rg/make/cmake` |
| command args | 每条命令 0–32 个，每个 1–240 UTF-8 bytes；拒绝 NUL/换行和 `` ` $ ; & | > < ``；拒绝以 `/`、`~`、盘符或 UNC 开头的绝对路径 |
| command expected | 1–300 code points，不得包含原始 stdout/stderr dump |
| references | 全篇最大 64；logical ID 使用 manifest 的固定 regex |

Source similarity guard 固定参数：

- 只读取 `git ls-files -z --cached --others --exclude-standard` 返回的普通文件；不跟随 symlink。
- 最多检查 10,000 个文件、每文件最多 1 MiB、合计最多 64 MiB、墙钟最多 5 秒；任一预算耗尽返回 `source_scan_incomplete`。
- 读取文件前 8 KiB 含 NUL 则按 binary 跳过；其他内容必须能按 UTF-8 解码，否则跳过并只记录 binary count。
- 比较字段包括 paragraphs、bullets、implementation spec 的 inputs/outputs/rules/errors 和 command expected；不比较固定 program 名、relative file path 或 logical ID。
- 规范化为 Unicode NFKC、换行统一 LF、每行 trim、连续空白折叠为一个空格。去除空行后，长度至少 20 code points 的任一规范化行若完整出现在项目文本，或任一连续 20-code-point window 命中，即返回 `raw_source_detected`。
- 秘密扫描把连续 20–256 个 base64/hex/token 字符且 Shannon entropy `>= 3.5 bits/character` 视为高熵候选；schema 明确要求的 `sha256:<64 lowercase hex>` fingerprint 字段只在 machine metadata 中豁免，正文不豁免。
- 日志/diff/stack 固定拒绝信号包括行首 `+/-/@@` patch 组合、ISO 时间戳连续日志行、`at <symbol> (<path>:<line>)`、`Traceback (` 和连续三行 `key=value`；任何命中只返回类别与 AST path，不回显正文。

`record-session` 是批处理 action，不是第六套写入旁路。其 request 固定为：

```json
{
  "session": {
    "session_id": "opaque-id",
    "ended_at": "2026-08-10T00:00:00Z",
    "branch": "feature/name"
  },
  "document_refs": [
    { "document_type": "task", "logical_id": "implement-feature" }
  ],
  "auto_archive_completed": true
}
```

runtime 先读取已入库 manifest/本地索引，把 session record、引用文档进度和已完成归档展开成 document 或 status-transition mutation 列表，再统一走 `mutateBatch()`。`auto_submit=false` 时整批只请求一次确认；确认后每个逻辑文档仍生成独立 Inbox submission。部分成功必须返回 `partially_submitted` 及成功/失败 submission ID，不回滚、不虚报整批成功。config-change 和 status transition 虽使用各自严格 content variant，仍进入同一 `mutate()` 内核，不能走配置提供者或 manifest 的写旁路。

---

### Task 1: 公司项目身份识别与初始化安全止血

**Files:**

- Create: `lib/project-identity.mjs`
- Create: `lib/document-runtime-capabilities.mjs`
- Create: `tests/wiki-docs/project-identity.test.mjs`
- Modify: `lib/project-initializer.mjs:1-215`
- Modify: `lib/workflow-router.mjs:31-300`
- Modify: `skills/using-horspowers/SKILL.md`
- Modify: `hooks/session-start.sh:1-100`
- Modify: `hooks/session-end.sh:1-220`
- Modify: `tests/workflow-router/project-initializer.test.mjs`
- Modify: `tests/workflow-router/plan-apply.test.mjs`
- Modify: `tests/workflow-router/cli.test.mjs`
- Create: `tests/wiki-docs/session-hooks-safety-gate.test.mjs`

**Step 1: 写 remote URL 规范化失败测试**

在 `tests/wiki-docs/project-identity.test.mjs` 先覆盖纯函数：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyRepositoryRemotes,
  normalizeRemoteUrl
} from '../../lib/project-identity.mjs';

const SAME_REPOSITORY = [
  'git@gitlab.ugnas.com:platform/ugcli-lib.git',
  'ssh://git@gitlab.ugnas.com/platform/ugcli-lib.git',
  'https://gitlab.ugnas.com/platform/ugcli-lib.git',
  'git@192.168.75.113:platform/ugcli-lib.git',
  'ssh://git@192.168.75.113:2222/platform/ugcli-lib.git'
];

test('normalizes domain, IP, SSH and HTTPS clones to one company repository', () => {
  const identities = SAME_REPOSITORY.map((url) =>
    classifyRepositoryRemotes([{ name: 'origin', url }])
  );
  assert.equal(new Set(identities.map((item) => item.project_fingerprint)).size, 1);
  assert.equal(identities[0].canonical_repository, 'ugnas-gitlab/platform/ugcli-lib');
});

test('requires exact trusted host matching', () => {
  for (const url of [
    'https://gitlab.ugnas.com.evil.example/platform/ugcli-lib.git',
    'https://192.168.75.113.example/platform/ugcli-lib.git'
  ]) {
    assert.equal(classifyRepositoryRemotes([{ name: 'origin', url }]).kind, 'external');
  }
});

test('rejects conflicting company remotes when origin cannot decide identity', () => {
  const result = classifyRepositoryRemotes([
    { name: 'upstream', url: 'git@gitlab.ugnas.com:a/one.git' },
    { name: 'backup', url: 'git@192.168.75.113:b/two.git' }
  ]);
  assert.equal(result.kind, 'ambiguous_company_remote');
});
```

补充测试：host 大小写/末尾点归一化、端口不参与 host 判断、路径只移除一个末尾 `.git`、保留 subgroup、无 remote、无效 URL、公司 `origin` 优先于其他 remote。

**Step 2: 运行测试确认 RED**

Run:

```bash
node --test tests/wiki-docs/project-identity.test.mjs
```

Expected: FAIL，错误指向 `lib/project-identity.mjs` 不存在。

**Step 3: 实现纯 URL 解析与指纹**

`lib/project-identity.mjs` 使用 `node:url` 和 `node:crypto`，导出：

```js
export const COMPANY_AUTHORITIES = new Map([
  ['gitlab.ugnas.com', 'ugnas-gitlab'],
  ['192.168.75.113', 'ugnas-gitlab']
]);

export function normalizeRemoteUrl(remoteUrl) { /* 返回 host/path 或 invalid */ }
export function classifyRepositoryRemotes(remotes) { /* company/external/none/ambiguous */ }
export async function identifyGitProject(projectRoot, dependencies = {}) { /* 只读 git config */ }
```

实现约束：

- `://` URL 使用 WHATWG `URL`；scp-style 只接受 `user@host:path` / `host:path` 的受限格式。
- host 转小写、移除一个末尾点，使用 `COMPANY_AUTHORITIES.get(host)` 精确匹配；禁止 `includes` / `endsWith`。
- repository path 移除首尾 `/` 和一个末尾 `.git`，空路径视为 invalid。
- `canonical_repository = authority + '/' + normalizedPath`。
- `project_fingerprint = 'sha256:' + createHash('sha256').update(canonicalRepository).digest('hex')`。
- Git remote 通过 `execFile('git', ['-C', root, 'config', '--get-regexp', '^remote\\..*\\.url$'])` 读取；URL 永远不进入 shell command。
- `origin` 命中公司时使用 origin；否则公司候选按 canonical repository 去重，唯一则选用，多个则 ambiguous。

**Step 4: 运行身份测试确认 GREEN**

Run:

```bash
node --test tests/wiki-docs/project-identity.test.mjs
```

Expected: PASS。

**Step 5: 写初始化 fail-closed 失败测试**

扩展 `tests/workflow-router/project-initializer.test.mjs`：公司 fixture 设置 remote 后，在存在和不存在本地配置两种情况下均断言：

```js
assert.equal(plan.eligibility, 'external_project');
assert.equal(plan.reason, 'company_external_config_required');
assert.equal(plan.config_action, 'external_required');
assert.equal(plan.docs_action, 'skipped');

const before = await snapshotTree(root);
const result = await applyProjectInitialization(plan);
const after = await snapshotTree(root);
assert.deepEqual(after, before);
assert.equal(result.config.status, 'external_required');
assert.equal(result.docs.status, 'skipped');
```

`snapshotTree` 只读记录相对路径、类型、内容 hash；不要通过删除 fixture 做清理。

**Step 6: 在所有本地探测和写入前增加安全门**

修改 `planProjectInitialization()`：解析 Git root 后立即调用 `identifyGitProject(projectRoot)`。命中公司项目时，在 `isWritableDirectory()`、`classifyConfigAtRoot()` 和 `docsActionFor()` 之前返回 external plan；ambiguous 时返回 `ambiguous_company_remote`；无 remote 时返回 `unregistered_no_remote` 且不初始化。非公司 remote 保持当前本地行为。

`applyProjectInitialization()` 对 `external_project` 永远只返回状态，不调用 `initializeConfigIfMissing()` 或 `ensureDocsInitialized()`。

**Step 7: 在外置运行时完成前阻断目标 Skill**

Task 1 单独合并后，公司项目不能只跳过 initializer 却继续加载会直接写 `docs/` 的旧 Skill。修改 Router 和 `using-horspowers` 的消费契约：

- Router 仍保留分类得到的 `route`，便于诊断，但公司 external plan 未解析出可用 Wiki runtime 时必须返回 `target_skill:null`、`blocked_by:'company_external_config_required'`。
- `using-horspowers` 看到 `blocked_by` 时不得加载原候选 Skill；应报告“外置文档运行时尚未就绪，Horspowers 工作流已安全暂停”，普通手工代码操作仍可继续。
- Task 1 新增 `lib/document-runtime-capabilities.mjs`，初始固定 `EXTERNAL_DOCUMENT_RUNTIME_VERSION = 0`。Router 只有在版本 `>= 1` 时才允许公司项目恢复 target Skill；Task 2–6 无论 Wiki 是否 ready 都不得提前修改该值。
- Task 7 完成十个 Skill、upgrade 和两个 Session hooks 的迁移与端到端零写入测试后，才把 capability 改为 1 并恢复唯一 `target_skill`。此后 Wiki ready/unavailable 只决定文档持久化状态：已迁移的代码工作流仍可运行，unavailable 时明确报告“未持久化”。

在 `plan-apply.test.mjs` 和 `cli.test.mjs` 增加真实 planning/brainstorming 消息的测试，断言公司 fixture 的 Router 输出没有 target Skill，且 tree snapshot 不变；普通项目仍返回原 target Skill。

**Step 8: 给 Session hooks 增加同一只读止血门**

Task 1 必须同步修改两个 Hook，不能等待 Task 7：

- SessionStart 在本地 config/upgrade 检查前调用 `identifyGitProject()`；公司、ambiguous 或 no-remote 状态不再注入本地 `needs-init` / `/upgrade` 提示，只输出 external safety 状态。
- SessionEnd 在任何 `mkdir`、metadata、task/bug append、archive 或 `docs-core` 调用前执行相同识别；公司、ambiguous 或 no-remote 立即返回合法 hook JSON，说明外置 runtime 尚未就绪且本次未持久化。
- 普通 remote 保持现有 Hook 行为。

`session-hooks-safety-gate.test.mjs` 对“残留本地配置 + docs/active + TASK_DOC/BUG_DOC 环境变量”的公司 fixture 运行真实 Hook，比较前后 tree snapshot；同时覆盖普通 remote 对照组。Task 7 再把这个临时 identity-only guard 替换为完整 DocumentRuntime，不得在中间提交移除保护。

**Step 9: 运行初始化、Hook 与端到端路由回归测试**

Run:

```bash
node --test tests/wiki-docs/project-identity.test.mjs \
  tests/workflow-router/project-initializer.test.mjs \
  tests/workflow-router/plan-apply.test.mjs \
  tests/workflow-router/cli.test.mjs \
  tests/wiki-docs/session-hooks-safety-gate.test.mjs
```

Expected: PASS；公司 fixture 字节级无新增且不会加载旧的文档型 target Skill，普通 Git 项目仍按现状初始化和路由。

**Step 10: 提交安全止血变更**

```bash
git add lib/project-identity.mjs \
  lib/document-runtime-capabilities.mjs \
  lib/project-initializer.mjs \
  lib/workflow-router.mjs \
  skills/using-horspowers/SKILL.md \
  hooks/session-start.sh hooks/session-end.sh \
  tests/wiki-docs/project-identity.test.mjs \
  tests/wiki-docs/session-hooks-safety-gate.test.mjs \
  tests/workflow-router/project-initializer.test.mjs \
  tests/workflow-router/plan-apply.test.mjs \
  tests/workflow-router/cli.test.mjs
git commit -m "fix: prevent local docs initialization for company projects"
```

---

### Task 2: 宿主 bootstrap 与有界 qmd MCP 精确读取

**Files:**

- Create: `skills/using-horspowers/templates/host-config.example.json`
- Create: `lib/host-config.mjs`
- Create: `lib/mcp-stdio-client.mjs`
- Create: `lib/qmd-mcp-client.mjs`
- Create: `tests/wiki-docs/fixtures/fake-qmd-mcp.mjs`
- Create: `tests/wiki-docs/host-config.test.mjs`
- Create: `tests/wiki-docs/qmd-mcp-client.test.mjs`

**Step 1: 写 host config 严格校验失败测试**

测试默认路径解析、合法配置，以及以下拒绝项：未知字段、相对 Inbox command、非法 SSH alias、非 `qmd://<collection>/...` URI、超出 1–120 秒 timeout、响应或 payload 上限超过 256 KiB。读取缺失配置返回 `host_config_missing`，不得创建文件。

**Step 2: 运行 host config 测试确认 RED**

```bash
node --test tests/wiki-docs/host-config.test.mjs
```

Expected: FAIL，模块不存在。

**Step 3: 实现只读 host config loader**

`lib/host-config.mjs` 导出 `defaultHostConfigPath(homeDir)`、`validateHostConfig(value)`、`readHostConfig(path)`。使用 `readFile` + `JSON.parse`，精确比较每层 keys，返回结构化 `{ok, config}` 或 `{ok:false, error_code, errors}`；不得自动 mkdir 或写默认配置。

**Step 4: 写 qmd MCP 客户端失败测试**

fake server 必须实现 newline-delimited JSON-RPC：

- `initialize` 返回 protocol `2025-06-18`。
- `tools/list` 只暴露 `query/get/multi_get/status`。
- `tools/call` 的 `get` 接受 `{file, fromLine, maxLines, lineNumbers}`。
- 环境变量控制 malformed JSON、超限输出、超时、缺少 get tool 和 RPC error。

测试 `QmdMcpClient.getExact(uri)` 只调用 `get`，不会调用 `query`；并断言子进程由注入的 `spawnImpl` 以 `shell:false` 启动。

**Step 5: 运行 qmd 测试确认 RED**

```bash
node --test tests/wiki-docs/qmd-mcp-client.test.mjs
```

Expected: FAIL，客户端模块不存在。

**Step 6: 实现通用 stdio MCP 与 qmd 包装器**

`lib/mcp-stdio-client.mjs` 负责：

- `spawn('ssh', ['-T', sshAlias], { shell: false, stdio: ['pipe','pipe','pipe'] })`。
- 发送 `initialize`、`notifications/initialized`，再发送 `tools/list` / `tools/call`。
- 单调递增 request ID，并只接受匹配 ID 的响应。
- timeout 时终止本次子进程并返回 `mcp_timeout`；终止是进程生命周期控制，不删除文件。
- stdout/stderr 分别计数，超过 `max_response_bytes` 返回 `mcp_response_too_large`。
- 非零退出、非法 JSON、RPC error、协议版本不匹配都返回稳定 error code；不得把完整 stderr 或潜在敏感正文注入错误。

`lib/qmd-mcp-client.mjs` 在第一次调用时验证只读工具集合，`getExact(file)` 固定调用：

```json
{
  "name": "get",
  "arguments": {
    "file": "qmd://my-code-wiki/...",
    "fromLine": 1,
    "maxLines": 4000,
    "lineNumbers": false
  }
}
```

配置选择阶段禁止调用 `query`；文档主题搜索阶段才允许调用 `query`，且必须带 `collections`、`intent`、`rerank:false`。

**Step 7: 运行 Task 2 测试**

```bash
node --test tests/wiki-docs/host-config.test.mjs \
  tests/wiki-docs/qmd-mcp-client.test.mjs
```

Expected: PASS；所有失败均有界退出，没有文件写入。

**Step 8: 提交 transport 层**

```bash
git add skills/using-horspowers/templates/host-config.example.json \
  lib/host-config.mjs lib/mcp-stdio-client.mjs lib/qmd-mcp-client.mjs \
  tests/wiki-docs/fixtures/fake-qmd-mcp.mjs \
  tests/wiki-docs/host-config.test.mjs tests/wiki-docs/qmd-mcp-client.test.mjs
git commit -m "feat: add bounded qmd configuration transport"
```

---

### Task 3: 严格 Wiki Registry/config provider 与项目上下文

**Files:**

- Create: `lib/wiki-config-provider.mjs`
- Create: `lib/wiki-manifest.mjs`
- Create: `lib/project-context.mjs`
- Create: `tests/wiki-docs/wiki-config-provider.test.mjs`
- Create: `tests/wiki-docs/wiki-manifest.test.mjs`
- Create: `tests/wiki-docs/project-context.test.mjs`
- Modify: `lib/workflow-router.mjs:31-300`
- Modify: `tests/workflow-router/plan-apply.test.mjs`
- Modify: `tests/workflow-router/cli.test.mjs`

**Step 1: 写机器块提取与 schema 失败测试**

覆盖：合法 Registry/config/manifest、marker 缺失或重复、JSON 非法、未知字段、内容超限、fingerprint 格式错误、URI collection/root 越界、project ID/fingerprint 不一致、非 `wiki` backend、非 `inbox-only` mode，以及 `horspowers-config` manifest 条目缺失、URI/revision/hash 不一致。

**Step 2: 运行 provider 测试确认 RED**

```bash
node --test tests/wiki-docs/wiki-config-provider.test.mjs
```

Expected: FAIL，provider 不存在。

**Step 3: 实现精确 Registry → config 链路**

`lib/wiki-config-provider.mjs` 导出：

```js
export function extractMachineJson(markdown, markerName, maxBytes) {}
export function validateRegistry(value, hostConfig) {}
export function validateWikiProjectConfig(value, expected, hostConfig) {}
export async function resolveWikiProjectConfig({ identity, hostConfig, qmdClient }) {}
```

固定顺序：

1. `qmdClient.getExact(hostConfig.wiki.registry_uri)`。
2. 提取唯一 `horspowers-registry` JSON block。
3. `registry.projects[identity.project_fingerprint]` 精确查表。
4. 校验 `config_uri` 后 `getExact(config_uri)`。
5. 提取唯一 `horspowers-config` JSON block。
6. 对 Registry、identity、config 三方的 project ID/fingerprint/collection/URI root 做交叉校验。
7. `getExact(config.documentation.manifest_uri)`，由 `wiki-manifest.mjs` 严格解析固定 manifest schema。
8. 强制校验 `documents['horspowers-config']` 的 URI 等于 Registry config URI、revision 为正整数，content hash 等于刚读取的完整配置页。

任何一步失败都返回具体状态：`wiki_unavailable`、`unregistered_company_project`、`registry_invalid`、`project_config_invalid` 或 `project_config_incompatible`。不得读取仓库本地配置作为回退。

**Step 4: 写 project context 优先级失败测试**

测试矩阵：

- 公司项目 + Wiki 有效 + 仓库存在本地配置：返回 `source:'wiki'`。
- 公司项目 + Wiki 无效 + 本地配置有效：仍 fail closed，不读本地配置。
- 普通 remote：返回现有 local config。
- 无 remote / ambiguous company remote：无配置、无写入。
- `documentation.enabled:false`：backend disabled。
- Wiki backend：暴露唯一 `auto_submit` 布尔值。

**Step 5: 实现统一项目上下文**

`lib/project-context.mjs` 导出 `resolveProjectContext({cwd, homeDir, dependencies})`，稳定结果：

```json
{
  "status": "ready",
  "project": {
    "kind": "company",
    "root": "/repo",
    "project_id": "ugnas/ugcli-lib",
    "project_fingerprint": "sha256:..."
  },
  "config": { "source": "wiki", "value": {} },
  "documentation": {
    "backend": "wiki",
    "enabled": true,
    "auto_submit": true
  }
}
```

普通项目委托现有 `config-manager.js`；公司项目只委托 Wiki provider。

**Step 6: 将上下文以加法字段接入 Router**

`workflow-router.mjs` 在 project plan 已确认是 external project 后解析 context，并在输出 `project` 中增加 `identity_status`、`project_id`、`project_fingerprint`、`config_source`、`documentation_backend`、`auto_submit`。Wiki 失败不影响已完成的意图分类，但 `project.config/docs` 必须显示 external error/skipped，且 `mutations` 不包含本地 config/docs 创建。

本 Task 只增加 context 字段，必须保持 `EXTERNAL_DOCUMENT_RUNTIME_VERSION=0`、`target_skill:null` 和 `blocked_by`；Wiki 配置 ready 也不能提前解除 Task 1 的旧 Skill 安全门。

对现有 schema 1 做向后兼容的加法扩展；同步调整 exact-output 测试，不改变输入 schema。

**Step 7: 运行 provider、context、router 测试**

```bash
node --test tests/wiki-docs/wiki-config-provider.test.mjs \
  tests/wiki-docs/wiki-manifest.test.mjs \
  tests/wiki-docs/project-context.test.mjs \
  tests/workflow-router/plan-apply.test.mjs \
  tests/workflow-router/cli.test.mjs
```

Expected: PASS；本地项目行为不变，公司链路失败零仓库写入。

**Step 8: 提交配置提供者**

```bash
git add lib/wiki-config-provider.mjs lib/wiki-manifest.mjs lib/project-context.mjs \
  lib/workflow-router.mjs \
  tests/wiki-docs/wiki-config-provider.test.mjs \
  tests/wiki-docs/wiki-manifest.test.mjs \
  tests/wiki-docs/project-context.test.mjs \
  tests/workflow-router/plan-apply.test.mjs \
  tests/workflow-router/cli.test.mjs
git commit -m "feat: resolve company project configuration from wiki"
```

---

### Task 4: 建立统一 DocumentRuntime 与本地适配器

**Files:**

- Create: `lib/document-runtime.mjs`
- Create: `lib/document-runtime-cli.mjs`
- Create: `lib/document-backends/local-docs-backend.mjs`
- Create: `tests/wiki-docs/document-runtime-cli.test.mjs`
- Create: `tests/wiki-docs/local-docs-backend.test.mjs`
- Modify: `lib/docs-core.js:16-1313`

**Step 1: 写 CLI 输入契约失败测试**

使用 `spawn` 并经 stdin 输入 JSON，覆盖合法 action、未知字段、相对 cwd、超 256 KiB 输入、未知 action、空 request、stdout 单 JSON 对象、正文不进入 stderr。禁止用 argv 传用户正文。

**Step 2: 写本地 adapter 契约失败测试**

对既有本地 docs fixture 覆盖 `get/search/create/update/archive/restore/record-session`。先只断言 adapter 的统一结果形状，不改变原有命名和文档目录行为。

**Step 3: 运行测试确认 RED**

```bash
node --test tests/wiki-docs/document-runtime-cli.test.mjs \
  tests/wiki-docs/local-docs-backend.test.mjs
```

Expected: FAIL，新模块不存在。

**Step 4: 给 docs-core 增加无 CLI/路径猜测的最小 API**

在不删除现有导出和 CLI 的前提下，为 `UnifiedDocsManager` 补充统一 adapter 所需的 `getDocument()`、`updateDocument()`、`restoreDocument()`。所有目标必须经 `realpath`/`path.resolve` 验证位于当前项目 `docs/`；现有文件更新继续保持本地模式语义，但测试要证明不会越界。

不要在这一 Task 改 Skill 文本，也不要改变普通项目默认行为。

**Step 5: 实现本地 adapter 和 runtime 选择器**

`DocumentRuntime.resolve(cwd)` 先调用 `resolveProjectContext()`：

- `backend=local`：延迟构造 `LocalDocsBackend` 并委托 `docs-core.js`。
- `backend=wiki`：返回 `wiki_backend_not_implemented`，不回退 local（Task 5 实现）。
- disabled/error：返回稳定状态，不创建 docs。

`lib/document-runtime-cli.mjs` 只负责 stdin 校验、调用 runtime、输出 JSON；项目内容不得拼到 shell。

**Step 6: 运行本地兼容测试**

```bash
node --test tests/wiki-docs/document-runtime-cli.test.mjs \
  tests/wiki-docs/local-docs-backend.test.mjs \
  tests/workflow-router/docs-initializer.test.mjs
```

Expected: PASS；旧的普通项目 docs 初始化和操作结果不变。

**Step 7: 提交统一运行时骨架**

```bash
git add lib/document-runtime.mjs lib/document-runtime-cli.mjs \
  lib/document-backends/local-docs-backend.mjs lib/docs-core.js \
  tests/wiki-docs/document-runtime-cli.test.mjs \
  tests/wiki-docs/local-docs-backend.test.mjs
git commit -m "refactor: add unified document runtime"
```

---

### Task 5: Wiki 文档读取与 Inbox-only 投稿

**Files:**

- Create: `lib/document-backends/wiki-docs-backend.mjs`
- Create: `lib/inbox-submitter.mjs`
- Create: `lib/submission-safety.mjs`
- Create: `lib/source-similarity-guard.mjs`
- Create: `tests/wiki-docs/wiki-docs-backend.test.mjs`
- Create: `tests/wiki-docs/inbox-submitter.test.mjs`
- Create: `tests/wiki-docs/submission-safety.test.mjs`
- Create: `tests/wiki-docs/source-similarity-guard.test.mjs`
- Modify: `lib/document-runtime.mjs`

**Step 1: 写 manifest/read/search 失败测试**

fixture manifest 使用本计划固定的 `horspowers-manifest` JSON block；`documents` object 的 key 是唯一 logical ID，条目字段严格且只允许 `document_type/uri/revision/status/content_sha256/updated_at`。测试：

- `get` 先精确读 manifest，再按 logical ID 精确 `get` URI。
- `search` 可调用 qmd `query`，但参数必须固定 `collections:[config.collection]`、`rerank:false`、明确 `intent`。
- 搜索结果 URI 必须同时位于 `root_uri` 且能在 manifest/project scope 中验证。
- 其他 collection、其他 project root、缺失 URI、重复 logical ID 全部拒绝。

**Step 2: 写 Inbox submitter 失败测试**

注入 fake command，覆盖 create/update/archive/restore/config-change 和 `record-session` 展开的批量 mutation，断言：

- 文件名只由 timestamp + UUID submission ID 生成并满足安全 `.md` 格式。
- 子进程调用 `spawn(command, [filename], {shell:false})`。
- Markdown payload 包含唯一 `horspowers-submission` JSON block，以及 `submission_id/project_id/project_fingerprint/document_type/logical_id/operation/base_revision/proposed_revision/status`。
- payload 固定以 `# Horspowers Inbox Submission` 开头，随后是唯一 metadata block 和 `## Proposed document` 正文段；接收器添加的 Inbox frontmatter 不属于该 payload，也不能被投稿器伪造。
- submitter 把完整 UTF-8 payload 写入 child stdin，处理 backpressure/EPIPE 后只调用一次 `stdin.end()`；标题、正文和 metadata 都不进入 argv、环境变量或 stderr。
- payload 超限、命令非零、timeout、stdout/stderr 超限都返回失败。
- 失败时不写本地项目、不声称保存成功。
- `config-change` 只接受 `content_kind=project-config` 和 Task 3 的完整严格 schema；project ID/fingerprint/URI/未知字段任一错误都不投稿。还必须测试缺失 config manifest entry、entry URI/hash/revision 错误和调用方 base revision 过期；合法配置以 manifest revision 为 base，渲染唯一 `horspowers-config` machine block 并服从相同 auto-submit。
- archive/restore 只接受 `content_kind=status-transition`；测试非法状态边、URI/hash/revision/document type mismatch、正文被改、试图携带/替换正文，以及合法 transition 只生成 machine block、保持 URI/body hash。

同时为 `submission-safety.mjs` 写失败测试，覆盖未知 AST 字段/节点、任意 code/content/body 字段、超限段落/列表/spec、绝对或穿越路径、非 allowlist command/program/language/kind、shell 元字符、raw Markdown、blockquote、HTML、外部 URL、日志/diff/stack 形态、逐字长引用、PEM/private-key block、Authorization/Bearer、常见 token/API key/env assignment 和高熵字符串。合法测试必须证明设计/计划可以保留仓库相对文件、结构化命令、Expected 结果和行为完备的 implementation spec。错误只返回 pattern 类别和 AST 位置，不回显命中的原文。

`source-similarity-guard.test.mjs` 使用 Git fixture 覆盖：单个非平凡行/20 字符源码原文命中、短通用示例不误报、跟踪及未跟踪非忽略文件都扫描、ignored/二进制文件不读取、总扫描预算超限 fail closed、整个过程不修改 fixture。

**Step 3: 运行 Task 5 测试确认 RED**

```bash
node --test tests/wiki-docs/wiki-docs-backend.test.mjs \
  tests/wiki-docs/inbox-submitter.test.mjs \
  tests/wiki-docs/submission-safety.test.mjs \
  tests/wiki-docs/source-similarity-guard.test.mjs
```

Expected: FAIL，新模块不存在。

**Step 4: 实现 Wiki 只读 adapter**

`WikiDocsBackend` 构造时持有已验证项目配置、Registry-selected config URI、Task 3 的 `wiki-manifest.mjs`、qmd client 和 submitter。读取每次以已入库 manifest 为事实源，不读取 Inbox，不写缓存。`get/search` 返回内容和 revision；config-change 每次重新精确读取 manifest/config 并校验固定 config entry 后才确定 base revision。任何 qmd 失败返回 unavailable，不切换到本地 backend。

**Step 5: 实现投稿前脱敏安全门与统一投稿开关**

`lib/submission-safety.mjs` 导出 `validateAndSerializeSafeDocument(mutation.content, projectRoot)`，并在任何 preview 或 spawn 之前执行由 runtime 掌控的内容边界：

- 精确校验 `safe-document` AST key、类型、节点数量和长度；文件、命令、implementation spec 只允许本计划冻结的结构，不接受任意源码、raw source/log/diff 节点，调用方不能用 origin label 自行授权。
- 在序列化前调用 source similarity guard；只由 runtime serializer 生成标题、段落、列表、文件表、实现约束表、命令和 logical reference 链接；序列化后再次扫描私钥块、认证头、疑似 token/API key、高熵凭据、日志/diff 形态和逐字长引用。
- 任一命中返回 `submission_safety_blocked`、`raw_source_detected`、`source_scan_incomplete` 或 `safe_document_required`，不投稿，错误不得包含原始匹配值。内容必须在工作流中改写后重新提交。
- 所有公司项目、所有文档类型和所有 operation 使用同一策略；不存在 `force`、`skip_scan`、`trusted_origin` 或“已由调用方审查”的输入字段。安全失败与用户关闭 auto-submit 是两个独立状态。
- `content_kind=project-config` 走严格 config validator 与 serialized JSON secret scan，`content_kind=document` 走 safe-document validator，`content_kind=status-transition` 走 manifest/body identity validator；三个 variant 在验证后汇合到同一个 envelope/auto-submit/transport 内核，未知 kind 或错误 operation/kind 组合一律拒绝。

安全门通过后，所有 mutation 才生成 submission envelope：

- `auto_submit=true`：立即调用 submitter。
- `auto_submit=false && confirmed=false`：返回 `confirmation_required` 和脱敏 preview，不调用命令。
- `auto_submit=false && confirmed=true`：调用同一 submitter。

create/update/archive/restore/config-change 以及 `record-session` 展开的 mutation 不得各自增加第二个自动开关。`base_revision` 来自已入库 manifest；`proposed_revision = base + 1`，create 为 1。投稿成功只表示 `submitted_pending_review`，绝不表示 Wiki 已更新。

**Step 6: 把 Wiki adapter 接入 runtime**

`DocumentRuntime.resolve()` 对 `backend=wiki` 构造 `WikiDocsBackend`。所有单项 mutation 都走相同的 `mutate()` 内核，`record-session` 和以后可能出现的批处理只允许调用 `mutateBatch()`，后者逐项复用 `mutate()` 的安全门和 auto-submit 判定。

**Step 7: 运行 Wiki backend 与 runtime 测试**

```bash
node --test tests/wiki-docs/wiki-docs-backend.test.mjs \
  tests/wiki-docs/inbox-submitter.test.mjs \
  tests/wiki-docs/submission-safety.test.mjs \
  tests/wiki-docs/source-similarity-guard.test.mjs \
  tests/wiki-docs/document-runtime-cli.test.mjs
```

Expected: PASS；两个 auto-submit 值覆盖五类 mutation 及 session batch，安全失败和 transport 失败均无本地 fallback。

**Step 8: 提交 Wiki backend**

```bash
git add lib/document-backends/wiki-docs-backend.mjs \
  lib/inbox-submitter.mjs lib/submission-safety.mjs \
  lib/source-similarity-guard.mjs lib/document-runtime.mjs \
  tests/wiki-docs/wiki-docs-backend.test.mjs \
  tests/wiki-docs/inbox-submitter.test.mjs \
  tests/wiki-docs/submission-safety.test.mjs \
  tests/wiki-docs/source-similarity-guard.test.mjs \
  tests/wiki-docs/document-runtime-cli.test.mjs
git commit -m "feat: add wiki documents and inbox submissions"
```

---

### Task 6: 将 Skills 与升级入口迁移到统一文档边界

**Files:**

- Modify: `skills/brainstorming/SKILL.md`
- Modify: `skills/dispatching-parallel-agents/SKILL.md`
- Modify: `skills/document-management/SKILL.md`
- Modify: `skills/executing-plans/SKILL.md`
- Modify: `skills/finishing-a-development-branch/SKILL.md`
- Modify: `skills/requesting-code-review/SKILL.md`
- Modify: `skills/subagent-driven-development/SKILL.md`
- Modify: `skills/systematic-debugging/SKILL.md`
- Modify: `skills/test-driven-development/SKILL.md`
- Modify: `skills/writing-plans/SKILL.md`
- Modify: `skills/upgrade/SKILL.md`
- Modify: `lib/version-upgrade.js`
- Create: `skills/using-horspowers/references/document-runtime.md`
- Create: `tests/wiki-docs/skill-document-runtime-contract.test.mjs`
- Create: `tests/wiki-docs/upgrade-external-project.test.mjs`
- Modify: `tests/claude-code/test-document-review-system.sh`
- Modify: `tests/codex/test-document-review-flow.sh`

**Step 1: 写静态契约失败测试**

先扫描十个日常工作流 Skill，并对仓库全部 `skills/**/SKILL.md`、`commands/`、`hooks/` 和 `lib/` 做写入旁路审计，要求：

- 都引用 `horspowers:using-horspowers/references/document-runtime.md` 或统一 `lib/document-runtime-cli.mjs` 契约。
- 不再用 `.horspowers-config.yaml` 是否存在决定文档后端。
- 不再用 `find/cat/echo >>/mv` 直接操作 `docs/plans`、`docs/active`、`docs/archive`。
- 不再直接实例化 `DocsCore` 执行工作流文档 mutation。
- 仍保留各 Skill 的计划审查、设计审查、TDD、review 和完成门，不把流程语义抽空。
- `skills/upgrade/SKILL.md` / `lib/version-upgrade.js` 在公司项目中不能写 `.horspowers-version`、迁移/移动旧 docs 或调用本地 `docs-core`；外置迁移协议尚未设计时必须明确阻断。
- 仓库级扫描对允许写入的底层实现使用精确文件 allowlist（本地 adapter、Inbox submitter、既有 config/docs core），不允许仅因新增目录或改名就自动放行。

**Step 2: 运行静态测试确认 RED**

```bash
node --test tests/wiki-docs/skill-document-runtime-contract.test.mjs
```

Expected: FAIL，并列出当前十个 Skill 以及 upgrade/version-upgrade 的硬编码或直接写入位置。

**Step 3: 编写共享调用参考**

`document-runtime.md` 固定说明：如何解析 Horspowers 安装根、如何用 JSON stdin 调用 `resolve/get/search/create/update/archive/restore/config-change/record-session`、如何构造 safe-document/implementation spec，以及如何处理 `confirmation_required`、`safe_document_required`、`submitted_pending_review`、`partially_submitted`、`submission_safety_blocked` 和 unavailable。提供 shell 安全示例时，用户正文必须来自 stdin/临时结构化输入，不能进入 argv 或命令字符串。

**Step 4: 分两批迁移读取型 Skill**

先迁移：

1. `executing-plans`
2. `requesting-code-review`
3. `dispatching-parallel-agents`
4. `subagent-driven-development`

把“查最近任务/计划/设计”的 `find/cat` 改成 runtime `search/get`。每迁移一个 Skill 就运行静态契约测试和对应现有 Skill smoke。

**Step 5: 分两批迁移写入型 Skill**

再迁移：

1. `brainstorming`
2. `writing-plans`
3. `systematic-debugging`
4. `test-driven-development`
5. `finishing-a-development-branch`
6. `document-management`

所有 create/update/archive/restore 都调用 runtime。Wiki backend 返回 `submitted_pending_review` 时，Skill 必须明确告诉用户“已投稿、待本机入库”；`confirmation_required` 时只问一次确认；unavailable 时保留会话内容并报告未持久化。

`writing-plans` 和 `brainstorming` 在 Wiki backend 下必须把可执行技术细节映射为 safe-document：文件路径放 `files`，命令与 Expected 放 `commands`，symbol/输入输出/规则/错误放 `implementation_specs`。不得为了保留旧模板而把完整源码、diff 或自由 Markdown 塞进 paragraph；普通 local backend 继续保留现有完整代码片段模板。

**Step 6: 封住升级流程的公司项目写入旁路**

`version-upgrade.js` 在任何 marker、目录、配置读写或迁移计划前调用只读 project identity/context：

- 公司项目返回 `external_project_upgrade_disabled`，不写 `.horspowers-version`，不移动/复制/改写旧文档，也不调用本地 config/docs migration。
- ambiguous/no-remote 返回明确的 no-mutation 状态。
- 普通项目保留现有升级行为。

`upgrade/SKILL.md` 消费该状态并提示用户先完成外置配置注册；SessionStart 在 Task 7 也要使用同一 context，避免对公司项目继续注入“运行 /upgrade”的本地迁移提示。`upgrade-external-project.test.mjs` 对每种公司 URL 和存在旧目录/旧 marker 的 fixture 比较前后 tree snapshot。

**Step 7: 保持文档审查门**

更新 Codex/Claude 文档审查测试，让计划或设计的 backend 可以是 local path 或 Wiki logical ID/URI；无论 backend 是什么，reviewer 都必须拿到完整设计与计划正文，blocking issue 修复后重新审查。

**Step 8: 运行 Skill、升级契约和定向 smoke**

```bash
node --test tests/wiki-docs/skill-document-runtime-contract.test.mjs
node --test tests/wiki-docs/upgrade-external-project.test.mjs
bash tests/codex/test-document-review-flow.sh
bash tests/claude-code/test-document-review-system.sh
```

Expected: PASS；如果本机缺少 `timeout` 或 Claude CLI，记录未运行原因，不以伪造输出替代。

**Step 9: 提交 Skill 与升级入口迁移**

```bash
git add skills/brainstorming/SKILL.md \
  skills/dispatching-parallel-agents/SKILL.md \
  skills/document-management/SKILL.md \
  skills/executing-plans/SKILL.md \
  skills/finishing-a-development-branch/SKILL.md \
  skills/requesting-code-review/SKILL.md \
  skills/subagent-driven-development/SKILL.md \
  skills/systematic-debugging/SKILL.md \
  skills/test-driven-development/SKILL.md \
  skills/writing-plans/SKILL.md \
  skills/upgrade/SKILL.md lib/version-upgrade.js \
  skills/using-horspowers/references/document-runtime.md \
  tests/wiki-docs/skill-document-runtime-contract.test.mjs \
  tests/wiki-docs/upgrade-external-project.test.mjs \
  tests/claude-code/test-document-review-system.sh \
  tests/codex/test-document-review-flow.sh
git commit -m "refactor: route skill documents through shared runtime"
```

---

### Task 7: 迁移 Session Hooks，消除公司项目直接写盘

**Files:**

- Modify: `hooks/session-start.sh:1-100`
- Modify: `hooks/session-end.sh:1-220`
- Modify: `lib/document-runtime-capabilities.mjs`
- Modify: `tests/workflow-router/plan-apply.test.mjs`
- Modify: `tests/workflow-router/cli.test.mjs`
- Create: `tests/wiki-docs/session-hooks.test.mjs`

**Step 1: 写 hook 失败测试**

以 fake runtime CLI 驱动 hooks，覆盖：

- SessionStart 对公司项目输出 `config-source=wiki` / backend 状态，不把缺少本地配置报告成 `needs-init`。
- SessionEnd 的 session record、task/bug progress、auto archive 都走 runtime。
- Wiki `record-session` 从 manifest revision 展开独立 session/update/archive mutation；`auto_submit=false` 对整批只提示一次，确认后逐项投稿，partial failure 返回可重试清单。
- Hook 没有传递 runtime log/source 原文的字段；只传结构化时间、分支、opaque session ID 和 logical refs，由 runtime 生成可校验的 safe-document。
- Wiki unavailable、未注册、auto-submit 失败时，公司项目树快照保持不变。
- 普通项目继续更新本地 session metadata 和活动文档。
- hook 输出始终为合法 JSON，不把 Wiki 文档正文或敏感 stderr 放进 additionalContext。
- Router capability=0 时继续阻断旧 Skill；capability=1 时，无论 Wiki ready 还是 unavailable 都恢复已迁移 target Skill，后者只把文档状态标记为未持久化。

**Step 2: 运行 hook 测试确认 RED**

```bash
node --test tests/wiki-docs/session-hooks.test.mjs
```

Expected: FAIL，现有 hooks 仍直接查找本地配置/docs。

**Step 3: 迁移 SessionStart**

保留 legacy upgrade 检查与 skill 注入，只把 config status 解析替换成 runtime `resolve`。公司项目状态使用 `wiki-ready/wiki-unavailable/unregistered/ambiguous`，不出现 `needs-init`。

**Step 4: 迁移 SessionEnd**

删除流程上的本地路径遍历逻辑（不删除历史文件），改为向 runtime 提交固定 schema 的 `record-session` 请求。runtime 从 manifest/本地索引读取 `document_refs` 的当前 revision 和 status，生成一个 session mutation、每个引用文档的 update mutation，并在 `auto_archive_completed=true` 时为 status=completed 的引用生成 archive mutation；全部交给 Task 5 的 `mutateBatch()`。公司项目禁止执行 `mkdir docs`、`echo >> task`、`find docs/active` 或直接调用 `docs-core archive`。

**Step 5: 完成迁移后启用 external runtime capability**

只有本 Task 的 Hook 测试和 Task 6 的仓库级旁路扫描都通过后，才把 `EXTERNAL_DOCUMENT_RUNTIME_VERSION` 从 0 改为 1。Router 使用依赖注入覆盖 capability 的测试必须同时证明：

- version 0：公司项目 planning/brainstorming 的 `target_skill` 为空。
- version 1 + Wiki ready：恢复分类得到的唯一 target Skill。
- version 1 + Wiki unavailable/unregistered：仍恢复已安全迁移的代码工作流 target Skill，但 `documentation_backend/status` 明确 unavailable，任何持久化请求 fail closed。
- 普通项目不受 capability 影响。

**Step 6: 运行 hook、Router 生命周期与本地回归测试**

```bash
node --test tests/wiki-docs/session-hooks.test.mjs \
  tests/wiki-docs/document-runtime-cli.test.mjs \
  tests/workflow-router/*.test.mjs
```

Expected: PASS；公司失败路径零写入，普通项目行为保持兼容。

**Step 7: 提交 Hook 迁移并开启 capability**

```bash
git add hooks/session-start.sh hooks/session-end.sh \
  lib/document-runtime-capabilities.mjs \
  tests/wiki-docs/session-hooks.test.mjs \
  tests/workflow-router/plan-apply.test.mjs \
  tests/workflow-router/cli.test.mjs
git commit -m "refactor: route session documentation through runtime"
```

---

### Task 8: 端到端验收、使用文档与发布记录

**Files:**

- Create: `tests/wiki-docs/end-to-end.test.mjs`
- Create: `docs/wiki-external-documentation.md`
- Modify: `docs/README.codex.md`
- Modify: `RELEASE-NOTES.md`
- Review: `docs/plans/2026-08-10-company-project-wiki-external-docs.md`

**Step 1: 建立全链路 fake fixture**

fixture 包含：公司 Git remote、fake host config、fake qmd MCP Registry/config/manifest/docs、fake Inbox receiver，以及普通 Git 项目对照组。每个场景都记录运行前后 tree snapshot，不主动删除 artifacts。

**Step 2: 写并运行完整验收矩阵**

```bash
node --test tests/wiki-docs/*.test.mjs
node --test tests/workflow-router/*.test.mjs
```

必须覆盖并通过：

1. 域名/IP、SSH/HTTPS/scp-style 同仓库同 fingerprint。
2. host 后缀伪装不命中。
3. Wiki 配置覆盖残留本地配置。
4. Registry 不可用、未注册、配置无效、身份歧义全部零仓库新增。
5. create/update/archive/restore/config-change 全部服从唯一 auto-submit 开关。
6. record-session 展开的 update/archive/session mutation 服从同一开关，partial failure 可辨认且不虚报整批成功。
7. config-change 使用严格 project-config variant，错误不投稿，合法修订服从同一 revision/Inbox/auto-submit 流程。
8. archive/restore 使用 status-transition，保持 URI/body hash，仅改变 manifest 状态和 revision。
9. 私钥/token/认证头、源码原文/日志/diff/raw Markdown、绝对路径/外部 URL 和未建模正文都不能因 auto-submit 绕过 safe-document 边界；验证通过的 structured document 严格服从唯一全局开关。
10. 投稿只通过 stdin 新增 Inbox revision；失败无本地 docs fallback。
11. 未入库内容不能被新 session 的 manifest/get 恢复。
12. fake Inbox 完成“人工入库并更新 fake manifest”后，新 session 能读取新 revision。
13. upgrade/version-upgrade 在公司项目中不创建 marker、不迁移旧 docs，普通项目升级行为不变。
14. 普通项目本地配置、docs、Skill 和 Hook 行为不变。

**Step 3: 跳板机只读 smoke**

在确认 host config 已人工安装后运行：

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"horspowers-smoke","version":"1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | ssh -T -o BatchMode=yes localwiki
```

Expected: qmd 2.5.3 或兼容版本成功 initialize，工具集合不含写工具。然后用测试项目调用 runtime `resolve/get`，只验证已注册测试项目；不要对真实公司 Wiki 内容做投稿 smoke，除非用户明确批准该次投稿。

**Step 4: 编写运维文档**

`docs/wiki-external-documentation.md` 说明：

- 公司 host 判定和 fingerprint 计算。
- host bootstrap 安装位置与示例。
- Registry/config/manifest 固定机器块。
- auto-submit 两种行为。
- `submitted_pending_review` 与“已入库”的区别。
- Wiki/SSH/qmd/Inbox 故障状态及无本地 fallback。
- 本机人工入库和 `qmd update` 仍由用户负责。

同步更新 Codex README 和 release notes，不包含真实 token、私钥、公司文档正文或本机敏感配置。

**Step 5: 运行适用的项目级验证**

先运行无删除副作用的定向 suite：

```bash
git diff --check
node --test tests/wiki-docs/*.test.mjs
node --test tests/workflow-router/*.test.mjs
bash tests/codex/test-document-review-flow.sh
```

仓库部分 legacy/full integration runner 可能清理临时目录。执行任何包含 `rm`、cleanup 或自动移除 fixture 的 suite 前，先展示其精确删除目标并取得用户明确授权；未授权时跳过，并在 PR 中记录剩余风险。

**Step 6: 对照规格做计划/实现审查**

按 `skills/writing-plans/plan-document-reviewer-prompt.md` 逐项核对本计划与 Wiki 决策；实现完成后再按 `horspowers:requesting-code-review` 检查：

- 是否有公司项目本地写入旁路。
- 是否有 Skill/Hook 绕过 runtime。
- 是否把语义 query 用于 Registry/config 选择。
- 是否有任意 shell、路径、覆盖或直接 Wiki 写能力。
- 是否错误宣称待审核投稿已经入库。

**Step 7: 提交验收和文档**

```bash
git add tests/wiki-docs/end-to-end.test.mjs \
  docs/wiki-external-documentation.md docs/README.codex.md \
  RELEASE-NOTES.md \
  docs/plans/2026-08-10-company-project-wiki-external-docs.md
git commit -m "docs: document wiki external project workflow"
```

---

## 验收标准

| 要求 | 验证入口 |
|---|---|
| 公司项目识别稳定且防 host 欺骗 | `project-identity.test.mjs` |
| 公司项目初始化前 fail closed | `project-initializer.test.mjs`、tree snapshot |
| Registry/config 只做精确 get | `qmd-mcp-client.test.mjs`、`wiki-config-provider.test.mjs` |
| Wiki 配置优先于残留本地配置 | `project-context.test.mjs` |
| 所有文档操作共用单一 auto-submit | `wiki-docs-backend.test.mjs` |
| 私钥、token、原始代码/日志和未建模正文不能自动投稿 | `submission-safety.test.mjs`、`source-similarity-guard.test.mjs` |
| Inbox 投稿无 shell/覆盖/路径注入 | `inbox-submitter.test.mjs` |
| Skills/commands/hooks/lib 无未授权本地路径旁路 | `skill-document-runtime-contract.test.mjs` |
| 升级入口不修改公司项目 | `upgrade-external-project.test.mjs` |
| Session hooks 不直接写公司项目 | `session-hooks.test.mjs` |
| 普通项目默认行为不变 | workflow-router + local backend 回归 |
| 待审核与已入库状态严格区分 | `end-to-end.test.mjs` |

## 建议实施顺序

先只实施并评审 Task 1，形成安全止血 PR；它无需等待 Wiki Registry 和投稿协议即可阻止公司仓库污染。Task 1 合并后再按 Task 2–5 建立完整运行时，最后执行 Task 6–7 的 Skill/Hook 迁移。不要先逐个修改 Skill，否则相同的公司判断、配置优先级和 auto-submit 逻辑会被复制到多个 Markdown 工作流中，后续难以证明不存在旁路。
