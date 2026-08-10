---
name: upgrade
description: Use when user invokes /upgrade command or needs to upgrade from old horspowers versions - detects and migrates old version content
---

# Horspowers Version Upgrade

**开始时声明：**“正在运行 Horspowers 版本升级助手。”

## 运行方式

从 Horspowers 安装根运行：

```bash
node lib/version-upgrade.js
```

可选参数：`--skip-ddaw`、`--skip-docs`、`--quiet`。

## 最前置项目身份保护

脚本在读取版本标记、检查旧目录、读取本地配置或生成迁移计划前，先进行只读 Git project identity 判断。

- `external_project_upgrade_disabled`：这是已识别的公司项目。不会写 `.horspowers-version`，不会移动、复制或改写旧文档，也不会调用本地文档迁移。提示用户先完成**外置配置注册**；外置升级迁移协议尚未设计，必须阻断。
- `ambiguous_project_upgrade_disabled`：多个公司 remote 身份不一致。升级不做任何项目写入，先消除歧义。
- `no_remote_project_upgrade_disabled`：项目没有可确认的 remote。升级不做任何项目写入，先建立受信任身份。
- `project_identity_unavailable`：身份读取失败时 fail closed，不做任何项目写入。

上述状态都带有 `no_mutation: true`；不要将其描述为升级成功或本地迁移完成。普通外部 Git 项目仍保持既有升级行为。

## 普通项目升级

仅当脚本返回可执行状态时，才可能检测旧安装、征得用户确认并迁移旧文档。任何会移动或清理的步骤仍须得到用户明确授权。完成后准确汇报变更、验证结果、风险与可恢复位置。
