# 统一文档运行时调用参考

所有 Horspowers 工作流文档都必须通过统一文档运行时读取或变更。工作流不得根据项目中的配置文件、目录是否存在或文件名来猜测文档后端；先调用 `resolve`，再按返回的 backend 与状态继续。

## 解析安装根与 CLI

只使用宿主已知的 native skill discovery 路径，不能按仓库名扫描用户目录：

- Claude Code：`CLAUDE_PLUGIN_ROOT` 是安装根；CLI 位于 `lib/document-runtime-cli.mjs`。
- Codex：从原生发现的 `horspowers` skills 根解析真实路径。该根是 `<installation-root>/skills`，其父目录才是安装根；CLI 位于 `<installation-root>/lib/document-runtime-cli.mjs`。
- 未能从宿主元数据解析时，不猜测路径、不写文档；保留本会话内容并说明运行时不可用。

CLI 只接受一份 JSON stdin，不能接受 argv 参数。宿主先把结构化请求写入受控临时输入，再把它送入 CLI：

```bash
# HORSPOWERS_DOCUMENT_RUNTIME_CLI 与 HORSPOWERS_DOCUMENT_REQUEST_FILE
# 由宿主安全解析；请求正文已被 JSON 序列化到该受控输入文件。
node "$HORSPOWERS_DOCUMENT_RUNTIME_CLI" < "$HORSPOWERS_DOCUMENT_REQUEST_FILE"
```

绝不把用户正文、计划正文、错误输出或代码片段放进 argv、命令字符串、`node -e` 源码或 shell 插值。需要交互时，重新生成一份 JSON stdin；不要用 shell 拼接用户文本。

## 请求信封

每次请求使用下列信封，`cwd` 必须为绝对项目路径，`request` 必须是对象：

```json
{
  "schema_version": 1,
  "cwd": "/absolute/project/path",
  "action": "resolve",
  "request": {},
  "confirmed": false
}
```

允许的 `action` 为：

- `resolve`：只解析 backend、项目 ID 与可用性，不创建目录或文档。
- `get`：按稳定 logical ID 或本地运行时返回的路径读取完整文档。
- `search`：按简短查询和意图查找候选文档；Wiki 结果必须仍受配置 manifest 范围约束。
- `create`：创建一个文档；Wiki 使用 Inbox-only 投稿。
- `update`：更新已知文档；Wiki 需要 logical ID 与当前 revision。
- `archive`：归档已完成文档；Wiki 是状态变更投稿。
- `restore`：恢复已归档文档；Wiki 是状态变更投稿。
- `config-change`：请求配置变更；它也是受审阅的投稿，不直接改项目配置。
- `record-session`：记录会话及文档引用；可附带已完成文档的归档请求。

先以 `resolve` 判定状态。若 `status` 为 `ready`，再调用下一动作；若返回 disabled、unavailable、未注册或身份歧义，绝不回退写项目目录。

## 可安全投稿的文档内容

local backend 可保留完整 Markdown、代码片段和既有模板。Wiki backend 的 `create` / `update` 必须使用 `content_kind: "document"` 及严格的 `safe-document`：

```json
{
  "document_type": "plan",
  "logical_id": "runtime-boundary-plan",
  "base_revision": 0,
  "content_kind": "document",
  "content": {
    "schema_version": 1,
    "format": "safe-document",
    "title": "Runtime boundary plan",
    "sections": [
      {
        "heading": "Implementation",
        "paragraphs": ["Describe the decision in concise original prose."],
        "bullets": ["Keep the backend selection fail closed."],
        "files": [{"operation": "modify", "path": "lib/document-runtime.mjs"}],
        "implementation_specs": [{
          "kind": "module",
          "language": "javascript",
          "symbol": "DocumentRuntime",
          "inputs": ["absolute cwd and action request"],
          "outputs": ["one backend result envelope"],
          "rules": ["do not create local documents after external resolution fails"],
          "errors": ["return an unavailable status without fallback writes"]
        }],
        "commands": [{"program": "node", "args": ["--test", "tests/wiki-docs/document-runtime-cli.test.mjs"], "expected": "PASS"}]
      }
    ],
    "references": []
  }
}
```

技术细节的映射规则固定如下：

- 受影响路径放入 `files`，并使用 `create`、`modify`、`test` 或 `review` 操作。
- 验证命令与 Expected 放入 `commands`；命令参数必须是安全、相对且不含 shell 元字符的 token。
- symbol、输入、输出、规则和错误边界放入 `implementation_specs`。
- `paragraphs` 只放简洁、原创的说明；不得放完整源码、diff、日志、自由 Markdown、凭据或长段原文。

设计和计划工作流必须在 Wiki backend 按上述结构表达技术信息；不要把 local backend 的完整代码模板压缩为不安全的 paragraph。

## 结果处理

| 状态 | 处理 |
| --- | --- |
| `confirmation_required` | 展示运行时给出的预览，只问用户一次是否投稿；用户确认后以同一结构化请求重试并将 `confirmed` 设为 true。不要重复询问。 |
| `safe_document_required` | 不投稿。将内容重构为 safe-document 的 files、commands、implementation_specs 和短 prose，再重试。 |
| `submitted_pending_review` | 明确说明“已投稿、待本机入库”；它不是已入库、不可在新会话当作已读取事实。保留本会话内容。 |
| `partially_submitted` | 报告每个成功投稿和失败项；只重试失败项，不把整体说成已保存。 |
| `submission_safety_blocked` | 不回显被拒绝正文；去除源码、diff、凭据、日志或其他不安全内容后重新构造请求。 |
| `unavailable` 或任何非 ready 的可用性状态 | 继续代码协作时把文档内容保留在会话中，准确说明未持久化；绝不创建本地替代文档或配置。 |

其他失败状态也应保留内容并报告状态与安全的错误码，而不是臆测成功。任何 Inbox 投稿在本机审核、入库并刷新索引前都只是 `submitted_pending_review`。
