# 公司项目的 Wiki 外置配置与文档

## 适用范围

Horspowers 对已确认的公司 Git 项目使用 Wiki 作为配置和已入库文档的事实源；普通 Git 项目继续使用原有的项目内 `.horspowers-config.yaml` 与本地 `docs/` 行为。

这套模式的首要保证是 fail closed：公司项目的 Registry、配置、manifest、qmd、SSH 或 Inbox 链路无法安全验证时，运行时不会创建或修改项目内配置、Horspowers `docs/`，也不会切回本地文档后端。代码协作可以继续，但文档内容只保留在当前会话中。

## 公司项目识别与项目指纹

运行时只读获取 Git 的 `remote.<name>.url`。受信任主机是内置精确允许列表中的 `gitlab.ugnas.com` 与 `192.168.75.113`，两者都会归一为 `ugnas-gitlab`。支持常见的 scp-style、SSH 和 HTTPS clone URL。命中可信主机后，还必须确认项目根不在本机路径下：macOS/Windows 默认把当前用户目录视为本机项目根，Linux 跳板机默认不声明本机根。可用 `HORSPOWERS_LOCAL_PROJECT_ROOTS`（按系统路径分隔符分隔）显式覆盖；设置为空字符串可关闭默认值。可信 remote 与本机路径同时命中时按普通本地项目处理，不进入公司 Wiki 外置模式。

匹配的是解析后的完整 host，而不是目录名、项目名、DNS、网页正文或字符串前缀。因此 `gitlab.ugnas.com.evil.example` 与 `192.168.75.113.example` 都不是公司项目。路径比较按真实目录边界进行，`/code/app` 不会把 `/code/app-copy` 当作本机项目。多个无法唯一选择的公司 remote 会得到 `ambiguous_company_remote`，不会选择配置或写入项目。

同一仓库的 fingerprint 按以下规则计算：

```text
canonical_repository = "ugnas-gitlab/" + normalized_repository_path
project_fingerprint = "sha256:" + SHA-256(canonical_repository)
```

例如同一仓库通过域名/IP、SSH/HTTPS 或 scp-style clone 得到相同 fingerprint。路径会去除一个末尾 `.git`，保留 subgroup；host 转小写并移除末尾的 DNS 点。

## 宿主 bootstrap

宿主配置只从 `~/.config/horspowers/host.json` 读取，运行时绝不自动创建该文件。请由本机管理员或用户手动安装；下面是使用占位路径的最小示例，不应把 token、私钥、真实用户目录或内部文档正文放入此文件。

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
      "command": "/absolute/path/to/wiki-inbox-submit",
      "timeout_ms": 20000,
      "max_payload_bytes": 262144
    }
  }
}
```

其中 transport 只能是 `ssh-stdio-mcp`；`ssh_alias` 只能是安全别名；Inbox command 必须是绝对路径。提交器只接收一个安全文件名参数并从 stdin 接收 payload，不接受目标路径、覆盖选项、shell 命令或 qmd 更新参数。

## Registry、项目配置与 manifest

公司项目按固定顺序工作：精确读取 Registry → 用完整 fingerprint 精确查表 → 精确读取项目配置 → 精确读取 manifest。配置选择绝不能使用 qmd 语义搜索；主题检索只能在已验证的 collection、project root 和 manifest 范围内进行。

以下机器块是协议的一部分。示例中的 project ID、fingerprint、URI 和 hash 都是文档占位值。

### 固定 Registry

````markdown
<!-- horspowers-registry:start -->
```json
{
  "schema_version": 1,
  "projects": {
    "sha256:0000000000000000000000000000000000000000000000000000000000000000": {
      "project_id": "example/company-project",
      "config_uri": "qmd://my-code-wiki/projects/example-company/horspowers-config.md"
    }
  }
}
```
<!-- horspowers-registry:end -->
````

Registry 以完整 `project_fingerprint` 为唯一键；页面路径、显示名和搜索排序都不能参与配置选择。

### 项目配置

````markdown
<!-- horspowers-config:start -->
```json
{
  "schema_version": 1,
  "project_id": "example/company-project",
  "project_fingerprint": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  "development_mode": "team",
  "branch_strategy": "worktree",
  "testing_strategy": "tdd",
  "completion_strategy": "pr",
  "documentation": {
    "enabled": true,
    "backend": "wiki",
    "collection": "my-code-wiki",
    "root_uri": "qmd://my-code-wiki/projects/example-company",
    "manifest_uri": "qmd://my-code-wiki/projects/example-company/index.md",
    "submission": {
      "mode": "inbox-only",
      "auto_submit": true
    }
  }
}
```
<!-- horspowers-config:end -->
````

当公司项目成功命中该配置时，它优先于任何残留的项目内 `.horspowers-config.yaml`。残留文件保持原样，既不会被读取为覆盖，也不会被删除、移动或改写。

### 文档 manifest

````markdown
<!-- horspowers-manifest:start -->
```json
{
  "schema_version": 1,
  "project_id": "example/company-project",
  "project_fingerprint": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  "documents": {
    "horspowers-config": {
      "document_type": "config",
      "uri": "qmd://my-code-wiki/projects/example-company/horspowers-config.md",
      "revision": 1,
      "status": "active",
      "content_sha256": "0000000000000000000000000000000000000000000000000000000000000000",
      "updated_at": "2026-08-10T00:00:00Z"
    },
    "example-task": {
      "document_type": "task",
      "uri": "qmd://my-code-wiki/projects/example-company/tasks/example-task.md",
      "revision": 2,
      "status": "active",
      "content_sha256": "0000000000000000000000000000000000000000000000000000000000000000",
      "updated_at": "2026-08-10T00:00:00Z"
    }
  }
}
```
<!-- horspowers-manifest:end -->
````

`horspowers-config` 是固定逻辑 ID。它的 URI、hash 和 revision 必须与 Registry 选中的配置页一致；不一致会返回 `config_manifest_mismatch` 并停止读取和配置变更。每个普通文档也必须同时位于指定 collection 和 `root_uri` 下，正文 hash 必须与 manifest 匹配。

## 运行时、读写与会话

工作流先通过文档运行时执行 `resolve`，只有结果为 `ready` 才继续 `get`、`search`、`create`、`update`、`archive`、`restore`、`config-change` 或 `record-session`。CLI 只接受一份 JSON stdin，不应把标题、正文、查询词或路径拼进 shell 参数。完整请求与 safe-document 契约见 [统一文档运行时调用参考](../skills/using-horspowers/references/document-runtime.md)。

Wiki 的写入只会生成一个新的 Inbox revision。`record-session` 是同一 mutation 内核的批处理：它会将会话记录、已引用文档的进度更新和符合条件的归档统一展开；它不是本地路径或直接 Wiki 写的旁路。

`archive` 和 `restore` 是 metadata-only 的 `status-transition`。它们保持原 URI 与正文 hash，不移动、复制或删除正文，只提议更新 manifest 的 status、revision 和更新时间。

## 唯一 auto-submit 开关

`documentation.submission.auto_submit` 是所有 Wiki 文档写入的唯一开关：

| 值 | 行为 |
| --- | --- |
| `true` | 内容通过严格安全校验后，自动向 Inbox 投稿一个新 revision。 |
| `false` | 运行时返回 `confirmation_required`；使用同一结构化请求并设置确认后才投稿。 |

该开关统一覆盖 create、update、archive、restore、config-change 及 record-session 展开的所有 mutation。不存在按文档类型的第二个自动开关、`force`、`skip_scan` 或直接 Wiki 写入选项。

`config-change` 使用严格的 `project-config` variant，必须再次绑定当前 identity、Registry project ID、collection 和 root URI。协议结构先做字段级绑定校验；project ID 与所有非结构化内容仍经过凭据和高熵 token 检查，私钥、认证头或未建模内容一律拒绝。

## 投稿、入库与可见性

`submitted_pending_review` 的准确含义是“已投稿、待本机入库”。它不是“已保存”或“已入库”：待审核 Inbox 文件不是 qmd 可检索事实，新的会话不能从它恢复文档，也不存在跳板机草稿缓存。

用户在本机负责以下步骤：

1. 审核 Inbox revision。
2. 按 Wiki 的原生流程将其入库；配置变更时，同一次操作更新配置页和 manifest 的 revision/hash/time。
3. 更新相关导航或索引，并在本机运行 `qmd update`。
4. 保留 Inbox 原件，后续会话再从更新后的 manifest 和 qmd 索引读取新 revision。

一次批量投稿可能返回 `partially_submitted`。此时应检查成功和失败的 submission ID，只重试失败项目；不可把整批描述为已保存，也不要回滚已生成的 Inbox 原件。

## 故障与安全边界

| 状态 | 含义与处理 |
| --- | --- |
| `wiki_unavailable` | host、SSH、qmd 或精确读取不可用；不创建本地配置或 docs。 |
| `unregistered_company_project` | Registry 没有该 fingerprint；先由本机管理员建立受审阅的登记。 |
| `registry_invalid`、`project_config_invalid`、`project_config_incompatible` | 机器块或绑定校验失败；修复外置事实后重试，不能使用残留本地配置。 |
| `config_manifest_mismatch` | config 页与 manifest 的 URI/hash/revision 不一致；先在本机原子地修复两者。 |
| `confirmation_required` | `auto_submit` 关闭；只对同一结构化请求确认一次。 |
| `submission_failed` | Inbox transport 失败；不会产生 local docs fallback，也不能宣称成功。 |
| `partially_submitted` | 批次部分成功；分别处理成功和失败项。 |
| `safe_document_required`、`submission_safety_blocked` | 将内容重写为结构化摘要、文件引用、命令和行为约束。 |
| `raw_source_detected`、`source_scan_incomplete` | 不投稿；去除可复制源码或在本机恢复完整扫描后重试。 |

自动投稿拒绝凭据、私钥、token、认证头、源码原文、日志、diff、堆栈、raw Markdown、绝对路径、外部 URL 和其他未建模正文。提交器不具备任意路径、覆盖、shell 或直接 Wiki/qmd 写入能力。Hook 也不应把 runtime stderr、文档正文或敏感来源写入 additional context。

## 仅人工执行的只读 smoke

只有在 host bootstrap 已由人工安装、并且不投稿任何真实内容时，才可以手动验证只读 MCP 握手：

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"horspowers-smoke","version":"manual"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | ssh -T -o BatchMode=yes localwiki
```

预期是 MCP 成功初始化且工具集合不含写工具。随后只可对已注册的测试项目运行 runtime `resolve/get`。Horspowers 不会自动运行这条命令；不要在真实公司 Wiki 上做投稿 smoke，除非该次投稿获得用户明确批准。
