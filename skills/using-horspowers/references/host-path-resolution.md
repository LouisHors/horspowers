# HPS 与兼容路由路径解析

只使用宿主已知的 native skill 根目录；执行前验证路径是普通可读文件并解析其真实路径。不得根据仓库名扫描用户目录。

| 宿主 | 首选 HPS 路径 | 兼容回退路径 |
|---|---|---|
| Claude Code | `${CLAUDE_PLUGIN_ROOT}/bin/hps` | `${CLAUDE_PLUGIN_ROOT}/skills/using-horspowers/scripts/route-request.mjs` |
| Codex macOS/Linux | native discovery installation root + `/bin/hps` | native discovery installation root + `/skills/using-horspowers/scripts/route-request.mjs` |
| Codex Windows PowerShell | native discovery installation root + `\\bin\\hps` | native discovery installation root + `\\skills\\using-horspowers\\scripts\\route-request.mjs` |
| Pi | 发现到的 `skills/using-horspowers` 所属安装根（`~/.agents/skills/horspowers` 或 package 目录）+ `/bin/hps` | 同一安装根 + `/skills/using-horspowers/scripts/route-request.mjs` |

Pi 在 system prompt 中给出每个 skill 的绝对路径，因此安装根由该路径向上解析（`<skill dir>/../..`），不扫描用户目录。pi 的 MCP 注册走 `pi mcp add hps -- <root>/bin/hps serve --stdio`（写入用户级 `~/.pi/agent/mcp.json`）或项目 `.pi/mcp.json`；native probe 使用临时的 `PI_CODING_AGENT_DIR`，不得改写用户级配置。

Codex 的 symlink、junction 和复制安装都以 native discovery 目录为入口。HPS installation root 必须来自 native discovery，且执行前验证 `<root>/bin/hps` 是普通可执行文件；不得扫描或猜测用户目录。未知宿主若无法从 native metadata 解析路径，跳过脚本，回退 LLM 路由，且不做任何初始化写入。

所有示例都把宿主安全序列化的 JSON 放入 stdin；绝不把用户消息插入 command string。

**两个入口的 stdin 形状不同**（完整定义见 `hps` SKILL.md 的「安全输入契约」）：

- `hps call` 要 **canonical envelope**：`{schema_version, request_id, operation, cwd, input:{host, message, active_route}}` —— 用下面的 `HPS_CALL_REQUEST`。
- legacy `route-request.mjs` 要 **扁平对象**：`{schema_version, host, cwd, message, active_route}` —— 用下面的 `HORSPOWERS_ROUTER_INPUT`。

把扁平对象喂给 `hps call` 只会得到 `invalid_request`；那是形状用错，不是 HPS 不可用。

```bash
# Claude Code（首选）
printf '%s' "$HPS_CALL_REQUEST" | \
  "${CLAUDE_PLUGIN_ROOT}/bin/hps" call

# Codex macOS/Linux（首选；HPS_INSTALL_ROOT 来自 native discovery）
printf '%s' "$HPS_CALL_REQUEST" | \
  "$HPS_INSTALL_ROOT/bin/hps" call

# 无 HPS 时才使用兼容回退（注意它要的是扁平对象）
printf '%s' "$HORSPOWERS_ROUTER_INPUT" | \
  node "$HPS_INSTALL_ROOT/skills/using-horspowers/scripts/route-request.mjs"
```

```powershell
# Codex Windows PowerShell（首选）
$env:HPS_CALL_REQUEST |
  "$env:HPS_INSTALL_ROOT\bin\hps" call
```

```bash
# Pi（首选；HPS_INSTALL_ROOT 来自 skill discovery 给出的 skill 路径）
printf '%s' "$HPS_CALL_REQUEST" | \
  "$HPS_INSTALL_ROOT/bin/hps" call
```
