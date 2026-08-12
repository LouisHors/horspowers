# 配置与文档初始化参考

统一路由器只对**缺少** `.horspowers-config.yaml` 的合格项目自动初始化。它使用原子 `wx` 创建团队配置：

```yaml
development_mode: team
branch_strategy: worktree
testing_strategy: tdd
completion_strategy: pr
documentation:
  enabled: true
```

实际文件还包含当前 `CONFIG_VERSION` 与生成注释。创建竞争中已有文件优先，路由器绝不覆盖它。

## 已有配置的处理

| 状态 | 路由器行为 | 后续动作 |
|---|---|---|
| `valid` 且 docs 启用 | 保持字节不变；仅补齐缺失的通用目录 | 无需提示 |
| `valid` 且 docs 禁用 | 保持字节不变，不创建 docs | 按用户请求再启用 |
| `needs_migration` | 不写新配置、不建 docs | 说明旧 `.superpowers-config.yaml`，获确认后调用迁移 API |
| `needs_update` | 不改配置、不建 docs | 展示过期/缺字段原因，获确认后调用更新 API |
| `invalid` | 不覆盖、不建 docs | 展示验证错误，请用户修复或明确选择后续操作 |

通用 docs 初始化只创建缺少的 `docs/`、`plans/`、`active/`、`archive/`、`context/`、`.docs-metadata/` 和不存在的 `index.json`。它不构造 `UnifiedDocsManager`，因此不会重写现有 index 或 Markdown。

自动初始化只允许在已确认普通（非公司、非歧义）remote 的 Git 项目根，或该 Git 根内由 `.horspowers-project-root` 标记指定的嵌套根。标记不能授权非 Git 路径自动初始化，搜索也不得越过已确认的 Git 根；这样可避免在公司项目或未知路径发生本地写入。文件系统根、用户根、系统临时目录、Wiki-native 项目、`.horspowers-no-auto-init` 项目和不可写目录一律跳过。

当路由器返回 `explicit_action_required`、`failed` 或 `PLAN_FAILED` 时，不得把它说成初始化完成。
