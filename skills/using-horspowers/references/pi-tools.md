# Pi 工具名映射

Horspowers 技能沿用 Claude Code 的工具名。在 Pi 下运行时按下表映射；`Read`/`Write`/`Edit`/`Bash` 与 Pi 同名，无需映射。

| 技能里写的 | Pi 对应 |
|---|---|
| `Task` tool（派发子代理） | `subagent` |
| 多个 `Task` 调用 | 多个 `subagent` 调用，或一个 workflow 批量派发 |
| 等待子任务结果 | 子代理的返回值；异步任务等完成通知 |
| `TodoWrite` | `todo` |
| `Skill` tool | Pi 的原生技能加载（`/skill:<name>`，或按 description 匹配） |
| `Read` / `Write` / `Edit` / `Bash` | 同名工具 |
| MCP 工具 | `mcp__<server>__<tool>`；HPS 为 `mcp__hps__*` |

## 子代理派发

1. 用 `subagent` 派发，任务正文即技能给出的 prompt 全文（占位符已填好）。
2. 只把必要上下文交给子代理；有多个互不依赖的任务时一次说明清楚。
3. 需要结果才能继续时等待返回；不需要时不要阻塞父会话。
4. 子代理不可用时按技能文本的兜底自审，并明确说明该限制。

## 命名代理类型

技能里的 `horspowers:code-reviewer` 这类名字 Pi 不解析。做法：定位技能引用的 prompt 文件 → 填好占位符 → 作为 `subagent` 的任务正文派发。

## 上下文与发现

- Pi 无 SessionStart hook；会话级说明由项目或用户 `AGENTS.md` 提供，Horspowers 不代写。
- 路径解析见 `references/host-path-resolution.md`；不得扫描用户目录或猜路径。
- HPS 需要先注册 `hps serve --stdio`（`docs/README.pi.md`）；未注册时走一次性 `hps call`，并按 `SKILL.md` 的「执行通道」分流 —— 必需 `scope_id` 的 operation 不能跨 `hps call` 进程调用。
