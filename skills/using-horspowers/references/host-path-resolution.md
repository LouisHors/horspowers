# HPS 与兼容路由路径解析

只使用宿主已知的 native skill 根目录；执行前验证路径是普通可读文件并解析其真实路径。不得根据仓库名扫描用户目录。

| 宿主 | 首选 HPS 路径 | 兼容回退路径 |
|---|---|---|
| Claude Code | `${CLAUDE_PLUGIN_ROOT}/bin/hps` | `${CLAUDE_PLUGIN_ROOT}/skills/using-horspowers/scripts/route-request.mjs` |
| Codex macOS/Linux | native discovery installation root + `/bin/hps` | native discovery installation root + `/skills/using-horspowers/scripts/route-request.mjs` |
| Codex Windows PowerShell | native discovery installation root + `\\bin\\hps` | native discovery installation root + `\\skills\\using-horspowers\\scripts\\route-request.mjs` |

Codex 的 symlink、junction 和复制安装都以 native discovery 目录为入口。HPS installation root 必须来自 native discovery，且执行前验证 `<root>/bin/hps` 是普通可执行文件；不得扫描或猜测用户目录。未知宿主若无法从 native metadata 解析路径，跳过脚本，回退 LLM 路由，且不做任何初始化写入。

所有示例都把宿主安全序列化的 JSON 放入 stdin；绝不把用户消息插入 command string。

```bash
# Claude Code（首选）
printf '%s' "$HORSPOWERS_ROUTER_INPUT" | \
  "${CLAUDE_PLUGIN_ROOT}/bin/hps" call

# Codex macOS/Linux（首选；HPS_INSTALL_ROOT 来自 native discovery）
printf '%s' "$HORSPOWERS_ROUTER_INPUT" | \
  "$HPS_INSTALL_ROOT/bin/hps" call

# 无 HPS 时才使用兼容回退
printf '%s' "$HORSPOWERS_ROUTER_INPUT" | \
  node "$HPS_INSTALL_ROOT/skills/using-horspowers/scripts/route-request.mjs"
```

```powershell
# Codex Windows PowerShell（首选）
$env:HORSPOWERS_ROUTER_INPUT |
  "$env:HPS_INSTALL_ROOT\bin\hps" call
```
