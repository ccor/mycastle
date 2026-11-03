# docs 索引

> `docs/` 下所有文档的导航。新增文档时在本索引登记一行。

## repos/ — 仓库清单

<!-- 在此登记你的仓库清单文档，例如：
- [repos-remote.md](repos/repos-remote.md) — 远端仓库清单
- [repos-local.md](repos/repos-local.md) — 本地已克隆仓库索引
-->

## setup/ — 安装与凭据配置

<!-- 在此登记你的安装/凭据文档，例如：
- [ali-devops-cli.md](setup/ali-devops-cli.md) — 云效 CLI 配置
-->

## projects/ — 项目文档

按项目分子目录存放（`docs/projects/<项目>/…`）。

## 工具用法

mycastle 工具的权威用法文档随 npm 包分发，永远与已安装版本一致，不随工作区保存：`mycastle docs <tool>` 打印全文，`mycastle docs <tool> --schema` 只看配置字段说明。本机使用心得建议记到 `docs/notes/`（含敏感信息则不要提交），登记在本索引。

## 约定

- 文件名用 kebab-case；按类别建子目录。
- 新增 / 移动文档后，同步更新本索引。
