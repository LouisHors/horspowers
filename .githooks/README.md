# Git Hooks for Horspowers

这些 hooks 用于防止意外向上游 (obra/superpowers) 推送代码，确保 PR 只创建到 fork 的 origin。

## 功能

- **pre-push**: 阻止向 upstream 推送，检测 remote 名称或 URL 中的 `obra/superpowers`
- **ensure-gh-default-origin.sh**: 确保 `gh` CLI 使用 origin 作为默认仓库
- **post-checkout/post-commit/post-merge**: 自动修正 `gh` 默认仓库设置

## 安装

### 方法 1: 设置 core.hooksPath（推荐）

在仓库根目录执行：

```bash
git config core.hooksPath .githooks
```

这会将所有 git hook 操作指向 `.githooks/` 目录。

### 方法 2: 手动安装

复制到 `.git/hooks/`：

```bash
cp .githooks/* .git/hooks/
chmod +x .git/hooks/pre-push
chmod +x .git/hooks/post-*
```

## 验证

安装后，尝试向上游推送应该会被阻止：

```bash
git push upstream main
# [horspowers git hook] Push to upstream is blocked for this repository.
```

## 为什么需要这些 hooks？

Horspowers 是从 obra/superpowers fork 出来的项目，两者已经显著分歧。向 upstream 创建 PR 没有意义，因此需要防止意外操作。
