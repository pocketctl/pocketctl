## Why

项目需要将 Relay、Web、Daemon 代码公开发布到 GitHub，建立开源社区形象并实现二进制分发（GitHub Releases）。当前代码包含硬编码的服务器 IP、API 密钥、数据库密码等敏感信息，且所有代码（包括 iOS 私有代码和部署配置）都在同一个仓库中，无法安全公开。需要在保持 Gitee 全量代码 + Webhook 自动部署流程不变的前提下，实现向 GitHub 安全同步和 Release 分发。

## What Changes

- **重构 `--prod` 配置化**：删除 `main.go` 中 6 处硬编码 IP `39.106.218.47`，改为从 `~/.pocketctl/auth.json` 读取 `prod_relay_url`，安装脚本 `--prod` 时写入配置
- **删除敏感 fallback 值**：`relay/src/config/sms.ts` 的短信模板 ID、`relay/src/auth.ts` 的 JWT 密钥、`relay/src/server.ts` 的测试手机号/验证码 — 改为纯环境变量驱动，不设则启动报错
- **加固 .gitignore**：将 `.env.prod` 等敏感文件从 git 跟踪中移除
- **创建 GitHub 同步脚本**：白名单方式将指定目录同步到独立 GitHub 仓库 `pocketctl/pocketctl`
- **编写英文 README**：面向开源社区的英文项目介绍
- **添加 MIT LICENSE**
- **调整 Makefile release 命令**：tag 推送到 `github` remote 触发 GitHub Actions
- **首次 Release v0.1.0**：验证 GitHub Actions 构建和安装流程

## Capabilities

### New Capabilities
- `relay-url-config`: `--prod` relay URL 配置化，从硬编码改为配置文件驱动，支持 CLI 参数/环境变量/config 文件/默认值四级优先级
- `github-sync`: GitHub 仓库同步机制，包括白名单过滤、sync 脚本、英文 README 自动化
- `sensitive-data-cleanup`: 敏感数据清理规范，删除所有 fallback 默认值和硬编码凭据

### Modified Capabilities
（无现有 spec 需要修改）

## Impact

- **Go Daemon**: `cmd/pocketctl/main.go`、`internal/config/config.go` — relay URL 解析逻辑重构
- **Relay Server**: `relay/src/config/sms.ts`、`relay/src/auth.ts`、`relay/src/server.ts` — 删除 fallback 值
- **安装脚本**: `scripts/install-daemon.sh` — `--prod` 改为写入 config
- **构建系统**: `Makefile` — release 命令推送到 github remote
- **Git 配置**: `.gitignore` — 追加 `.env.prod` 等条目，`git rm --cached .env.prod`
- **Gitee 部署流程**: 不受影响，`deploy.sh` 和 `.env.prod`（服务器上已有文件）保持正常工作
