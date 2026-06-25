## Why

`pocketctl daemon update` 和 `install.sh` 的二进制下载目前**只从 GitHub Releases 下载**（`github.com/pocketctl/pocketctl/releases/download/...`）。GitHub 在国内访问速度慢、偶尔不可达，导致国内用户无法正常完成 daemon 安装和更新。Gitee（gitee.com/muwb123/pocketctl）是国内代码托管平台，下载速度稳定且已有 tag 同步，但缺少 release 二进制资产和对应的下载源代码支持。

## What Changes

- **daemon update 多源下载**：`internal/update/updater.go` 的 `CheckLatest`、`CheckVersion`、`ResolveBinary` 增加 Gitee 作为主源，GitHub 作为 fallback。版本查询优先 Gitee API，下载 URL 优先 Gitee Release，失败时自动降级 GitHub
- **install.sh 增加 Gitee 源**：安装脚本优先从 Gitee Release 下载二进制，失败时降级 GitHub
- **CI 自动推送 Gitee Release**：`.github/workflows/release.yml` 新增步骤——GitHub Release 创建后，自动上传二进制 + .sha256 到 Gitee Release（需要 `GITEE_TOKEN` secret）
- **无 BREAKING 变更**：所有改动为纯新增能力，Gitee 不可用时自动 fallback GitHub，对现有用户零影响

## Capabilities

### New Capabilities
- `daemon-gitee-download`: daemon update 和 install.sh 从 Gitee Release 下载二进制（优先），失败时 fallback GitHub
- `ci-gitee-release`: CI 在 GitHub Release 创建后自动推送二进制 + SHA256 到 Gitee Release

### Modified Capabilities
<!-- No existing capability requirements are changing -->

## Impact

| 文件 | 改动类型 | 说明 |
|---|---|---|
| `internal/update/updater.go` | 修改 | `CheckLatest` / `CheckVersion` / `ResolveBinary` 改为多源（Gitee 优先，GitHub fallback） |
| `nginx/html/install.sh` | 修改 | `LATEST_URL` 增加 Gitee 源，curl/wget 失败时尝试 GitHub |
| `.github/workflows/release.yml` | 修改 | 新增 Gitee Release 上传步骤（需 `GITEE_TOKEN`） |
| `openspec/specs/daemon-gitee-download/spec.md` | 新建 | daemon 下载源规格 |
| `openspec/specs/ci-gitee-release/spec.md` | 新建 | CI 发布规格 |
