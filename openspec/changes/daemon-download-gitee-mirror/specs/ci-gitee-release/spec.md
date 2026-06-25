## ADDED Requirements

### Requirement: CI 自动创建 Gitee Release

`.github/workflows/release.yml` 在创建 GitHub Release 并上传二进制资产后，SHALL 自动在 Gitee（`muwb123/pocketctl`）创建对应的 Release。

#### Scenario: GitHub Release 创建成功后触发 Gitee Release

- **WHEN** GitHub Actions 成功创建 GitHub Release（`release.yml` 的 `upload-release-assets` 步骤完成）
- **THEN** 系统通过 Gitee API 创建同名 Release（使用同一个 tag，如 `v0.2.12`）
- **AND** Release body 包含版本号和 GitHub Release 链接

#### Scenario: Gitee Release 已存在时更新

- **WHEN** 目标 tag 的 Gitee Release 已存在（如同一 commit 重新运行 CI）
- **THEN** 系统先删除旧 Release 及所有旧资产，再创建新 Release
- **OR** 如果 Gitee API 不支持删除已有 Release，则更新 body 并追加新资产

### Requirement: CI 自动上传二进制到 Gitee Release

CI SHALL 将构建产出的 4 个平台二进制（`pocketctl_darwin_amd64`、`pocketctl_darwin_arm64`、`pocketctl_linux_amd64`、`pocketctl_linux_arm64`）及对应 4 个 `.sha256` 文件，上传到 Gitee Release 作为附件。

#### Scenario: 上传统计

- **WHEN** CI 完成全平台构建
- **THEN** 向 Gitee Release 上传 **8 个文件**（4 二进制 + 4 SHA256）
- **AND** 所有文件可在 Gitee Release 页面直接查看或下载

#### Scenario: Gitee 上传失败不阻塞

- **WHEN** Gitee API 上传失败（token 无效、网络问题、API 限流）
- **THEN** CI SHALL 记录警告日志但**不使 workflow 失败**
- **AND** GitHub Release 发布不受影响
- **AND** 用户可以通过 `daemon update` 的 GitHub fallback 正常下载

### Requirement: GITEE_TOKEN 安全配置

`GITEE_TOKEN` SHALL 作为 GitHub Actions secret 存储，CI 通过 `${{ secrets.GITEE_TOKEN }}` 引用。Token SHALL 具有 Gitee API 的 `releases` 写入权限。

#### Scenario: Token 存在时正常上传

- **WHEN** `GITEE_TOKEN` secret 已配置且有效
- **THEN** CI 通过 Authorization header 调用 Gitee API 上传资产

#### Scenario: Token 未配置时跳过

- **WHEN** `GITEE_TOKEN` secret 未配置（新建仓库或 fork）
- **THEN** Gitee 上传步骤 SHALL 跳过并记录提示日志
- **AND** CI workflow 不报错
