# 路由脚本路径解析

只使用宿主已知的 native skill 根目录；执行前验证路径是普通可读文件并解析其真实路径。不得根据仓库名扫描用户目录。

| 宿主 | 唯一脚本路径 |
|---|---|
| Claude Code | `${CLAUDE_PLUGIN_ROOT}/skills/using-horspowers/scripts/route-request.mjs` |
| Codex macOS/Linux | `$HOME/.agents/skills/horspowers/using-horspowers/scripts/route-request.mjs` |
| Codex Windows PowerShell | `$env:USERPROFILE\.agents\skills\horspowers\using-horspowers\scripts\route-request.mjs` |

Codex 的 symlink、junction 和复制安装都以 native discovery 目录为入口。未知宿主若无法从 native metadata 解析路径，跳过脚本，回退 LLM 路由，且不做任何初始化写入。

所有示例都把宿主安全序列化的 JSON 放入 stdin；绝不把用户消息插入 command string。

```bash
# Claude Code
printf '%s' "$HORSPOWERS_ROUTER_INPUT" | \
  node "${CLAUDE_PLUGIN_ROOT}/skills/using-horspowers/scripts/route-request.mjs"

# Codex macOS/Linux
printf '%s' "$HORSPOWERS_ROUTER_INPUT" | \
  node "$HOME/.agents/skills/horspowers/using-horspowers/scripts/route-request.mjs"
```

```powershell
# Codex Windows PowerShell
$env:HORSPOWERS_ROUTER_INPUT |
  node "$env:USERPROFILE\.agents\skills\horspowers\using-horspowers\scripts\route-request.mjs"
```
