## ADDED Requirements

### Requirement: 白名单同步脚本
SHALL 提供 `scripts/sync-github.sh` 脚本，使用白名单方式将指定目录从 Gitee 仓库同步到 GitHub 仓库。

#### Scenario: 执行同步脚本
- **WHEN** 运行 `bash scripts/sync-github.sh`
- **THEN** 脚本将白名单目录（cmd/、internal/、relay/、web/、go.mod、go.sum、Makefile、.github/、scripts/install-daemon.sh、tap/）同步到本地 GitHub 仓库副本目录
- **AND** 自动 git add、commit、push 到 `github` remote

#### Scenario: 不同步排除目录
- **WHEN** 运行同步脚本
- **THEN** 以下目录/文件 SHALL NOT 出现在 GitHub 仓库中：ios/、deploy/、nginx/、.env.prod、docker-compose.prod.yml、scripts/deploy.sh、scripts/deploy-webhook.js、scripts/ios-*.sh

### Requirement: 英文 README
GitHub 仓库 SHALL 包含一份面向开源社区的英文 README.md，包含项目介绍、功能特性、安装方式、快速开始指南。

#### Scenario: GitHub 仓库首页展示英文 README
- **WHEN** 访问 github.com/pocketctl/pocketctl
- **THEN** 首页显示英文 README，包含安装命令和基本用法

### Requirement: MIT LICENSE
GitHub 仓库 SHALL 包含 MIT License 文件。

#### Scenario: GitHub 仓库显示许可证
- **WHEN** 访问 github.com/pocketctl/pocketctl
- **THEN** 仓库显示 MIT License

### Requirement: Makefile release 推送到 GitHub
`make release` 命令 SHALL 将 git tag 推送到 `github` remote 以触发 GitHub Actions 构建。

#### Scenario: 执行 make release
- **WHEN** 运行 `make release VERSION=v0.1.0`
- **THEN** 创建 git tag 并 `git push github v0.1.0`

### Requirement: 同步后敏感信息验证
同步脚本 SHALL 在推送前自动扫描 GitHub 仓库副本，验证不包含敏感信息。

#### Scenario: 推送前安全扫描
- **WHEN** 同步脚本执行
- **THEN** 自动 grep 检查 GitHub 仓库副本中不包含 IP 地址模式、API Key 模式、密码模式
- **AND** 如果发现敏感信息则中止推送并报告
